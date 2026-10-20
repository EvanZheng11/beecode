//! `DelegationEventEmitter` — broker capability for surfacing
//! `AcpEvent::DelegationStarted` / `DelegationCompleted` to the parent's
//! event stream.
//!
//! Parallel to [`crate::acp::delegation::meta_writer::DelegationMetaWriter`]:
//! both abstract over the broker's access to the parent connection's
//! `(state, emitter)` pair so the broker can be unit-tested without spinning
//! up a `ConnectionManager`. Together they form the broker's two-output
//! capability surface — meta writes patch the persisted `ToolCallState`,
//! event emits drive the live frontend `DelegationContext`.
//!
//! The broker calls `emit_started` once from the start path — right after the
//! child is spawned and its first prompt is in flight — and `emit_completed`
//! from every terminal path:
//!
//! 1. `complete_call` — happy path (kind=ok) and error completions
//!    (kind=err) propagated by the listener/lifecycle.
//! 2. `cancel_by_external_handle` — MCP `notifications/cancelled`
//!    routed from the companion drains the pending entry; emits
//!    `Err{error_code: "canceled"}`.
//! 3. `handle_request` completion-channel-dropped — emits `Err{error_code: "canceled"}`.
//! 4. `cancel_by_child_connection` — emits `Err{error_code: "canceled"}` for
//!    every drained pending entry whose child matches.
//! 5. `cancel_by_parent` — emits `Err{error_code: "canceled"}` for every
//!    drained pending entry whose parent matches.
//!
//! Emits are skipped when the broker is operating on a synthetic
//! `parent_tool_use_id` (the `"delegation-*"` UUID fallback) because no
//! `tool_call_id`-keyed UI exists to receive them — same guard as the meta
//! writer. The frontend's snapshot path will still recover state from the
//! broker's meta write.

use async_trait::async_trait;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use crate::acp::delegation::types::{AssistantRef, TaskStatus};
use crate::acp::error::AcpError;
use crate::acp::manager::ConnectionManager;
use crate::acp::types::{AcpEvent, DelegationResultSummary, PromptInputBlock};
use crate::models::AgentType;
use crate::web::event_bridge::emit_with_state;

/// Capability the broker uses to publish `AcpEvent::DelegationCompleted`
/// against the parent connection's event stream.
///
/// Errors are swallowed at the impl boundary — same rationale as
/// `DelegationMetaWriter`. The broker must finish its pending-table
/// cleanup regardless of whether the parent connection is still around to
/// observe the event.
#[async_trait]
pub trait DelegationEventEmitter: Send + Sync {
    /// Publish `AcpEvent::DelegationStarted` on the parent's stream once the
    /// child is spawned and its prompt is in flight. Mirrors `emit_completed`
    /// so both lifecycle ends ride the same parent-stream fanout — the frontend
    /// `DelegationContext` then receives both via the parent's per-connection
    /// attach stream in web/server mode, not only via the desktop firehose.
    /// `task_preview` / `task_id` ride the event so the frontend binding can
    /// label the card (task text + correlation id) even when the parent tool
    /// call's `raw_input` never carries the arguments (Cursor's identity-less
    /// MCP announcements).
    #[allow(clippy::too_many_arguments)]
    async fn emit_started(
        &self,
        parent_connection_id: &str,
        parent_tool_use_id: &str,
        child_connection_id: &str,
        child_conversation_id: i32,
        agent_type: AgentType,
        assistant: Option<&AssistantRef>,
        task_preview: &str,
        task_id: &str,
    );

    #[allow(clippy::too_many_arguments)]
    async fn emit_completed(
        &self,
        parent_connection_id: &str,
        parent_tool_use_id: &str,
        child_connection_id: &str,
        child_conversation_id: i32,
        agent_type: AgentType,
        assistant: Option<&AssistantRef>,
        result: DelegationResultSummary,
    );
}

/// Default emitter used when the broker is constructed via the short-form
/// `DelegationBroker::new`. Silently drops every emit — most broker tests
/// observe behavior via outcomes + pending accounting + meta writes, not
/// event fanout. Tests that DO assert on the event lifecycle wire
/// `MockEventEmitter` via `with_writers`.
#[derive(Default, Clone)]
pub struct NoopEventEmitter;

