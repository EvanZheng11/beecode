import type { DbConversationSummary } from "@/lib/types"

export const CONVERSATION_AUTO_ARCHIVE_AFTER_MS = 3 * 24 * 60 * 60 * 1000

export function isConversationAutoArchived(
  conversation: Pick<DbConversationSummary, "updated_at" | "pinned_at">,
  now: number,
  isRunning = false
): boolean {
  return (
    conversation.pinned_at == null &&
    !isRunning &&
    now - Date.parse(conversation.updated_at) >
      CONVERSATION_AUTO_ARCHIVE_AFTER_MS
  )
}
