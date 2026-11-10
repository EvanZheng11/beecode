//! 远程运行的持久化与白名单协议边界。不保存 token，不把远端会话当成本机子会话。
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};

use super::types::{
    delegation_target_from_args, remote_permissions_from_args, BlockedKind, BlockedOn,
    DelegationRequest, DelegationTarget, DelegationTaskReport, RemoteDelegationTarget,
    RemoteTarget, RemoteTaskInfo, TaskStatus,
};
use crate::app_error::AppCommandError;
use crate::cli_run::{wire, PermissionPolicy};
use crate::db::entities::remote_delegation::Model;
use crate::db::service::{
    remote_delegation_service as store, remote_mention_grant_service as grants,
    remote_workspace_connection_service as connections,
};
use crate::db::AppDatabase;

pub type RemoteError = (String, String);

/// 连续失败窗口；成功后重置。与真实 HTTP 解耦以验证十分钟非终态边界。
pub struct RetryWindow {
    since: Option<Instant>,
    delay_secs: u64,
}
impl Default for RetryWindow {
    fn default() -> Self {
        Self::new()
    }
}
impl RetryWindow {
    pub fn new() -> Self {
        Self {
            since: None,
            delay_secs: 1,
        }
    }
    pub fn reset(&mut self) {
        *self = Self::new();
    }
    pub fn failure(&mut self, now: Instant) -> Option<Duration> {
        let since = *self.since.get_or_insert(now);
        if now.duration_since(since) >= Duration::from_secs(600) {
            return None;
        }
        let delay = Duration::from_secs(self.delay_secs);
        self.delay_secs = (self.delay_secs * 2).min(30);
        Some(delay)
    }
}

type FolderCache = HashMap<String, (Instant, Vec<(i32, String)>)>;

/// 每连接最多八条运行链；许可从 reserve 前一直持有到停止跟踪。
pub struct RemoteRunTracker {
    pub db: Arc<AppDatabase>,
    folders: Mutex<FolderCache>,
    slots: Mutex<HashMap<i32, Arc<Semaphore>>>,
    gates: Mutex<HashMap<i32, Arc<Mutex<bool>>>>,
    recovery_cutoff: chrono::DateTime<chrono::Utc>,
}

impl RemoteRunTracker {
    pub fn new(db: Arc<AppDatabase>) -> Self {
        Self {
            db,
            folders: Mutex::new(HashMap::new()),
            slots: Mutex::new(HashMap::new()),
            gates: Mutex::new(HashMap::new()),
            recovery_cutoff: chrono::Utc::now(),
        }
    }

    pub fn existed_at_startup(&self, row: &Model) -> bool {
        row.created_at <= self.recovery_cutoff
    }

    /// 与删除连接共用闸门。true 表示已开始删除，此后排队的 start 也不能发送。
    pub async fn gate(&self, connection_id: i32) -> Arc<Mutex<bool>> {
        self.gates
            .lock()
            .await
            .entry(connection_id)
            .or_insert_with(|| Arc::new(Mutex::new(false)))
            .clone()
    }

    pub async fn acquire(&self, connection_id: i32) -> OwnedSemaphorePermit {
        let semaphore = self
            .slots
            .lock()
            .await
            .entry(connection_id)
            .or_insert_with(|| Arc::new(Semaphore::new(8)))
            .clone();
        semaphore
            .acquire_owned()
            .await
            .expect("远程任务信号量不会关闭")
    }

    pub async fn prepare(
        &self,
        parent: i32,
        input: &Value,
    ) -> Result<RemoteDelegationTarget, RemoteError> {
        // 即使为空也拒绝路径参数，不能让远程分支悄悄继承本机路径。
        if input.get("working_dir").is_some() {
            return Err(err(
                "invalid_remote_target",
                "远程委派只能指定已登记的 remote_folder_id，不能指定 working_dir",
            ));
        }
        let parsed = delegation_target_from_args(input)
            .map_err(|e| err(e.code(), "远程委派目标无效或混用了本机参数"))?;
        let DelegationTarget::Remote {
            connection_id,
            folder_id,
            target,
        } = parsed
        else {
            return Err(err("invalid_remote_target", "缺少远程目标"));
        };
        // 默认拒绝；授权失败或数据库故障均不能放行。
        if !grants::is_granted(&self.db.conn, parent, connection_id, folder_id)
            .await
            .map_err(db_error)?
        {
            return Err(err(
                "remote_not_mentioned",
                "该远程项目未在当前父会话中被用户引用",
            ));
        }
        let permissions = remote_permissions_from_args(input)
            .map_err(|e| err(e.code(), "远程权限策略无效"))?
            .unwrap_or(PermissionPolicy::Wait);
        let workspace = self.workspace(connection_id, folder_id).await?;
        Ok(RemoteDelegationTarget {
            connection_id,
            folder_id,
            workspace,
            target,
            permissions,
        })
    }