#[async_trait]
impl DelegationEventEmitter for NoopEventEmitter {
    #[allow(clippy::too_many_arguments)]
    async fn emit_started(
        &self,
        _parent_connection_id: &str,
        _parent_tool_use_id: &str,
        _child_connection_id: &str,
        _child_conversation_id: i32,
        _agent_type: AgentType,
        _assistant: Option<&AssistantRef>,
        _task_preview: &str,
        _task_id: &str,
    ) {
    }

    async fn emit_completed(
        &self,
        _parent_connection_id: &str,
        _parent_tool_use_id: &str,
        _child_connection_id: &str,
        _child_conversation_id: i32,
        _agent_type: AgentType,
        _assistant: Option<&AssistantRef>,
        _result: DelegationResultSummary,
    ) {
    }
}

/// Production impl backed by `ConnectionManager`. Resolves the parent
/// connection's `(state, emitter)` and routes the `DelegationCompleted`
/// event through `emit_with_state` so it lands on the same fanout path
/// as every other ACP event from that connection.
///
/// A missing parent connection (user disconnected mid-delegation, parent
/// already torn down by another path) becomes a silent no-op — the broker
/// still needs to drain its pending table even when no one is listening.
#[derive(Clone)]
pub struct ConnectionManagerEventEmitter {
    pub manager: Arc<ConnectionManager>,
}

#[async_trait]
impl DelegationEventEmitter for ConnectionManagerEventEmitter {
    #[allow(clippy::too_many_arguments)]
    async fn emit_started(
        &self,
        parent_connection_id: &str,
        parent_tool_use_id: &str,
        child_connection_id: &str,
        child_conversation_id: i32,
        agent_type: AgentType,
        assistant: Option<&AssistantRef>,
        task_preview: &str,
        task_id: &str,
    ) {
        let Some((state_arc, emitter)) = self
            .manager
            .get_state_and_emitter(parent_connection_id)
            .await
        else {
            return;
        };
        emit_with_state(
            &state_arc,
            &emitter,
            AcpEvent::DelegationStarted {
                parent_connection_id: parent_connection_id.to_string(),
                parent_tool_use_id: parent_tool_use_id.to_string(),
                child_connection_id: child_connection_id.to_string(),
                child_conversation_id,
                agent_type,
                task_preview: task_preview.to_string(),
                task_id: task_id.to_string(),
                assistant_id: assistant.map(|a| a.id),
                assistant_name: assistant.map(|a| a.name.clone()),
            },
        )
        .await;
    }

    async fn emit_completed(
        &self,
        parent_connection_id: &str,
        parent_tool_use_id: &str,
        child_connection_id: &str,
        child_conversation_id: i32,
        agent_type: AgentType,
        assistant: Option<&AssistantRef>,
        result: DelegationResultSummary,
    ) {
        let Some((state_arc, emitter)) = self
            .manager
            .get_state_and_emitter(parent_connection_id)
            .await
        else {
            return;
        };
        emit_with_state(
            &state_arc,
            &emitter,
            AcpEvent::DelegationCompleted {
                parent_connection_id: parent_connection_id.to_string(),
                parent_tool_use_id: parent_tool_use_id.to_string(),
                child_connection_id: child_connection_id.to_string(),
                child_conversation_id,
                agent_type,
                result,
                assistant_id: assistant.map(|a| a.id),
                assistant_name: assistant.map(|a| a.name.clone()),
            },
        )
        .await;
    }
}

// ─── Completion notice ───────────────────────────────────────────────────
//
// The broker resolves every terminal path through `emit_completed`, so that is
// where the parent's LLM is told the task is done. Without the notice the
// parent can only poll `get_delegation_status`, which means it sits idle for a
// whole poll interval after a child finishes. The notice rides the channels a
// human's mid-turn note already uses, so it lands in the parent's transcript
// (visible to the user too) instead of being invisible side-channel state.

