//! 本机 @ 面板查询；公共核心可在 server/mcp 编译，但不注册 Web 路由。

use std::collections::HashMap;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::app_error::AppCommandError;
use crate::cli_run::wire::{AgentEntry, AssistantEntry};
use crate::db::AppDatabase;
use crate::remote_gateway::{self, RemoteCapabilities};

const LIST_TTL: Duration = Duration::from_secs(60);
const LIST_TIMEOUT: Duration = Duration::from_secs(8);
const FILE_LIMIT: usize = 20_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteFolder {
    pub id: i32,
    pub name: String,
    pub path: String,
    pub alias: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteEntryKind {
    File,
    Dir,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteFileEntry {
    pub name: String,
    pub path: String,
    pub kind: RemoteEntryKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteFiles {
    pub entries: Vec<RemoteFileEntry>,
    pub truncated: bool,
}

struct ListEntry {
    at: Instant,
    value: Value,
}
static LISTS: LazyLock<Mutex<HashMap<String, ListEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn decode<T: DeserializeOwned>(value: Value) -> Result<T, AppCommandError> {
    serde_json::from_value(value).map_err(|_| AppCommandError::network("远程列表响应格式无效"))
}

async fn cached_list(
    db: &AppDatabase,
    connection_id: i32,
    command: &str,
    args: Value,
    refresh: bool,
) -> Result<Value, AppCommandError> {
    // 先查本机连接，删除或修改连接后不得命中旧缓存。
    let identity = remote_gateway::connection_key(db, connection_id).await?;
    let key = format!("{identity}:{command}:{args}");
    if !refresh {
        let mut cache = LISTS.lock().await;
        cache.retain(|_, entry| entry.at.elapsed() < LIST_TTL);
        if let Some(entry) = cache.get(&key) {
            return Ok(entry.value.clone());
        }
    }
    let value =
        remote_gateway::call_allowed(db, connection_id, command, Some(args), Some(8000)).await?;
    let value = if command == "list_workspace_files" {
        let mut entries: Vec<RemoteFileEntry> = decode(value)?;
        let truncated = entries.len() > FILE_LIMIT;
        entries.truncate(FILE_LIMIT);
        serde_json::to_value(RemoteFiles { entries, truncated }).expect("文件列表可序列化")
    } else {
        value
    };
    // 请求期间凭据有改动时不把新地址的数据写到旧身份的缓存键。
    if remote_gateway::connection_key(db, connection_id).await? == identity {
        LISTS.lock().await.insert(
            key,
            ListEntry {
                at: Instant::now(),
                value: value.clone(),
            },
        );
    }
    Ok(value)
}

async fn bounded<T>(
    future: impl std::future::Future<Output = Result<T, AppCommandError>>,
) -> Result<T, AppCommandError> {
    tokio::time::timeout(LIST_TIMEOUT, future)
        .await
        .map_err(|_| AppCommandError::network("远程列表请求超时"))?
}

pub async fn remote_mention_probe_core(
    db: &AppDatabase,
    connection_id: i32,
) -> Result<RemoteCapabilities, AppCommandError> {
    remote_gateway::hello(db, connection_id).await
}

pub async fn remote_mention_list_folders_core(
    db: &AppDatabase,
    connection_id: i32,
) -> Result<Vec<RemoteFolder>, AppCommandError> {
    bounded(async {
        decode(
            cached_list(
                db,
                connection_id,
                "list_all_folder_details",
                json!({}),
                false,
            )
            .await?,
        )
    })
    .await
}

/// 路径只从远程已登记项目解析；缓存找不到时强制刷新一次。
pub async fn resolve_folder(
    db: &AppDatabase,
    connection_id: i32,
    folder_id: i32,
) -> Result<RemoteFolder, AppCommandError> {
    if folder_id <= 0 {
        return Err(AppCommandError::invalid_input("远程项目 ID 必须为正数"));
    }
    for refresh in [false, true] {
        let folders: Vec<RemoteFolder> = decode(
            cached_list(
                db,
                connection_id,
                "list_all_folder_details",
                json!({}),
                refresh,
            )
            .await?,
        )?;
        if let Some(folder) = folders.into_iter().find(|folder| folder.id == folder_id) {
            return Ok(folder);
        }
    }
    Err(AppCommandError::not_found("远程项目不存在或未登记"))
}

pub async fn remote_mention_list_files_core(
    db: &AppDatabase,
    connection_id: i32,
    folder_id: i32,
) -> Result<RemoteFiles, AppCommandError> {
    bounded(async {
        let folder = resolve_folder(db, connection_id, folder_id).await?;
        decode(
            cached_list(
                db,
                connection_id,
                "list_workspace_files",
                json!({"path": folder.path}),
                false,
            )
            .await?,
        )
    })
    .await
}

// DbConversationSummary 仅实现 Serialize；保持远程 snake_case 原值及可选扩展字段，不能统一改为 camelCase。
pub async fn remote_mention_list_sessions_core(
    db: &AppDatabase,
    connection_id: i32,
    folder_id: i32,
    search: Option<String>,
) -> Result<Vec<Value>, AppCommandError> {
    bounded(async {
        resolve_folder(db, connection_id, folder_id).await?;
        let sessions: Vec<Value> = decode(
            cached_list(
                db,
                connection_id,
                "list_all_conversations",
                json!({"folderIds": [folder_id], "search": search}),
                false,
            )
            .await?,
        )?;
        if sessions.iter().any(|session| {
            session.get("folder_id").and_then(Value::as_i64) != Some(i64::from(folder_id))
        }) {
            return Err(AppCommandError::network("远程会话响应不属于所选项目"));
        }
        Ok(sessions)
    })
    .await
}

pub async fn remote_mention_list_assistants_core(
    db: &AppDatabase,
    connection_id: i32,
) -> Result<Vec<AssistantEntry>, AppCommandError> {
    bounded(async {
        decode(cached_list(db, connection_id, "cli_assistants", json!({}), false).await?)
    })
    .await
}

pub async fn remote_mention_list_agents_core(
    db: &AppDatabase,
    connection_id: i32,
) -> Result<Vec<AgentEntry>, AppCommandError> {
    bounded(async {
        let agents: Vec<AgentEntry> =
            decode(cached_list(db, connection_id, "cli_agents", json!({}), false).await?)?;
        Ok(agents
            .into_iter()
            .filter(|agent| agent.enabled && agent.installed)
            .collect())
    })
    .await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn remote_mention_probe(
    db: tauri::State<'_, AppDatabase>,
    connection_id: i32,
) -> Result<RemoteCapabilities, AppCommandError> {
    remote_mention_probe_core(&db, connection_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn remote_mention_list_folders(
    db: tauri::State<'_, AppDatabase>,
    connection_id: i32,
) -> Result<Vec<RemoteFolder>, AppCommandError> {
    remote_mention_list_folders_core(&db, connection_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn remote_mention_list_files(
    db: tauri::State<'_, AppDatabase>,
    connection_id: i32,
    folder_id: i32,
) -> Result<RemoteFiles, AppCommandError> {
    remote_mention_list_files_core(&db, connection_id, folder_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn remote_mention_list_sessions(
    db: tauri::State<'_, AppDatabase>,
    connection_id: i32,
    folder_id: i32,
    search: Option<String>,
) -> Result<Vec<Value>, AppCommandError> {
    remote_mention_list_sessions_core(&db, connection_id, folder_id, search).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn remote_mention_list_assistants(
    db: tauri::State<'_, AppDatabase>,
    connection_id: i32,
) -> Result<Vec<AssistantEntry>, AppCommandError> {
    remote_mention_list_assistants_core(&db, connection_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn remote_mention_list_agents(
    db: tauri::State<'_, AppDatabase>,
    connection_id: i32,
) -> Result<Vec<AgentEntry>, AppCommandError> {
    remote_mention_list_agents_core(&db, connection_id).await
}
