//! 启动前目录信任：内存排队，显式人工决定，所有窗口与 Web 共用。
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tokio::sync::watch;

use crate::acp::error::AcpError;
use crate::commands::acp as config;
use crate::db::AppDatabase;
use crate::models::agent::AgentType;
use crate::web::event_bridge::{emit_event, EventEmitter};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTrustTarget {
    pub agent_type: String,
    pub workspace: String,
    pub resources: Vec<config::PiProjectResource>,
    pub warning: String,
    pub trust_file: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTrustRequest {
    pub request_id: String,
    pub targets: Vec<ProjectTrustTarget>,
    pub created_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTrustAgent {
    agent_type: &'static str,
    display_name: &'static str,
    description: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTrustBatchResult {
    pub workspace: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub fn agents() -> Vec<ProjectTrustAgent> {
    vec![
        ProjectTrustAgent {
            agent_type: "pi",
            display_name: "Pi",
            description:
                "目录及子目录；加载项目扩展、MCP、设置与技能，可能执行代码。历史允许也需人工确认。",
        },
        ProjectTrustAgent {
            agent_type: "gemini",
            display_name: "Gemini CLI",
            description:
                "原生 TRUST_FOLDER，包含子目录；加载项目设置、MCP 与指令。不会授权父目录。",
        },
    ]
}

fn supported(name: &str) -> Result<AgentType, AcpError> {
    match name {
        "pi" => Ok(AgentType::Pi),
        "gemini" => Ok(AgentType::Gemini),
        _ => Err(AcpError::protocol(
            "该智能体没有可安全批量写入的目录信任适配器",
        )),
    }
}

fn canonical_dir(path: &Path) -> Result<PathBuf, AcpError> {
    if !path.is_absolute() || !path.is_dir() {
        return Err(AcpError::protocol("信任目录必须是现存目录的绝对路径"));
    }
    std::fs::canonicalize(path)
        .map(|p| crate::paths::simplify_verbatim_path(&p))
        .map_err(|e| AcpError::protocol(format!("无法解析信任目录：{e}")))
}

fn read_object(path: &Path) -> Result<serde_json::Map<String, serde_json::Value>, AcpError> {
    read_object_with_comments(path, false)
}

fn read_object_with_comments(
    path: &Path,
    comments: bool,
) -> Result<serde_json::Map<String, serde_json::Value>, AcpError> {
    match std::fs::read_to_string(path) {
        Ok(text) => {
            let text = text.trim_start_matches('\u{feff}');
            let parsed = if comments {
                // Gemini 原生 strip-json-comments + JSON.parse，不接受 JSON5 或尾逗号。
                let options = jsonc_parser::ParseOptions {
                    allow_comments: true,
                    allow_loose_object_property_names: false,
                    allow_trailing_commas: false,
                    allow_missing_commas: false,
                    allow_single_quoted_strings: false,
                    allow_hexadecimal_numbers: false,
                    allow_unary_plus_numbers: false,
                    allow_bare_decimal_point_numbers: false,
                    allow_non_finite_numbers: false,
                    allow_extended_string_escapes: false,
                };
                jsonc_parser::parse_to_serde_value::<serde_json::Value>(text, &options).ok()
            } else {
                serde_json::from_str::<serde_json::Value>(text).ok()
            };
            parsed.and_then(|v| v.as_object().cloned()).ok_or_else(|| {
                AcpError::protocol(format!(
                    "信任配置不是有效 JSON 对象，未覆盖：{}",
                    path.display()
                ))
            })
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Default::default()),
        Err(e) => Err(AcpError::protocol(format!(
            "读取信任配置失败 {}：{e}",
            path.display()
        ))),
    }
}

fn write_object(
    path: &Path,
    map: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), AcpError> {
    use std::io::Write;
    let parent = path
        .parent()
        .ok_or_else(|| AcpError::protocol("信任配置缺少父目录"))?;
    std::fs::create_dir_all(parent)
        .map_err(|e| AcpError::protocol(format!("创建信任目录失败：{e}")))?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|e| AcpError::protocol(format!("创建信任临时文件失败：{e}")))?;
    serde_json::to_writer_pretty(&mut temp, map)
        .map_err(|e| AcpError::protocol(format!("写信任配置失败：{e}")))?;
    temp.flush()
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|e| AcpError::protocol(format!("同步信任配置失败：{e}")))?;
    temp.persist(path)
        .map_err(|e| AcpError::protocol(format!("替换信任配置失败：{e}")))?;
    Ok(())
}

fn env_value(env: &BTreeMap<String, String>, key: &str) -> Option<String> {
    env.get(key)
        .cloned()
        .or_else(|| std::env::var(key).ok())
        .filter(|s| !s.is_empty())
}

fn inspect_target(
    agent: AgentType,
    cwd: &Path,
    env: &BTreeMap<String, String>,
) -> Result<ProjectTrustTarget, AcpError> {
    let cwd = canonical_dir(cwd)?;
    let workspace = cwd.to_string_lossy().into_owned();
    match agent {
        AgentType::Pi => Ok(ProjectTrustTarget {
            agent_type: "pi".into(),
            workspace,
            resources: config::pi_project_trust_resources_with_home(&cwd, &config::pi_child_home(env)),
            warning: "允许后 Pi 将加载此目录及子目录的项目资源；扩展、设置和 MCP 可执行项目提供的代码。历史允许不代表已人工确认。".into(),
            trust_file: config::pi_agent_dir_in_workspace(env, &cwd).join("trust.json").to_string_lossy().into_owned(),
        }),
        AgentType::Gemini => {
            let home = env_value(env, "GEMINI_CLI_HOME")
                .map(PathBuf::from).unwrap_or_else(|| config::pi_child_home(env));
            let home = if home.is_absolute() { home } else { cwd.join(home) };
            let mut resources = Vec::new();
            // Gemini 可读取目录链上的项目设置/指令，展示实际存在的资源。
            for parent in cwd.ancestors() {
                for (name, executes_code) in [(".gemini/settings.json", true), (".gemini/extensions", true), (".gemini/commands", true), ("GEMINI.md", false)] {
                    let path = parent.join(name);
                    if path.exists() {
                        resources.push(config::PiProjectResource { path: path.to_string_lossy().into_owned(), kind: name.into(), executes_code });
                    }
                }
            }
            Ok(ProjectTrustTarget {
                agent_type: "gemini".into(), workspace, resources,
                warning: "允许后写入 Gemini 原生 TRUST_FOLDER，包含子目录；项目设置、MCP、扩展和命令可能执行代码，不会授权父目录。".into(),
                trust_file: home.join(".gemini/trustedFolders.json").to_string_lossy().into_owned(),
            })
        }
        _ => Err(AcpError::protocol("该智能体不支持目录信任预检")),
    }
}

fn decision(target: &ProjectTrustTarget) -> Result<Option<bool>, AcpError> {
    let file = Path::new(&target.trust_file);
    // 读取失败不能当作无决定，更不能覆盖原生配置。
    let map = read_object_with_comments(file, target.agent_type == "gemini")?;
    if target.agent_type == "pi" {
        return Ok(
            config::pi_nearest_trust_decision(file, Path::new(&target.workspace)).map(|(_, b)| b),
        );
    }
    let mut best: Option<(usize, bool)> = None;
    let cwd = Path::new(&target.workspace);
    for (path, value) in map {
        let level = value
            .as_str()
            .ok_or_else(|| AcpError::protocol("Gemini 信任配置包含无效级别"))?;
        let raw = Path::new(&path);
        let scope = match level {
            "TRUST_PARENT" => raw.parent().unwrap_or(raw),
            "TRUST_FOLDER" | "DO_NOT_TRUST" => raw,
            _ => return Err(AcpError::protocol("Gemini 信任配置包含未知级别")),
        };
        let scope = crate::paths::simplify_verbatim_path(
            &std::fs::canonicalize(scope).unwrap_or_else(|_| scope.into()),
        );
        if cwd.starts_with(scope) && best.is_none_or(|(len, _)| path.len() > len) {
            best = Some((path.len(), level != "DO_NOT_TRUST"));
        }
    }
    Ok(best.map(|(_, b)| b))
}

fn ack_key(target: &ProjectTrustTarget) -> String {
    // 同目录的不同自定义 profile 不共用授权确认。
    serde_json::to_string(&(&target.agent_type, &target.trust_file, &target.workspace)).unwrap()
}

struct Pending {
    request: ProjectTrustRequest,
    env: BTreeMap<String, String>,
    answer: watch::Sender<Option<bool>>,
    emitter: EventEmitter,
    resolving: bool,
}

pub struct ProjectTrustBroker {
    pending: Mutex<HashMap<String, Pending>>,
    writes: Mutex<()>,
    ack_file: PathBuf,
    timeout: Duration,
}

pub fn broker() -> &'static ProjectTrustBroker {
    static INSTANCE: OnceLock<ProjectTrustBroker> = OnceLock::new();
    INSTANCE.get_or_init(|| {
        ProjectTrustBroker::new(
            crate::paths::codeg_home_dir().join("project-trust-confirmations.json"),
            Duration::from_secs(600),
        )
    })
}

impl ProjectTrustBroker {
    fn new(ack_file: PathBuf, timeout: Duration) -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            writes: Mutex::new(()),
            ack_file,
            timeout,
        }
    }

    pub fn pending(&self) -> Vec<ProjectTrustRequest> {
        let mut requests: Vec<_> = self
            .pending
            .lock()
            .unwrap()
            .values()
            .map(|p| p.request.clone())
            .collect();
        requests.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        requests
    }

    fn needs_approval(&self, target: &ProjectTrustTarget) -> Result<bool, AcpError> {
        let verdict = decision(target)?;
        if target.agent_type == "pi" && target.resources.is_empty() {
            return Ok(false);
        }
        if verdict == Some(false) {
            return Err(AcpError::PiProjectTrustRequired(format!(
                "目录已被明确拒绝信任，请在设置中人工修改后重试：{}",
                target.workspace
            )));
        }
        let ack = read_object(&self.ack_file)?;
        // 人工授权保留原生目录及子目录范围；不同 profile 的确认不互相继承。
        let acknowledged = Path::new(&target.workspace)
            .ancestors()
            .find_map(|path| {
                let mut scope = target.clone();
                scope.workspace = path.to_string_lossy().into_owned();
                ack.get(&ack_key(&scope))
                    .and_then(serde_json::Value::as_bool)
            })
            .unwrap_or(false);
        Ok(verdict != Some(true) || !acknowledged)
    }

    pub fn verify_launch(
        &self,
        agent: AgentType,
        cwd: &Path,
        env: &BTreeMap<String, String>,
    ) -> Result<(), AcpError> {
        if matches!(agent, AgentType::Pi | AgentType::Gemini)
            && self.needs_approval(&inspect_target(agent, cwd, env)?)?
        {
            return Err(AcpError::PiProjectTrustRequired(
                "目录尚未人工确认或信任已被撤销，请重新运行".into(),
            ));
        }
        Ok(())
    }

    fn finish_matching(&self, target: &ProjectTrustTarget) {
        let mut pending = self.pending.lock().unwrap();
        let ids: Vec<_> = pending
            .iter()
            .filter(|(_, p)| {
                !p.resolving
                    && p.request.targets.iter().all(|t| {
                        t.agent_type == target.agent_type
                            && t.trust_file == target.trust_file
                            && Path::new(&t.workspace).starts_with(&target.workspace)
                            && self.needs_approval(t).is_ok_and(|needs| !needs)
                    })
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            if let Some(p) = pending.remove(&id) {
                let _ = p.answer.send(Some(true));
                emit_event(
                    &p.emitter,
                    "project-trust-resolved",
                    serde_json::json!({"requestId": id}),
                );
            }
        }
    }

    pub async fn before_launch(
        &self,
        agent: AgentType,
        cwd: &Path,
        env: &BTreeMap<String, String>,
        emitter: &EventEmitter,
    ) -> Result<(), AcpError> {
        if !matches!(agent, AgentType::Pi | AgentType::Gemini) {
            return Ok(());
        }
        if agent == AgentType::Gemini
            && (env_value(env, "GEMINI_RESTRICTED_MODE").as_deref() == Some("true")
                || env_value(env, "GEMINI_CLI_TRUST_WORKSPACE").as_deref() == Some("false"))
        {
            // 保留原生明确限制，不能用目录授权覆盖它。
            return Err(AcpError::PiProjectTrustRequired(
                "Gemini 环境明确禁止信任工作区，请先人工修改该设置".into(),
            ));
        }
        let target = inspect_target(agent, cwd, env)?;
        let (id, rx) = {
            // 与授权写入串行重检，避免上一请求刚完成又产生陈旧请求。
            let _writes = self.writes.lock().unwrap();
            if !self.needs_approval(&target)? {
                return Ok(());
            }
            let mut pending = self.pending.lock().unwrap();
            if let Some((id, p)) = pending
                .iter()
                .find(|(_, p)| p.request.targets == [target.clone()])
            {
                (id.clone(), p.answer.subscribe())
            } else {
                if pending.len() >= 256 {
                    return Err(AcpError::protocol("待确认目录过多，请先处理现有请求"));
                }
                let id = uuid::Uuid::new_v4().to_string();
                let request = ProjectTrustRequest {
                    request_id: id.clone(),
                    targets: vec![target],
                    created_at: chrono::Utc::now().to_rfc3339(),
                };
                let (answer, rx) = watch::channel(None);
                pending.insert(
                    id.clone(),
                    Pending {
                        request: request.clone(),
                        env: env.clone(),
                        answer,
                        emitter: emitter.clone(),
                        resolving: false,
                    },
                );
                emit_event(emitter, "project-trust-requested", &request);
                (id, rx)
            }
        };
        let mut waiter = TrustWaiter {
            broker: self,
            id,
            rx,
        };
        let approved = tokio::time::timeout(self.timeout, async {
            loop {
                if let Some(answer) = *waiter.rx.borrow_and_update() {
                    return Ok(answer);
                }
                waiter
                    .rx
                    .changed()
                    .await
                    .map_err(|_| AcpError::protocol("目录信任请求已取消"))?;
            }
        })
        .await
        .map_err(|_| {
            AcpError::PiProjectTrustRequired(
                "等待人工确认目录超时，未启动智能体；可重新运行原任务".into(),
            )
        })??;
        if !approved {
            return Err(AcpError::PiProjectTrustRequired(
                "用户拒绝目录信任，原任务未启动".into(),
            ));
        }
        // 批准后再次检查原生决定，外部撤销不能被旧通知覆盖。
        if self.needs_approval(&inspect_target(agent, cwd, env)?)? {
            return Err(AcpError::PiProjectTrustRequired(
                "目录信任状态已变化，请重试确认".into(),
            ));
        }
        Ok(())
    }

    fn write_decision(&self, target: &ProjectTrustTarget, approved: bool) -> Result<(), AcpError> {
        let _writes = self.writes.lock().unwrap();
        let file = Path::new(&target.trust_file);
        if target.agent_type == "pi" {
            config::pi_write_trust_decision_at(file, Path::new(&target.workspace), Some(approved))?;
        } else {
            let _lock = config::acquire_pi_trust_lock(file)?;
            let mut map = read_object_with_comments(file, true)?;
            // 保留原生条目，使用相同的 proper-lockfile 目录锁与原子替换。
            map.insert(
                target.workspace.clone(),
                serde_json::Value::String(
                    if approved {
                        "TRUST_FOLDER"
                    } else {
                        "DO_NOT_TRUST"
                    }
                    .into(),
                ),
            );
            write_object(file, &map)?;
        }
        let mut ack = read_object(&self.ack_file)?;
        ack.insert(ack_key(target), serde_json::Value::Bool(approved));
        write_object(&self.ack_file, &ack)
    }

    pub(crate) fn record_pi_confirmation(
        &self,
        cwd: &Path,
        env: &BTreeMap<String, String>,
        approved: bool,
    ) -> Result<(), AcpError> {
        let target = inspect_target(AgentType::Pi, cwd, env)?;
        {
            let _writes = self.writes.lock().unwrap();
            if approved && decision(&target)? != Some(true) {
                return Err(AcpError::protocol("Pi 原生信任尚未允许，不能仅确认旧提示"));
            }
            let mut ack = read_object(&self.ack_file)?;
            ack.insert(ack_key(&target), serde_json::Value::Bool(approved));
            write_object(&self.ack_file, &ack)?;
        }
        if approved {
            self.finish_matching(&target);
        }
        Ok(())
    }

    fn grant_targets(
        &self,
        agent: AgentType,
        workspaces: Vec<String>,
        env: &BTreeMap<String, String>,
    ) -> Vec<ProjectTrustBatchResult> {
        workspaces
            .into_iter()
            .map(|workspace| {
                let result = inspect_target(agent, Path::new(&workspace), env).and_then(|t| {
                    self.write_decision(&t, true)?;
                    self.finish_matching(&t);
                    Ok(())
                });
                ProjectTrustBatchResult {
                    workspace,
                    success: result.is_ok(),
                    error: result.err().map(|e| e.to_string()),
                }
            })
            .collect()
    }

    pub async fn resolve(&'static self, id: String, approved: bool) -> Result<(), AcpError> {
        let (request, env) = {
            let mut pending = self.pending.lock().unwrap();
            let p = pending
                .get_mut(&id)
                .ok_or_else(|| AcpError::protocol("目录信任请求不存在或已结束"))?;
            if p.resolving {
                return Err(AcpError::protocol("目录信任请求正在处理"));
            }
            p.resolving = true;
            (p.request.clone(), p.env.clone())
        };
        tokio::task::spawn_blocking(move || {
            let result = (|| {
                for original in &request.targets {
                    let current = inspect_target(
                        supported(&original.agent_type)?,
                        Path::new(&original.workspace),
                        &env,
                    )?;
                    if &current != original {
                        return Err(AcpError::protocol("目录资源已变化，请重新发起授权"));
                    }
                    self.write_decision(&current, approved)?;
                }
                Ok(())
            })();
            // 即使 HTTP 调用方断线，已确认的写入也必须完成清理并唤醒等待者。
            if let Some(p) = self.pending.lock().unwrap().remove(&id) {
                let _ = p.answer.send(Some(approved && result.is_ok()));
                emit_event(
                    &p.emitter,
                    "project-trust-resolved",
                    serde_json::json!({"requestId": id}),
                );
            }
            if approved && result.is_ok() {
                for target in &request.targets {
                    self.finish_matching(target);
                }
            }
            result
        })
        .await
        .map_err(|e| AcpError::protocol(format!("目录授权任务失败：{e}")))?
    }
}