/// Where a completion notice landed: mid-turn steering (the parent's current
/// turn keeps running) or a fresh prompt (the parent was idle / has no
/// steering channel).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotifyDelivery {
    Steering,
    Prompt,
}

impl NotifyDelivery {
    /// Wire word for `message: "delivered via <...>"`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Steering => "steering",
            Self::Prompt => "prompt",
        }
    }
}

/// Why a completion notice did not go out. `Display` doubles as the `message`
/// the manual "notify main agent" endpoint hands back, so the strings stay
/// short and user-facing.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum NotifyError {
    #[error("already notified")]
    AlreadyNotified,
    #[error("task not found")]
    TaskNotFound,
    #[error("task is still running")]
    StillRunning,
    #[error("parent session is not connected")]
    NoParentConnection,
    #[error("notification unavailable")]
    Unavailable,
    #[error("{0}")]
    DeliveryFailed(String),
}

/// Task ids whose completion notice already went out. The broker's terminal
/// path and the manual button share one instance, so a task notifies the
/// parent LLM at most once — whichever gets there first.
///
/// `try_claim` is the gate: it records the id and refuses any later attempt.
/// `release` drops the claim when delivery failed, which keeps a failed notice
/// retryable from the manual button.
#[derive(Default)]
pub struct NotifiedTasks {
    ids: Mutex<VecDeque<String>>,
}

/// Upper bound on remembered ids. Only terminal tasks enter, so the ring just
/// has to outlive a session's worth of delegations; past it the OLDEST id is
/// forgotten (and could, in theory, notify twice).
const NOTIFIED_TASKS_CAP: usize = 512;

impl NotifiedTasks {
    /// Record `task_id` and return `true`, or return `false` when it was
    /// already notified. One critical section, so two concurrent callers can
    /// never both win.
    pub fn try_claim(&self, task_id: &str) -> bool {
        // A poison cannot happen here (nothing in this section panics), but a
        // notice must never take the caller down with it, so recover instead.
        let mut ids = self.ids.lock().unwrap_or_else(|e| e.into_inner());
        if ids.iter().any(|id| id == task_id) {
            return false;
        }
        ids.push_back(task_id.to_string());
        while ids.len() > NOTIFIED_TASKS_CAP {
            ids.pop_front();
        }
        true
    }

    /// Forget a claim so a later attempt can retry it (failed delivery).
    pub fn release(&self, task_id: &str) {
        let mut ids = self.ids.lock().unwrap_or_else(|e| e.into_inner());
        ids.retain(|id| id != task_id);
    }
}

/// Cap on the result-summary line of a notice. The parent LLM reads this
/// inline; the full text is one `get_delegation_status` away, so a preview is
/// enough — and it keeps the notice far below `MAX_FEEDBACK_CHARS` (4096,
/// `acp::feedback`), which is what the steering channel enforces.
const NOTICE_SUMMARY_CHARS: usize = 300;

/// Hard ceiling on one notice delivery. See `CompletionNotifier::deliver`: the
/// notice runs on the broker's terminal path, so a stuck parent must not hold
/// the child's teardown open.
const NOTICE_DELIVERY_TIMEOUT_SECS: u64 = 10;

/// Render the notice the parent LLM receives. `summary` is the result preview
/// (completed) or `error_code: <code>` (failed / canceled). Newlines are
/// flattened so the three-line shape survives whatever the child wrote.
pub fn build_completion_notice(task_id: &str, status: TaskStatus, summary: &str) -> String {
    let status = match status {
        TaskStatus::Completed => "Completed",
        TaskStatus::Failed => "Failed",
        TaskStatus::Canceled => "Canceled",
        // Running / Unknown never reach a notice; never claim success for them.
        TaskStatus::Running | TaskStatus::Unknown => "Unknown",
    };
    let summary = one_line_preview(summary);
    format!(
        "[system] Sub-agent task {task_id} finished with status: {status}.\n{summary}\nCall get_delegation_status with task_ids [\"{task_id}\"] to read the full result. Do not start a new delegate_to_agent call for this task."
    )
}