    async fn workspace(&self, connection: i32, folder: i32) -> Result<String, RemoteError> {
        // 地址/token/headers 修改后不能沿用旧机器的项目授权路径缓存。
        let key = crate::remote_gateway::connection_key(&self.db, connection)
            .await
            .map_err(gateway_error)?;
        let cached = self.folders.lock().await.get(&key).cloned();
        if let Some((at, folders)) = cached {
            if at.elapsed() < Duration::from_secs(60) {
                if let Some((_, path)) = folders.iter().find(|(id, _)| *id == folder) {
                    return Ok(path.clone());
                }
            }
        }
        // 过期或未命中只刷新一次；必须来自远端已登记项目列表。
        let value: Value = self
            .call(connection, "list_all_folder_details", json!({}))
            .await?;
        let rows = value
            .as_array()
            .ok_or_else(|| err("remote_protocol_error", "远程项目列表格式无效"))?;
        let folders: Vec<_> = rows
            .iter()
            .filter_map(|v| {
                Some((
                    i32::try_from(v.get("id")?.as_i64()?).ok()?,
                    v.get("path")?.as_str()?.to_string(),
                ))
            })
            .filter(|(id, path)| *id > 0 && !path.is_empty())
            .collect();
        let result = folders
            .iter()
            .find(|(id, _)| *id == folder)
            .map(|(_, path)| path.clone());
        self.folders
            .lock()
            .await
            .insert(key, (Instant::now(), folders));
        result.ok_or_else(|| err("remote_folder_not_found", "远程项目未登记或已经删除"))
    }

    pub async fn create(
        &self,
        task_id: &str,
        req: &DelegationRequest,
    ) -> Result<Model, RemoteError> {
        let target = req
            .remote
            .as_ref()
            .ok_or_else(|| err("invalid_remote_target", "缺少远程目标"))?;
        // 内部调用也重新校验授权和目录，不信任反序列化请求里的 workspace。
        if !grants::is_granted(
            &self.db.conn,
            req.parent_conversation_id,
            target.connection_id,
            target.folder_id,
        )
        .await
        .map_err(db_error)?
        {
            return Err(err("remote_not_mentioned", "该远程项目未获授权"));
        }
        if self
            .workspace(target.connection_id, target.folder_id)
            .await?
            != target.workspace
        {
            return Err(err(
                "remote_folder_changed",
                "远程项目路径已变化，请重新委派",
            ));
        }
        let connection = connections::get(&self.db.conn, target.connection_id)
            .await
            .map_err(db_error)?
            .ok_or_else(|| err("remote_connection_not_found", "远程连接不存在"))?;
        let (kind, reference) = match &target.target {
            RemoteTarget::Assistant(id) => ("assistant", id.to_string()),
            RemoteTarget::Agent(slug) => ("agent", slug.clone()),
        };
        store::create_reserving(
            &self.db.conn,
            &store::NewRemoteDelegation {
                task_id: task_id.into(),
                connection_id: target.connection_id,
                parent_conversation_id: req.parent_conversation_id,
                parent_tool_use_id: req.parent_tool_use_id.clone(),
                connection_name: connection.name,
                remote_folder_id: target.folder_id,
                remote_workspace: target.workspace.clone(),
                target_kind: kind.into(),
                target_ref: reference.clone(),
                target_label: reference,
                permissions: serde_json::to_value(target.permissions)
                    .unwrap_or(json!("wait"))
                    .as_str()
                    .unwrap_or("wait")
                    .into(),
                task_preview: req.task.chars().take(500).collect(),
            },
        )
        .await
        .map_err(db_error)
    }

    pub async fn reserve(&self, row: &Model) -> Result<String, RemoteError> {
        let id = connection_id(row)?;
        let caps = crate::remote_gateway::hello(&self.db, id)
            .await
            .map_err(gateway_error)?;
        if !caps.capabilities.iter().any(|c| c == "run") {
            return Err(err("remote_run_unsupported", "远程端不支持 run 能力"));
        }
        let response: wire::ReserveResponse = self.call(id, "cli_run_reserve", json!({})).await?;
        if response.run_id.len() < 8 {
            return Err(err("remote_protocol_error", "远程 run_id 无效"));
        }
        match store::update_run_id(&self.db.conn, &row.task_id, &response.run_id).await {
            Ok(true) => Ok(response.run_id),
            result => {
                // reserve 成功但本机落库失败时，不能遗留无法恢复的预留。
                let _ = self.cancel_run(id, &response.run_id, "interrupt").await;
                result.map_err(db_error)?;
                Err(err("canceled", "任务已结算"))
            }
        }
    }

