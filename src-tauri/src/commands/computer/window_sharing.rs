use super::{now_ms, service, ComputerService, DesktopUi};
use crate::acp::computer_tools::{
    ComputerShareOutcome, ERROR_ACTION_FAILED, ERROR_NO_SUCH_TARGET, ERROR_STOPPED,
    ERROR_UNAVAILABLE, STOPPED_NOTE,
};
use crate::app_error::AppCommandError;
use crate::computer::agent::{grantable, level_of, GrantLevel, GrantScope};
use crate::computer::backend::ComputerBackend;
use crate::computer::share_consent::{ShareRequest, ShareWindow};
use serde::Serialize;
use std::time::Duration;
use tauri::{Emitter, Manager, Webview};
use tokio::time::Instant;

const OWNER: &str = "main";
const REQUEST: &str = "computer://share-request";
const CLOSED: &str = "computer://share-request-closed";
const WAIT: Duration = Duration::from_secs(90);
const MANUAL: &str = "Window sharing requests require the local BeeCode desktop. Ask the user to share the window manually.";
const STALE: &str = "The selected window or its sharing changed. List the windows again before making a new request.";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShareRequestSignal<'a> {
    request_id: &'a str,
}

// MCP 连接取消或提前结束时，也撤下确认框和待答复请求。
struct RequestGuard<'a> {
    ui: &'a DesktopUi,
    id: &'a str,
}

impl Drop for RequestGuard<'_> {
    fn drop(&mut self) {
        self.ui.share_consent.remove(self.id);
        let _ = self.ui.app.emit_to(
            OWNER,
            CLOSED,
            ShareRequestSignal {
                request_id: self.id,
            },
        );
    }
}

fn valid_request(ids: &[String], level: GrantLevel) -> bool {
    matches!(level, GrantLevel::Read | GrantLevel::Control)
        && (1..=20).contains(&ids.len())
        && ids.iter().enumerate().all(|(i, id)| {
            id.strip_prefix('w').is_some_and(|n| {
                !n.starts_with('0')
                    && n.bytes().all(|b| b.is_ascii_digit())
                    && n.parse::<u64>().is_ok()
            }) && !ids[..i].contains(id)
        })
}

impl ComputerService {
    // 调用方持有 grant_gate，让取消与授权提交互斥。
    pub(super) fn cancel_share_request(&self) {
        if let Some(ui) = &self.desktop {
            ui.share_consent.cancel();
        }
    }