/// Project a terminal event summary onto the notice's `(status, detail)` pair.
/// `canceled` is the broker's wire-stable code for every cancel path.
pub fn notice_from_summary(result: &DelegationResultSummary) -> (TaskStatus, String) {
    match result {
        DelegationResultSummary::Ok { text_preview, .. } => (
            TaskStatus::Completed,
            text_preview.clone().unwrap_or_default(),
        ),
        DelegationResultSummary::Err { error_code } if error_code == "canceled" => (
            TaskStatus::Canceled,
            format!("error_code: {error_code}"),
        ),
        DelegationResultSummary::Err { error_code } => (
            TaskStatus::Failed,
            format!("error_code: {error_code}"),
        ),
    }
}

/// Collapse `text` to ONE line of at most [`NOTICE_SUMMARY_CHARS`] characters,
/// so a multi-line child answer cannot break the notice's structure.
fn one_line_preview(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.is_empty() {
        return "(no text output)".to_string();
    }
    let mut preview: String = flat.chars().take(NOTICE_SUMMARY_CHARS).collect();
    if flat.chars().count() > NOTICE_SUMMARY_CHARS {
        preview.push_str("...");
    }
    preview
}

/// Delivers completion notices to a parent conversation's LLM. Steering first
/// (the parent's turn keeps going — no extra turn), a plain prompt when the
/// parent is idle or has no steering channel.
pub struct CompletionNotifier {
    manager: Arc<ConnectionManager>,
    notified: NotifiedTasks,
}

impl CompletionNotifier {
    pub fn new(manager: Arc<ConnectionManager>) -> Self {
        Self {
            manager,
            notified: NotifiedTasks::default(),
        }
    }

    /// Fire-and-forget variant for the autorun path: the broker's terminal
    /// teardown must finish no matter what happens here, so a failed notice is
    /// a log line, never an error at the caller.
    pub async fn notify_quietly(
        &self,
        parent_connection_id: &str,
        task_id: &str,
        status: TaskStatus,
        summary: &str,
    ) {
        match self
            .notify(parent_connection_id, task_id, status, summary)
            .await
        {
            Ok(delivery) => tracing::info!(
                task_id = %task_id,
                parent_connection_id = %parent_connection_id,
                delivery = delivery.as_str(),
                "已向主智能体投递子任务完成通知"
            ),
            // A duplicate is the normal outcome of "auto notice won the race
            // with the manual button" — not a warning.
            Err(NotifyError::AlreadyNotified) => tracing::debug!(
                task_id = %task_id,
                "子任务完成通知此前已投递，跳过"
            ),
            Err(err) => tracing::warn!(
                task_id = %task_id,
                parent_connection_id = %parent_connection_id,
                error = %err,
                "子任务完成通知投递失败"
            ),
        }
    }

    /// Deliver the terminal notice for `task_id` to the live connection
    /// `parent_connection_id`, claiming the dedupe slot first. The claim is
    /// released again when delivery fails, so the manual button can retry.
    pub async fn notify(
        &self,
        parent_connection_id: &str,
        task_id: &str,
        status: TaskStatus,
        summary: &str,
    ) -> Result<NotifyDelivery, NotifyError> {
        let task_id = task_id.trim();
        if task_id.is_empty() {
            return Err(NotifyError::TaskNotFound);
        }
        if parent_connection_id.is_empty() {
            return Err(NotifyError::NoParentConnection);
        }
        if !self.notified.try_claim(task_id) {
            return Err(NotifyError::AlreadyNotified);
        }
        let text = build_completion_notice(task_id, status, summary);
        match self.deliver(parent_connection_id, &text).await {
            Ok(delivery) => Ok(delivery),
            Err(err) => {
                self.notified.release(task_id);
                Err(err)
            }
        }
    }

    /// Deliver to whatever live connection currently owns
    /// `parent_conversation_id`. This is the DB-fallback path: the task's broker
    /// entry aged out, so only the child row's parent conversation is known.
    pub async fn notify_conversation(
        &self,
        parent_conversation_id: i32,
        task_id: &str,
        status: TaskStatus,
        summary: &str,
    ) -> Result<NotifyDelivery, NotifyError> {
        let Some(connection_id) = self
            .manager
            .find_connection_by_conversation_id(parent_conversation_id)
            .await
        else {
            return Err(NotifyError::NoParentConnection);
        };
        self.notify(&connection_id, task_id, status, summary).await
    }

