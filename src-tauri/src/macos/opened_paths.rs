#[cfg(feature = "tauri-runtime")]
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use url::Url;

pub const FINDER_DIRECTORY_OPENED_EVENT: &str = "finder://directory-opened";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenedPathError {
    InvalidUrl,
    UnsupportedScheme,
    NonLocalFile,
    InvalidFilePath,
    NonUtf8Path,
    NotDirectory,
    UnreadablePath,
}

pub fn parse_opened_url(raw: &str) -> Result<PathBuf, OpenedPathError> {
    let url = Url::parse(raw).map_err(|_| OpenedPathError::InvalidUrl)?;
    if url.scheme() != "file" {
        return Err(OpenedPathError::UnsupportedScheme);
    }
    if url
        .host_str()
        .is_some_and(|host| !host.is_empty() && !host.eq_ignore_ascii_case("localhost"))
    {
        return Err(OpenedPathError::NonLocalFile);
    }

    let path = url
        .to_file_path()
        .map_err(|_| OpenedPathError::InvalidFilePath)?;
    if path.to_str().is_none() {
        tracing::warn!("Finder 目录事件拒绝非 UTF-8 路径：{:?}", path);
        return Err(OpenedPathError::NonUtf8Path);
    }
    let path = std::fs::canonicalize(path).map_err(|_| OpenedPathError::UnreadablePath)?;
    if !path.is_dir() {
        return Err(OpenedPathError::NotDirectory);
    }
    Ok(path)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnqueueResult {
    Queued,
    Ready,
    Duplicate,
}

#[derive(Debug, Default)]
struct QueueState {
    frontend_ready: bool,
    pending: Vec<PathBuf>,
    recent: Vec<(PathBuf, Instant)>,
}

const DUPLICATE_EVENT_WINDOW: Duration = Duration::from_millis(500);

#[derive(Debug, Default)]
pub struct OpenedPathQueue {
    state: Mutex<QueueState>,
}

impl OpenedPathQueue {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(QueueState::default()),
        }
    }

    pub fn push(&self, path: PathBuf) -> EnqueueResult {
        self.push_at(path, Instant::now())
    }

    pub(crate) fn push_at(&self, path: PathBuf, now: Instant) -> EnqueueResult {
        let Ok(mut state) = self.state.lock() else {
            tracing::error!("Finder 目录事件队列锁已损坏，丢弃路径");
            return EnqueueResult::Duplicate;
        };
        state
            .recent
            .retain(|(_, at)| now.saturating_duration_since(*at) < DUPLICATE_EVENT_WINDOW);
        if state.recent.iter().any(|(recent, _)| recent == &path) {
            return EnqueueResult::Duplicate;
        }
        state.recent.push((path.clone(), now));
        if state.frontend_ready {
            return EnqueueResult::Ready;
        }
        state.pending.push(path);
        EnqueueResult::Queued
    }

    pub fn drain(&self) -> Vec<PathBuf> {
        let Ok(mut state) = self.state.lock() else {
            tracing::error!("Finder 目录事件队列锁已损坏，无法取出暂存路径");
            return Vec::new();
        };
        state.frontend_ready = true;
        std::mem::take(&mut state.pending)
    }

    pub fn mark_frontend_ready(&self) -> Vec<PathBuf> {
        self.drain()
    }

    pub fn requeue(&self, path: PathBuf) {
        let Ok(mut state) = self.state.lock() else {
            tracing::error!("Finder 目录事件队列锁已损坏，无法重新排队路径");
            return;
        };
        state.pending.push(path);
    }

    pub fn remove_pending(&self, path: &Path) -> bool {
        let Ok(mut state) = self.state.lock() else {
            tracing::error!("Finder 目录事件队列锁已损坏，无法移除已恢复路径");
            return false;
        };
        let Some(index) = state.pending.iter().position(|pending| pending == path) else {
            return false;
        };
        state.pending.remove(index);
        true
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct FinderDirectoryOpened {
    pub path: String,
}

pub fn event_for_path(path: &Path) -> Result<FinderDirectoryOpened, OpenedPathError> {
    let path = path.to_str().ok_or(OpenedPathError::NonUtf8Path)?;
    Ok(FinderDirectoryOpened {
        path: path.to_string(),
    })
}

pub fn deduplicate_paths(paths: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
    use std::collections::HashSet;

    let mut seen = HashSet::new();
    paths
        .into_iter()
        .filter(|path| seen.insert(path.clone()))
        .collect()
}

static OPENED_PATH_QUEUE: OnceLock<OpenedPathQueue> = OnceLock::new();

#[cfg(feature = "tauri-runtime")]
struct EmitRetry {
    app: tauri::AppHandle,
    path: PathBuf,
    payload: FinderDirectoryOpened,
    attempt: u32,
}

#[cfg(feature = "tauri-runtime")]
#[derive(Default)]
struct EmitRetryState {
    pending: VecDeque<EmitRetry>,
    running: bool,
}

#[cfg(feature = "tauri-runtime")]
static EMIT_RETRY_STATE: OnceLock<Mutex<EmitRetryState>> = OnceLock::new();

pub fn global_queue() -> &'static OpenedPathQueue {
    OPENED_PATH_QUEUE.get_or_init(OpenedPathQueue::new)
}