struct TrustWaiter<'a> {
    broker: &'a ProjectTrustBroker,
    id: String,
    rx: watch::Receiver<Option<bool>>,
}

impl Drop for TrustWaiter<'_> {
    fn drop(&mut self) {
        let mut pending = self.broker.pending.lock().unwrap();
        if pending
            .get(&self.id)
            .is_some_and(|p| p.answer.receiver_count() <= 1 && !p.resolving)
        {
            if let Some(p) = pending.remove(&self.id) {
                emit_event(
                    &p.emitter,
                    "project-trust-resolved",
                    serde_json::json!({"requestId": self.id}),
                );
            }
        }
    }
}

async fn runtime_env(
    db: &AppDatabase,
    agent: AgentType,
) -> Result<BTreeMap<String, String>, AcpError> {
    let setting = crate::db::service::agent_setting_service::get_by_agent_type(&db.conn, agent)
        .await
        .map_err(|e| AcpError::protocol(format!("读取智能体环境失败：{e}")))?;
    let local = config::load_agent_local_config_json(agent);
    Ok(config::build_runtime_env_from_setting(
        agent,
        setting.as_ref(),
        local.as_deref(),
    ))
}

pub async fn inspect(
    db: &AppDatabase,
    agent_type: String,
    workspaces: Vec<String>,
) -> Result<Vec<ProjectTrustTarget>, AcpError> {
    let agent = supported(&agent_type)?;
    if workspaces.len() > 256 {
        return Err(AcpError::protocol("一次最多检查 256 个目录"));
    }
    let env = runtime_env(db, agent).await?;
    workspaces
        .iter()
        .map(|w| inspect_target(agent, Path::new(w), &env))
        .collect()
}