    async fn deliver(
        &self,
        parent_connection_id: &str,
        text: &str,
    ) -> Result<NotifyDelivery, NotifyError> {
        // Bounded: this runs on the broker's terminal path (before the child is
        // torn down) and `submit_feedback` waits on an adapter round-trip while
        // `send_prompt` waits on the parent's prompt lock. An unresponsive
        // parent must not stall the teardown it is merely being notified about.
        match tokio::time::timeout(
            std::time::Duration::from_secs(NOTICE_DELIVERY_TIMEOUT_SECS),
            self.deliver_inner(parent_connection_id, text),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => Err(NotifyError::DeliveryFailed(format!(
                "timed out after {NOTICE_DELIVERY_TIMEOUT_SECS}s"
            ))),
        }
    }

    async fn deliver_inner(
        &self,
        parent_connection_id: &str,
        text: &str,
    ) -> Result<NotifyDelivery, NotifyError> {
        // Pick the channel from the parent's CURRENT turn state, instead of
        // letting `submit_feedback` fail its way there. A steer that arrives as
        // the parent's turn ends is accepted but never consumed: the note lands
        // in the composer as an unsent draft and the parent keeps waiting —
        // exactly the stall this notice exists to remove. An idle parent gets a
        // prompt, which is what actually starts the turn that reads it.
        let turn_in_flight = match self.manager.get_state(parent_connection_id).await {
            Some(state) => state.read().await.turn_in_flight,
            // No such connection: let the prompt path report it.
            None => false,
        };
        if turn_in_flight {
            match self
                .manager
                .submit_feedback(parent_connection_id, text.to_string(), None)
                .await
            {
                Ok(_) => return Ok(NotifyDelivery::Steering),
                // The turn ended between the read and the steer, or this adapter
                // has no steering channel. A prompt is the remaining channel.
                Err(AcpError::NoActiveTurn) | Err(AcpError::FeedbackDisabled) => {}
                // The parent connection is gone, or the note was rejected: no
                // fallback can help, report why.
                Err(e) => return Err(NotifyError::DeliveryFailed(e.to_string())),
            }
        }
        self.manager
            .send_prompt(
                parent_connection_id,
                vec![PromptInputBlock::Text {
                    text: text.to_string(),
                }],
            )
            .await
            .map(|_| NotifyDelivery::Prompt)
            .map_err(|e| NotifyError::DeliveryFailed(e.to_string()))
    }
}

#[cfg(any(test, feature = "test-utils"))]
pub mod mock {
    use super::*;
    use tokio::sync::Mutex;

    /// Records every emit so broker tests can assert the event lifecycle
    /// (one emit per drained pending entry, never doubled, correct
    /// `result_summary` per terminal path). No-op on the publishing side —
    /// the broker is the unit under test, not the event fanout.
    #[derive(Default)]
    pub struct MockEventEmitter {
        pub calls: Mutex<Vec<EmitCall>>,
        pub started_calls: Mutex<Vec<EmitStartedCall>>,
    }

    #[derive(Debug, Clone)]
    pub struct EmitCall {
        pub parent_connection_id: String,
        pub parent_tool_use_id: String,
        pub child_connection_id: String,
        pub child_conversation_id: i32,
        pub agent_type: AgentType,
        pub assistant: Option<AssistantRef>,
        pub result: DelegationResultSummary,
    }

    #[derive(Debug, Clone)]
    pub struct EmitStartedCall {
        pub parent_connection_id: String,
        pub parent_tool_use_id: String,
        pub child_connection_id: String,
        pub child_conversation_id: i32,
        pub agent_type: AgentType,
        pub assistant: Option<AssistantRef>,
        pub task_preview: String,
        pub task_id: String,
    }

    impl MockEventEmitter {
        pub fn new() -> Self {
            Self::default()
        }

        pub async fn snapshot(&self) -> Vec<EmitCall> {
            self.calls.lock().await.clone()
        }