#[cfg(feature = "tauri-runtime")]
pub fn handle_opened_urls(app: &tauri::AppHandle, urls: &[Url]) {
    let paths = urls
        .iter()
        .filter_map(|url| match parse_opened_url(url.as_str()) {
            Ok(path) => Some(path),
            Err(error) => {
                tracing::warn!("Finder 目录事件忽略 URL {}：{:?}", url, error);
                None
            }
        });

    for path in deduplicate_paths(paths) {
        match global_queue().push(path.clone()) {
            EnqueueResult::Queued => {
                tracing::info!("Finder 目录事件已暂存：{}", path.display());
            }
            EnqueueResult::Ready => {
                emit_directory_opened(app, &path);
            }
            EnqueueResult::Duplicate => {
                tracing::info!("Finder 目录事件已去重：{}", path.display());
            }
        }
    }
}

#[cfg(feature = "tauri-runtime")]
fn emit_directory_opened(app: &tauri::AppHandle, path: &Path) {
    let Ok(payload) = event_for_path(path) else {
        tracing::warn!("Finder 目录事件拒绝非 UTF-8 路径：{:?}", path);
        return;
    };
    let emitter = crate::web::event_bridge::EventEmitter::Tauri(app.clone());
    if crate::web::event_bridge::emit_event_checked(
        &emitter,
        FINDER_DIRECTORY_OPENED_EVENT,
        &payload,
    ) {
        tracing::info!("Finder 目录事件已广播：{}", path.display());
    } else {
        tracing::warn!("Finder 目录事件广播失败，保留重试：{}", path.display());
        global_queue().requeue(path.to_path_buf());
        schedule_emit_retry(app.clone(), path.to_path_buf(), payload);
    }
}

#[cfg(feature = "tauri-runtime")]
fn schedule_emit_retry(app: tauri::AppHandle, path: PathBuf, payload: FinderDirectoryOpened) {
    let retry_state = EMIT_RETRY_STATE.get_or_init(|| Mutex::new(EmitRetryState::default()));
    let should_start = {
        let Ok(mut state) = retry_state.lock() else {
            tracing::error!("Finder 目录事件重试队列锁已损坏，无法安排重试");
            return;
        };
        state.pending.push_back(EmitRetry {
            app,
            path,
            payload,
            attempt: 0,
        });
        if state.running {
            false
        } else {
            state.running = true;
            true
        }
    };

    if should_start {
        tauri::async_runtime::spawn(run_emit_retries());
    }
}

#[cfg(feature = "tauri-runtime")]
pub(crate) fn retry_delay(attempt: u32) -> Duration {
    Duration::from_millis(50 * 2u64.pow(attempt.min(7))).min(Duration::from_secs(5))
}

#[cfg(feature = "tauri-runtime")]
async fn run_emit_retries() {
    loop {
        let retry = {
            let Some(retry_state) = EMIT_RETRY_STATE.get() else {
                return;
            };
            let Ok(mut state) = retry_state.lock() else {
                tracing::error!("Finder 目录事件重试队列锁已损坏，停止后台重试");
                return;
            };
            let Some(retry) = state.pending.pop_front() else {
                state.running = false;
                return;
            };
            retry
        };

        tokio::time::sleep(retry_delay(retry.attempt)).await;
        if !global_queue().remove_pending(&retry.path) {
            tracing::info!(
                "Finder 目录事件已由前端待处理队列消费，取消后台重试：{}",
                retry.path.display()
            );
            continue;
        }

        let emitter = crate::web::event_bridge::EventEmitter::Tauri(retry.app.clone());
        let attempt = retry.attempt.saturating_add(1);
        if crate::web::event_bridge::emit_event_checked(
            &emitter,
            FINDER_DIRECTORY_OPENED_EVENT,
            retry.payload.clone(),
        ) {
            tracing::info!(
                "Finder 目录事件重试恢复：{}（第 {} 次）",
                retry.path.display(),
                attempt
            );
            continue;
        }

        global_queue().requeue(retry.path.clone());
        tracing::warn!(
            "Finder 目录事件重试失败：{}（第 {} 次），将在 {} 毫秒后继续",
            retry.path.display(),
            attempt,
            retry_delay(attempt).as_millis()
        );
        let Some(retry_state) = EMIT_RETRY_STATE.get() else {
            return;
        };
        let Ok(mut state) = retry_state.lock() else {
            tracing::error!("Finder 目录事件重试队列锁已损坏，停止后台重试");
            return;
        };
        state.pending.push_back(EmitRetry { attempt, ..retry });
    }
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub fn take_pending_finder_directories() -> Vec<FinderDirectoryOpened> {
    global_queue()
        .drain()
        .iter()
        .filter_map(|path| match event_for_path(path.as_path()) {
            Ok(event) => Some(event),
            Err(error) => {
                tracing::warn!("Finder 目录事件拒绝路径：{:?}：{:?}", path, error);
                None
            }
        })
        .collect()
}