pub async fn grant_batch(
    db: &AppDatabase,
    agent_type: String,
    workspaces: Vec<String>,
) -> Result<Vec<ProjectTrustBatchResult>, AcpError> {
    let agent = supported(&agent_type)?;
    if workspaces.len() > 256 {
        return Err(AcpError::protocol("一次最多授权 256 个目录"));
    }
    let env = runtime_env(db, agent).await?;
    tokio::task::spawn_blocking(move || broker().grant_targets(agent, workspaces, &env))
        .await
        .map_err(|e| AcpError::protocol(format!("批量目录授权失败：{e}")))
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub fn project_trust_pending() -> Vec<ProjectTrustRequest> {
    broker().pending()
}
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub fn project_trust_agents() -> Vec<ProjectTrustAgent> {
    agents()
}
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn project_trust_resolve(request_id: String, approved: bool) -> Result<(), AcpError> {
    broker().resolve(request_id, approved).await
}
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn project_trust_inspect(
    db: tauri::State<'_, AppDatabase>,
    agent_type: String,
    workspaces: Vec<String>,
) -> Result<Vec<ProjectTrustTarget>, AcpError> {
    inspect(&db, agent_type, workspaces).await
}
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn project_trust_grant_batch(
    db: tauri::State<'_, AppDatabase>,
    agent_type: String,
    workspaces: Vec<String>,
) -> Result<Vec<ProjectTrustBatchResult>, AcpError> {
    grant_batch(&db, agent_type, workspaces).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::web::event_bridge::WebEventBroadcaster;

    struct Fixture {
        _tmp: tempfile::TempDir,
        cwd: PathBuf,
        env: BTreeMap<String, String>,
        broker: &'static ProjectTrustBroker,
    }

    impl Fixture {
        fn new(timeout: Duration) -> Self {
            let tmp = tempfile::tempdir().unwrap();
            let cwd = tmp.path().join("workspace");
            std::fs::create_dir_all(cwd.join(".pi/extensions")).unwrap();
            let env = BTreeMap::from([
                (
                    "PI_CODING_AGENT_DIR".into(),
                    tmp.path().join("custom-pi").to_string_lossy().into_owned(),
                ),
                ("HOME".into(), tmp.path().to_string_lossy().into_owned()),
                (
                    "GEMINI_CLI_HOME".into(),
                    tmp.path().to_string_lossy().into_owned(),
                ),
            ]);
            let broker = Box::leak(Box::new(ProjectTrustBroker::new(
                tmp.path().join("codeg/ack.json"),
                timeout,
            )));
            Self {
                _tmp: tmp,
                cwd,
                env,
                broker,
            }
        }

        fn start(
            &self,
            agent: AgentType,
            emitter: EventEmitter,
        ) -> tokio::task::JoinHandle<Result<(), AcpError>> {
            let (broker, cwd, env) = (self.broker, self.cwd.clone(), self.env.clone());
            tokio::spawn(async move { broker.before_launch(agent, &cwd, &env, &emitter).await })
        }

        async fn request(&self) -> ProjectTrustRequest {
            tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    if let Some(request) = self.broker.pending().into_iter().next() {
                        return request;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap()
        }
    }

    #[tokio::test]
    async fn shared_gate_pauses_then_approval_resumes_without_current_tab() {
        let f = Fixture::new(Duration::from_secs(5));
        let web = Arc::new(WebEventBroadcaster::new());
        let mut events = web.subscribe();
        let task = f.start(AgentType::Pi, EventEmitter::test_web_only(web));
        let request = f.request().await;
        assert!(!task.is_finished(), "批准前不能执行后续启动");
        assert_eq!(
            events.recv().await.unwrap().channel,
            "project-trust-requested"
        );
        assert_eq!(
            request.targets[0].trust_file,
            Path::new(&f.env["PI_CODING_AGENT_DIR"])
                .join("trust.json")
                .to_string_lossy()
        );
        f.broker.resolve(request.request_id, true).await.unwrap();
        task.await.unwrap().unwrap();
        assert_eq!(
            events.recv().await.unwrap().channel,
            "project-trust-resolved"
        );
        assert!(f.broker.pending().is_empty());
        assert_eq!(
            decision(&inspect_target(AgentType::Pi, &f.cwd, &f.env).unwrap()).unwrap(),
            Some(true)
        );
        f.broker
            .verify_launch(AgentType::Pi, &f.cwd, &f.env)
            .unwrap();
    }

    #[tokio::test]
    async fn explicit_denial_stops_all_waiters_and_is_not_an_allow() {
        let f = Fixture::new(Duration::from_secs(5));
        let task = f.start(AgentType::Pi, EventEmitter::Noop);
        let request = f.request().await;
        f.broker.resolve(request.request_id, false).await.unwrap();
        assert!(task.await.unwrap().is_err());
        assert_eq!(
            decision(&inspect_target(AgentType::Pi, &f.cwd, &f.env).unwrap()).unwrap(),
            Some(false)
        );
        assert!(f
            .broker
            .before_launch(AgentType::Pi, &f.cwd, &f.env, &EventEmitter::Noop)
            .await
            .is_err());
        assert!(f.broker.pending().is_empty());
    }

    #[tokio::test]
    async fn concurrent_same_directory_is_deduplicated_and_one_cancel_does_not_cancel_others() {
        let f = Fixture::new(Duration::from_secs(5));
        let first = f.start(AgentType::Pi, EventEmitter::Noop);
        let request = f.request().await;
        let second = f.start(AgentType::Pi, EventEmitter::Noop);
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if f.broker
                    .pending
                    .lock()
                    .unwrap()
                    .values()
                    .next()
                    .unwrap()
                    .answer
                    .receiver_count()
                    == 2
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(f.broker.pending().len(), 1);
        first.abort();
        assert!(first.await.unwrap_err().is_cancelled());
        assert_eq!(f.broker.pending().len(), 1);
        f.broker.resolve(request.request_id, true).await.unwrap();
        second.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn cancellation_and_no_ui_timeout_remove_pending_without_granting() {
        let f = Fixture::new(Duration::from_millis(60));
        let task = f.start(AgentType::Pi, EventEmitter::Noop);
        f.request().await;
        task.abort();
        let _ = task.await;
        assert!(f.broker.pending().is_empty());
        assert!(f
            .start(AgentType::Pi, EventEmitter::Noop)
            .await
            .unwrap()
            .is_err());
        assert!(f.broker.pending().is_empty());
        assert!(!Path::new(&f.env["PI_CODING_AGENT_DIR"])
            .join("trust.json")
            .exists());
    }

    #[tokio::test]
    async fn reconnect_pulls_history_grant_without_automatically_acknowledging_it() {
        let f = Fixture::new(Duration::from_secs(5));
        let target = inspect_target(AgentType::Pi, &f.cwd, &f.env).unwrap();
        config::pi_write_trust_decision_at(Path::new(&target.trust_file), &f.cwd, Some(true))
            .unwrap();
        let task = f.start(AgentType::Pi, EventEmitter::Noop);
        let request = f.request().await;
        assert!(!task.is_finished());
        // 模拟 UI 断开后重新补拉，无需当前会话/窗口信息。
        assert_eq!(f.broker.pending()[0].request_id, request.request_id);
        assert!(!f.broker.ack_file.exists());
        f.broker.resolve(request.request_id, true).await.unwrap();
        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn custom_profiles_do_not_share_acknowledgement_or_write_the_default_profile() {
        let f = Fixture::new(Duration::from_secs(5));
        let task = f.start(AgentType::Pi, EventEmitter::Noop);
        f.broker
            .resolve(f.request().await.request_id, true)
            .await
            .unwrap();
        task.await.unwrap().unwrap();
        let mut second_env = f.env.clone();
        second_env.insert("PI_CODING_AGENT_DIR".into(), "other-profile".into());
        let second = inspect_target(AgentType::Pi, &f.cwd, &second_env).unwrap();
        assert_eq!(
            second.trust_file,
            f.cwd.join("other-profile/trust.json").to_string_lossy()
        );
        assert!(f.broker.needs_approval(&second).unwrap());
        assert!(!f._tmp.path().join(".pi/agent/trust.json").exists());
    }

    #[tokio::test]
    async fn batch_reports_partial_failure_and_resumes_matching_original_task() {
        let f = Fixture::new(Duration::from_secs(5));
        let task = f.start(AgentType::Pi, EventEmitter::Noop);
        f.request().await;
        let results = f.broker.grant_targets(
            AgentType::Pi,
            vec![
                f.cwd.to_string_lossy().into_owned(),
                "relative/invalid".into(),
            ],
            &f.env,
        );
        assert!(results[0].success);
        assert!(!results[1].success);
        assert!(results[1].error.is_some());
        task.await.unwrap().unwrap();
        assert!(f.broker.pending().is_empty());
    }

    #[tokio::test]
    async fn resource_changes_invalidate_the_confirmation_before_any_write() {
        let f = Fixture::new(Duration::from_secs(5));
        let task = f.start(AgentType::Pi, EventEmitter::Noop);
        let request = f.request().await;
        std::fs::write(f.cwd.join(".pi/mcp.json"), "{}").unwrap();
        assert!(f.broker.resolve(request.request_id, true).await.is_err());
        assert!(task.await.unwrap().is_err());
        assert!(!Path::new(&f.env["PI_CODING_AGENT_DIR"])
            .join("trust.json")
            .exists());
        assert!(f.broker.pending().is_empty());
    }

    #[test]
    fn gemini_preserves_native_parent_and_denial_semantics_and_comments() {
        let f = Fixture::new(Duration::from_secs(5));
        let target = inspect_target(AgentType::Gemini, &f.cwd, &f.env).unwrap();
        let file = Path::new(&target.trust_file);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        let parent_rule = f.cwd.join("child").to_string_lossy().into_owned();
        let unrelated = f
            ._tmp
            .path()
            .join("unrelated")
            .to_string_lossy()
            .into_owned();
        std::fs::write(
            file,
            format!(
                "{{ /* 原生允许注释 */ {}: \"TRUST_PARENT\", {}: \"DO_NOT_TRUST\" }}",
                serde_json::to_string(&parent_rule).unwrap(),
                serde_json::to_string(&unrelated).unwrap()
            ),
        )
        .unwrap();
        assert_eq!(decision(&target).unwrap(), Some(true));
        assert!(f.broker.needs_approval(&target).unwrap());
        f.broker.write_decision(&target, true).unwrap();
        let written = read_object(file).unwrap();
        assert_eq!(written[&target.workspace], "TRUST_FOLDER");
        assert_eq!(written[&parent_rule], "TRUST_PARENT");
        assert_eq!(written[&unrelated], "DO_NOT_TRUST");
        f.broker.write_decision(&target, false).unwrap();
        assert_eq!(decision(&target).unwrap(), Some(true));
    }

    #[test]
    fn invalid_config_is_never_clobbered_and_paths_are_validated() {
        let f = Fixture::new(Duration::from_secs(5));
        assert!(inspect_target(AgentType::Pi, Path::new("relative"), &f.env).is_err());
        assert!(inspect_target(AgentType::Pi, &f.cwd.join("missing"), &f.env).is_err());
        let target = inspect_target(AgentType::Gemini, &f.cwd, &f.env).unwrap();
        let file = Path::new(&target.trust_file);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, "{ broken").unwrap();
        assert!(f.broker.write_decision(&target, true).is_err());
        assert_eq!(std::fs::read_to_string(file).unwrap(), "{ broken");
    }

    use std::sync::Arc;
}
