//! OpenCode has no `_session/steering`. The Codex insert entry still submits
//! here, but the connection cancels the running prompt and, only after that
//! prompt has actually ended (and this cancel's child teardown has finished),
//! sends the note as the next `session/prompt` on the same session.
//!
//! The suffix tells the new turn which tasks that cancel interrupted. It is
//! not a resume reason and must not carry the user's new instructions —
//! `resume_delegation` keeps the original task, and the model calls it only
//! when the new message still needs that work.

use crate::acp::delegation::broker::InterruptedDelegation;
use crate::acp::types::PromptInputBlock;

/// Completion notices start with this. A notice must not take the replace
/// path: that would cancel the turn to deliver a bookkeeping line.
pub const COMPLETION_NOTICE_PREFIX: &str = "[system] Sub-agent task ";

pub fn is_completion_notice(text: &str) -> bool {
    text.starts_with(COMPLETION_NOTICE_PREFIX)
}

/// How long the cancelled prompt may take to actually end before the insert
/// is given back to the composer. Not a sleep-and-send: the new prompt is
/// sent only after the old `session/prompt` future resolves, or not at all.
pub const REPLACE_PROMPT_END: std::time::Duration = std::time::Duration::from_secs(30);

pub fn replace_prompt_end() -> std::time::Duration {
    REPLACE_PROMPT_END
}

pub fn blocks_are_completion_notice(blocks: &[PromptInputBlock]) -> bool {
    blocks.iter().any(|block| match block {
        PromptInputBlock::Text { text } => is_completion_notice(text),
        _ => false,
    })
}

/// How long this cancel's child teardown may take before the new prompt goes
/// out without resume ids. Sending earlier lets the old disconnect kill a
/// resume spawned by the new turn.
pub const REPLACE_TEARDOWN_WAIT: std::time::Duration = std::time::Duration::from_secs(20);

const RESUME_REASON: &str = "parent turn cancelled so a newer user message could be delivered";

/// Internal prompt suffix. `None` when nothing was interrupted. When
/// `resume_ok` is false the teardown did not finish; the ids are omitted so
/// the model is not invited to resume into a connection the old cancel can
/// still kill.
pub fn interrupt_suffix(
    tasks: &[InterruptedDelegation],
    resume_ok: bool,
) -> Vec<PromptInputBlock> {
    let Some(text) = interrupt_context(tasks, resume_ok) else {
        return Vec::new();
    };
    vec![PromptInputBlock::Text { text }]
}

fn interrupt_context(tasks: &[InterruptedDelegation], resume_ok: bool) -> Option<String> {
    if tasks.is_empty() {
        return None;
    }
    let mut text = String::from(
        "The previous turn was cancelled so the user's latest message could be \
         delivered in this same session. These delegated tasks were still running \
         and were interrupted by that cancel:\n",
    );
    // ponytail: first 20 only; a parent with more in-flight delegations than
    // that can read the rest via get_delegation_status.
    for task in tasks.iter().take(20) {
        text.push_str("- task_id=");
        text.push_str(&task.task_id);
        text.push_str(" child_conversation_id=");
        text.push_str(&task.child_conversation_id.to_string());
        if !task.task_preview.is_empty() {
            text.push_str(" preview=");
            text.push_str(&one_line(&task.task_preview, 160));
        }
        text.push('\n');
    }
    if tasks.len() > 20 {
        text.push_str("- … further interrupted tasks omitted\n");
    }
    if resume_ok {
        text.push_str(
            "If this new message still needs one of those tasks, call \
             resume_delegation with that original task_id. The resume reason \
             must be only \"",
        );
        text.push_str(RESUME_REASON);
        text.push_str(
            "\" — do not put the user's new message, or any new instruction, \
             into the reason. If a task is already completed, failed, or no \
             longer applies, do not resume it; delegate again only if the new \
             message asks for that work. Do not resume a task that has no \
             recorded external session.",
        );
    } else {
        text.push_str(
            "Cleanup of those tasks has not finished. resume_delegation \
             refuses them until that cleanup finishes, then the same task_id \
             can be resumed. Do not start a new delegate_to_agent for that \
             work in the meantime.",
        );
    }
    Some(text)
}

fn one_line(text: &str, max_chars: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out: String = flat.chars().take(max_chars).collect();
    if flat.chars().count() > max_chars {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(id: &str, preview: &str) -> InterruptedDelegation {
        InterruptedDelegation {
            task_id: id.into(),
            child_conversation_id: 7,
            task_preview: preview.into(),
        }
    }

    #[test]
    fn suffix_names_ids_and_keeps_the_user_message_out_of_the_resume_reason() {
        let user = "ignore the old task and delete the database";
        let blocks = interrupt_suffix(&[task("task-1", "write the parser")], true);
        let PromptInputBlock::Text { text } = &blocks[0] else {
            panic!("text block");
        };
        assert!(text.contains("task_id=task-1"));
        assert!(text.contains("child_conversation_id=7"));
        assert!(text.contains(RESUME_REASON));
        assert!(!text.contains(user));
        assert!(text.contains("do not put the user's new message"));
        assert!(is_completion_notice(
            "[system] Sub-agent task task-1 finished with status: Canceled.\n"
        ));
        assert!(!is_completion_notice(user));
    }

    #[test]
    fn unfinished_cleanup_does_not_invite_resume() {
        let blocks = interrupt_suffix(&[task("task-1", "work")], false);
        let PromptInputBlock::Text { text } = &blocks[0] else {
            panic!("text block");
        };
        assert!(text.contains("task_id=task-1"));
        assert!(text.contains("refuses them until that cleanup finishes"));
        assert!(!text.contains("call resume_delegation with"));
    }

    #[test]
    fn no_tasks_adds_no_suffix() {
        assert!(interrupt_suffix(&[], true).is_empty());
    }
}