        pub async fn count(&self) -> usize {
            self.calls.lock().await.len()
        }

        pub async fn started_snapshot(&self) -> Vec<EmitStartedCall> {
            self.started_calls.lock().await.clone()
        }

        pub async fn started_count(&self) -> usize {
            self.started_calls.lock().await.len()
        }
    }

    #[async_trait]
    impl DelegationEventEmitter for MockEventEmitter {
        #[allow(clippy::too_many_arguments)]
        async fn emit_started(
            &self,
            parent_connection_id: &str,
            parent_tool_use_id: &str,
            child_connection_id: &str,
            child_conversation_id: i32,
            agent_type: AgentType,
            assistant: Option<&AssistantRef>,
            task_preview: &str,
            task_id: &str,
        ) {
            self.started_calls.lock().await.push(EmitStartedCall {
                parent_connection_id: parent_connection_id.to_string(),
                parent_tool_use_id: parent_tool_use_id.to_string(),
                child_connection_id: child_connection_id.to_string(),
                child_conversation_id,
                agent_type,
                assistant: assistant.cloned(),
                task_preview: task_preview.to_string(),
                task_id: task_id.to_string(),
            });
        }

        async fn emit_completed(
            &self,
            parent_connection_id: &str,
            parent_tool_use_id: &str,
            child_connection_id: &str,
            child_conversation_id: i32,
            agent_type: AgentType,
            assistant: Option<&AssistantRef>,
            result: DelegationResultSummary,
        ) {
            self.calls.lock().await.push(EmitCall {
                parent_connection_id: parent_connection_id.to_string(),
                parent_tool_use_id: parent_tool_use_id.to_string(),
                child_connection_id: child_connection_id.to_string(),
                child_conversation_id,
                agent_type,
                assistant: assistant.cloned(),
                result,
            });
        }
    }
}

#[cfg(test)]
mod completion_notice_tests {
    use super::*;

    #[test]
    fn a_second_notification_for_the_same_task_is_blocked() {
        let notified = NotifiedTasks::default();
        assert!(notified.try_claim("task-1"));
        assert!(
            !notified.try_claim("task-1"),
            "the same task may only notify the parent once"
        );
        assert!(notified.try_claim("task-2"), "another task is unaffected");
    }

    #[test]
    fn a_failed_delivery_stays_retryable() {
        let notified = NotifiedTasks::default();
        assert!(notified.try_claim("task-1"));
        notified.release("task-1");
        assert!(notified.try_claim("task-1"), "a release frees the slot");
    }

    #[test]
    fn the_ring_forgets_the_oldest_ids() {
        let notified = NotifiedTasks::default();
        for i in 0..(NOTIFIED_TASKS_CAP + 1) {
            assert!(notified.try_claim(&format!("t{i}")));
        }
        assert!(!notified.try_claim(&format!("t{}", NOTIFIED_TASKS_CAP - 1)));
        assert!(notified.try_claim("t0"), "the evicted id may notify again");
    }

    #[test]
    fn the_notice_keeps_its_three_line_shape() {
        let text = build_completion_notice(
            "task-1",
            TaskStatus::Completed,
            "line one\nline two\t  three",
        );
        assert_eq!(text.lines().count(), 3);
        assert!(text.contains("status: Completed."));
        assert!(text.contains("line one line two three"));
        assert!(text.contains("task_ids [\"task-1\"]"));
    }

    #[test]
    fn a_long_or_empty_result_is_bounded() {
        let long = "x".repeat(NOTICE_SUMMARY_CHARS + 50);
        let text = build_completion_notice("task-1", TaskStatus::Failed, &long);
        assert!(text.chars().count() < crate::acp::feedback::MAX_FEEDBACK_CHARS);

        let empty = build_completion_notice("task-1", TaskStatus::Completed, "");
        assert!(empty.contains("(no text output)"));

        let failed = notice_from_summary(&DelegationResultSummary::Err {
            error_code: "child_max_tokens".into(),
        });
        assert_eq!(failed, (TaskStatus::Failed, "error_code: child_max_tokens".into()));
    }
}