    pub async fn start(
        &self,
        row: &Model,
        req: &DelegationRequest,
        run_id: &str,
        worktree: bool,
    ) -> Result<wire::StartResponse, RemoteError> {
        let target = req.remote.as_ref().expect("远程分支已校验目标");
        let mut args = json!({"runId": run_id, "workspace": target.workspace,
            "prompt": [{"type":"text", "text":req.task}], "permissions": target.permissions,
            "title": format!("[来自本机] {}", req.task.lines().next().unwrap_or("").chars().take(160).collect::<String>()),
            "timeoutMs": 7_200_000_u64});
        match &target.target {
            RemoteTarget::Assistant(id) => {
                args["assistant"] = json!(id.to_string());
            }
            RemoteTarget::Agent(slug) => {
                args["agent"] = json!(slug);
            }
        }
        if worktree {
            args["worktree"] = json!("");
        }
        self.call(connection_id(row)?, "cli_run_start", args).await
    }

    pub async fn mark_started(
        &self,
        task_id: &str,
        response: &wire::StartResponse,
    ) -> Result<(), RemoteError> {
        if !store::mark_started(
            &self.db.conn,
            task_id,
            &store::StartedRemoteDelegation {
                remote_conversation_id: Some(response.conversation_id),
                remote_link: Some(response.link.clone()),
                remote_worktree: response
                    .worktree
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()
                    .map_err(|_| err("remote_protocol_error", "远程 worktree 格式无效"))?,
            },
        )
        .await
        .map_err(db_error)?
        {
            return Err(err("canceled", "任务已结算"));
        }
        Ok(())
    }

    pub async fn row(&self, task_id: &str) -> Result<Option<Model>, RemoteError> {
        store::get_by_task_id(&self.db.conn, task_id)
            .await
            .map_err(db_error)
    }

    pub async fn call<T: DeserializeOwned>(
        &self,
        id: i32,
        route: &str,
        args: Value,
    ) -> Result<T, RemoteError> {
        let value =
            crate::remote_gateway::call_allowed(&self.db, id, route, Some(args), Some(30_000))
                .await
                .map_err(gateway_error)?;
        serde_json::from_value(value).map_err(|_| err("remote_protocol_error", "远程响应格式无效"))
    }

    pub async fn get(&self, row: &Model) -> Result<wire::GetResponse, RemoteError> {
        self.call(
            connection_id(row)?,
            "cli_run_get",
            json!({"runId":row.run_id}),
        )
        .await
    }

    pub async fn events(&self, row: &Model) -> Result<wire::EventsResponse, RemoteError> {
        self.call(
            connection_id(row)?,
            "cli_run_events",
            json!({"runId":row.run_id,
            "after":row.last_event_seq, "waitMs":20_000}),
        )
        .await
    }

    /// not_found 不能立即判丢失；只接受完整 run_id 相同的 find 结果，避免前缀碰撞串任务。
    pub async fn find(&self, row: &Model) -> Result<bool, RemoteError> {
        let run_id = row
            .run_id
            .as_deref()
            .ok_or_else(|| err("remote_run_lost", "缺少远程运行标识"))?;
        let found: wire::FindResponse = self
            .call(
                connection_id(row)?,
                "cli_run_find",
                json!({"prefix":run_id.chars().take(8).collect::<String>()}),
            )
            .await?;
        Ok(found.runs.iter().any(|r| r.run_id == run_id))
    }

    pub async fn progress(
        &self,
        row: &Model,
        status: &str,
        blocked: Option<&str>,
        cursor: i64,
    ) -> Result<bool, RemoteError> {
        store::update_progress(&self.db.conn, &row.task_id, status, blocked, cursor)
            .await
            .map_err(db_error)
    }

    pub async fn settle(
        &self,
        row: &Model,
        status: &str,
        update: store::TerminalUpdate,
    ) -> Result<bool, RemoteError> {
        store::settle(&self.db.conn, &row.task_id, status, &update)
            .await
            .map_err(db_error)
    }

    pub async fn fail(&self, row: &Model, code: &str, message: &str) -> Result<bool, RemoteError> {
        self.settle(
            row,
            "failed",
            store::TerminalUpdate {
                error_code: Some(code.into()),
                error_message: Some(message.into()),
                last_event_seq: row.last_event_seq,
                ..Default::default()
            },
        )
        .await
    }

    pub async fn cancel_run(
        &self,
        connection: i32,
        run: &str,
        reason: &str,
    ) -> Result<(), RemoteError> {
        let _: Value = self
            .call(
                connection,
                "cli_run_cancel",
                json!({"runId":run,"reason":reason}),
            )
            .await?;
        Ok(())
    }