    pub(super) async fn agent_request_window_sharing(
        &self,
        ids: Vec<String>,
        level: GrantLevel,
    ) -> ComputerShareOutcome {
        let Some(ui) = self.desktop.as_ref() else {
            return ComputerShareOutcome::refused(ERROR_UNAVAILABLE, MANUAL);
        };
        let Some(window) = ui.app.get_webview_window(OWNER) else {
            return ComputerShareOutcome::refused(ERROR_UNAVAILABLE, MANUAL);
        };
        if !valid_request(&ids, level) {
            return ComputerShareOutcome::refused(ERROR_ACTION_FAILED, "Use 1 to 20 distinct window IDs from computer_list_windows and request only read or control.");
        }

        let stop = self.stop_count();
        let id = uuid::Uuid::new_v4().to_string();
        let (offered, answer, expires) = {
            let _turn = self.turn.lock().await;
            if let Err(outcome) = self.refresh_share_windows(stop).await {
                return outcome;
            }
            let _gate = self.grant_gate.lock().unwrap_or_else(|p| p.into_inner());
            if self.stopped_since(stop) {
                return ComputerShareOutcome::refused(ERROR_STOPPED, STOPPED_NOTE);
            }
            let policy = self.policy.lock().unwrap_or_else(|p| p.into_inner());
            if !policy.enabled {
                return ComputerShareOutcome::refused(ERROR_UNAVAILABLE, MANUAL);
            }
            let entries: Vec<_> = ids
                .iter()
                .filter_map(|target_id| self.targets.get(target_id))
                .filter(|e| !e.gone && e.worth_listing())
                .filter(|e| grantable(&e.app, &self.me, &policy.blocklist).is_ok())
                .collect();
            let screen_shared = self.targets.shared_screen().is_some();
            let offered: Vec<_> = entries
                .iter()
                .filter(|e| {
                    let grant = e.grant.as_ref();
                    !screen_shared
                        && !level_of(grant).allows(level)
                        && grant.is_none_or(|g| g.scope == GrantScope::Window)
                })
                .cloned()
                .collect();
            if offered.is_empty() {
                if entries.len() == ids.len()
                    && entries
                        .iter()
                        .all(|e| level_of(e.grant.as_ref()).allows(level))
                {
                    return ComputerShareOutcome {
                        note: Some("The requested windows are already shared at this level or higher. No permission changed.".into()),
                        ..Default::default()
                    };
                }
                return ComputerShareOutcome::refused(ERROR_NO_SUCH_TARGET, "None of these windows can be shared at the requested level. List the windows again and check for app or screen sharing.");
            }
            let expires = Instant::now() + WAIT;
            let request = ShareRequest {
                request_id: id.clone(),
                requested_level: level,
                windows: offered
                    .iter()
                    .map(|entry| ShareWindow {
                        target_id: entry.target_id.clone(),
                        app_name: entry.app.name.clone(),
                        title: entry.title.clone(),
                        level: level_of(entry.grant.as_ref()),
                    })
                    .collect(),
                expires_at: now_ms() + WAIT.as_millis() as i64,
            };
            let Some(answer) = ui.share_consent.arm(request, expires) else {
                return ComputerShareOutcome::refused(
                    "computer_share_busy",
                    "A window sharing request is already waiting for the user.",
                );
            };
            (offered, answer, expires)
        };

        let _request = RequestGuard { ui, id: &id };
        if !window.is_visible().unwrap_or(false) || window.is_minimized().unwrap_or(false) {
            crate::commands::windows::show_main_window(&ui.app);
        }
        // Tauri 的通用事件监听器也可能收到定向事件，详情只能经主窗口 IPC 读取。
        if let Err(error) = ui
            .app
            .emit_to(OWNER, REQUEST, ShareRequestSignal { request_id: &id })
        {
            tracing::warn!(%error, "[computer] failed to deliver the window sharing request");
            return ComputerShareOutcome::refused(ERROR_UNAVAILABLE, MANUAL);
        }
        let selected = match tokio::time::timeout_at(expires, answer).await {
            Ok(Ok(selected)) if !selected.is_empty() => selected,
            Ok(Err(_)) => return ComputerShareOutcome::refused(ERROR_STOPPED, "The window sharing request was canceled. No window was shared."),
            _ => return ComputerShareOutcome::refused("computer_share_declined", "The user did not approve any window. Do not repeat this request unless the user asks."),
        };

        let _turn = self.turn.lock().await;
        if let Err(outcome) = self.refresh_share_windows(stop).await {
            return outcome;
        }
        let changes = {
            let _gate = self.grant_gate.lock().unwrap_or_else(|p| p.into_inner());
            if self.stopped_since(stop) || !ui.share_consent.is_current(&id) {
                return ComputerShareOutcome::refused(
                    ERROR_STOPPED,
                    "The window sharing request was canceled. No window was shared.",
                );
            }
            let policy = self.policy.lock().unwrap_or_else(|p| p.into_inner());
            if !policy.enabled {
                return ComputerShareOutcome::refused(ERROR_UNAVAILABLE, MANUAL);
            }
            offered
                .iter()
                .filter(|e| selected.contains(&e.target_id))
                .filter(|e| self.check_identity(&e.target_id, &e.identity).is_ok())
                .filter_map(|e| {
                    self.targets
                        .share_confirmed(e, level, now_ms(), &self.me, &policy.blocklist)
                        .ok()
                        .flatten()
                })
                .collect::<Vec<_>>()
        };
        self.announce(&changes);
        if changes.is_empty() {
            return ComputerShareOutcome::refused(ERROR_NO_SUCH_TARGET, STALE);
        }
        let all = changes.len() == ids.len();
        ComputerShareOutcome {
            granted: changes.into_iter().map(|change| change.target_id).collect(),
            note: Some(if all {
                "Use computer_list_windows to check the current grants before continuing."
            } else {
                "Only the returned window IDs were newly shared. Use computer_list_windows to check the current grants before continuing."
            }.into()),
            error: None,
        }
    }

    // 前后各刷新一次；等待用户时不占用驱动，也不阻塞其它窗口操作。
    async fn refresh_share_windows(&self, stop: u64) -> Result<(), ComputerShareOutcome> {
        if self.stopped_since(stop) {
            return Err(ComputerShareOutcome::refused(ERROR_STOPPED, STOPPED_NOTE));
        }
        self.usable()
            .await
            .map_err(|r| ComputerShareOutcome::refused(r.slug, r.note))?;
        let windows = self.backend.list_windows(None).await.map_err(|err| {
            let refusal = self.backend_read_refusal(None, err, stop);
            ComputerShareOutcome::refused(refusal.slug, refusal.note)
        })?;
        self.sweep().await;
        if self.stopped_since(stop) {
            return Err(ComputerShareOutcome::refused(ERROR_STOPPED, STOPPED_NOTE));
        }
        let (_, changes) = self.targets.observe(&windows, None);
        self.announce(&changes);
        Ok(())
    }
}

#[tauri::command]
pub(crate) async fn computer_share_request_current(
    webview: Webview,
    request_id: String,
) -> Result<Option<ShareRequest>, AppCommandError> {
    if webview.label() != OWNER {
        return Ok(None);
    }
    Ok(service(webview.app_handle())?
        .desktop
        .as_ref()
        .and_then(|ui| ui.share_consent.current(&request_id)))
}

#[tauri::command]
pub async fn computer_share_request_decide(
    webview: Webview,
    request_id: String,
    selected_target_ids: Vec<String>,
) -> Result<bool, AppCommandError> {
    if webview.label() != OWNER {
        return Ok(false);
    }
    let service = service(webview.app_handle())?;
    Ok(service
        .desktop
        .as_ref()
        .is_some_and(|ui| ui.share_consent.decide(&request_id, selected_target_ids)))
}