    pub async fn cancel(&self, row: &Model, reason: &str) -> Result<bool, RemoteError> {
        // 先占终态，迟到的 result 不能覆盖用户取消；远端是否确认单独记录。
        // DB 服务先到者胜出，因此 HTTP 前后的结算在 broker 的终态锁下串行。
        let confirmed = match (row.connection_id, row.run_id.as_deref()) {
            (Some(connection), Some(run)) => self.cancel_run(connection, run, reason).await.is_ok(),
            (_, None) => true,
            _ => false,
        };
        self.settle(
            row,
            "canceled",
            store::TerminalUpdate {
                error_code: Some(
                    if confirmed {
                        "canceled"
                    } else {
                        "remote_cancel_unconfirmed"
                    }
                    .into(),
                ),
                error_message: Some(
                    if confirmed {
                        "远程任务已取消"
                    } else {
                        "取消未获远程确认，远程可能仍在运行"
                    }
                    .into(),
                ),
                last_event_seq: row.last_event_seq,
                ..Default::default()
            },
        )
        .await
    }
}

pub fn connection_id(row: &Model) -> Result<i32, RemoteError> {
    row.connection_id
        .ok_or_else(|| err("remote_connection_deleted", "远程连接已删除"))
}

pub fn info(row: &Model) -> RemoteTaskInfo {
    RemoteTaskInfo {
        connection_id: row.connection_id.unwrap_or(0),
        connection_name: row.connection_name.clone(),
        run_id: row.run_id.clone().unwrap_or_default(),
        conversation_id: row.remote_conversation_id,
        link: row.remote_link.clone(),
        worktree: row
            .remote_worktree
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok()),
    }
}

pub fn report(row: &Model) -> DelegationTaskReport {
    let blocked = match row.status.as_str() {
        "unreachable" => Some("remote_unreachable"),
        "blocked" => row.blocked_on.as_deref(),
        _ => None,
    };
    DelegationTaskReport {
        task_id: Some(row.task_id.clone()),
        status: match row.status.as_str() {
            "completed" => TaskStatus::Completed,
            "failed" => TaskStatus::Failed,
            "canceled" => TaskStatus::Canceled,
            _ => TaskStatus::Running,
        },
        child_conversation_id: None,
        agent_type: None,
        text: row.result_text.clone(),
        error_code: row.error_code.clone(),
        message: row
            .error_message
            .clone()
            .or_else(|| blocked.map(|_| "请去远程界面处理".into())),
        duration_ms: row.duration_ms.and_then(|d| u64::try_from(d).ok()),
        blocked_on: blocked.map(|kind| BlockedOn {
            kind: if kind == "question" {
                BlockedKind::Question
            } else {
                BlockedKind::Permission
            },
            request_id: format!("remote:{kind}:{}", row.last_event_seq),
            title: Some(if kind == "remote_unreachable" {
                "remote_unreachable：远程连续十分钟不可达，请重新同步或取消".into()
            } else {
                "请去远程界面处理请求".into()
            }),
        }),
        assistant_id: None,
        assistant_name: None,
        progress: None,
        remote: Some(info(row)),
    }
}

pub fn result_update(
    result: &wire::RunResult,
    cursor: i64,
) -> (&'static str, store::TerminalUpdate) {
    let subtype = serde_json::to_value(result.subtype)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned));
    let canceled = matches!(
        subtype.as_deref(),
        Some("error_interrupted" | "error_timeout")
    );
    (
        if canceled {
            "canceled"
        } else if result.is_error {
            "failed"
        } else {
            "completed"
        },
        store::TerminalUpdate {
            result_text: result.result.clone(),
            result_subtype: subtype,
            error_code: result.error.as_ref().map(|e| e.code.clone()),
            error_message: result.error.as_ref().map(|e| e.message.clone()),
            duration_ms: Some(result.duration_ms.min(i64::MAX as u64) as i64),
            last_event_seq: cursor,
        },
    )
}

pub fn gateway_error(error: AppCommandError) -> RemoteError {
    let code = error
        .detail
        .as_deref()
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .and_then(|v| v.get("code").and_then(Value::as_str).map(str::to_owned))
        .filter(|code| {
            !code.is_empty()
                && code.len() <= 80
                && code.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        })
        .unwrap_or_else(|| "remote_unavailable".into());
    (code, error.message)
}
fn db_error(_: impl std::fmt::Display) -> RemoteError {
    err("remote_persistence_failed", "远程委派持久化失败")
}
pub fn err(code: &str, message: &str) -> RemoteError {
    (code.into(), message.into())
}
