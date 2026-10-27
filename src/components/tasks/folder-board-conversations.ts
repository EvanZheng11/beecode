import { parseTimestamp } from "@/components/conversations/sidebar-conversation-grouping"
import type { DbConversationSummary, WorkTask } from "@/lib/types"
import { BOARD_COLUMN_IDS, type BoardColumnId } from "./board-columns"

/**
 * 普通会话在看板里的列映射。会话只有四种持久化状态（Rust
 * `ConversationStatus`），没有失败态，所以这里不做任何猜测：
 * 进行中 → 进行中，待审阅 → 等你处理，完成/取消 → 已完成。
 */
const CONVERSATION_COLUMN: Record<string, BoardColumnId> = {
  in_progress: "inProgress",
  pending_review: "attention",
  completed: "done",
  cancelled: "done",
}

/** 未知状态（更新的后端写入的值）归入已完成，避免伪装成待办。 */
export function conversationColumnForStatus(status: string): BoardColumnId {
  return CONVERSATION_COLUMN[status] ?? "done"
}

/** 会话标题/文件夹/智能体/分支参与搜索，口径与任务卡一致：每个词都要命中。 */
export function conversationMatchesSearch(
  conversation: DbConversationSummary,
  terms: string[],
  folderName: string | null
): boolean {
  if (terms.length === 0) return true
  const text = [
    conversation.title,
    folderName,
    conversation.agent_type,
    conversation.git_branch,
  ]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join("\n")
    .toLowerCase()
  return terms.every((term) => text.includes(term))
}

interface ProjectBoardConversationsInput {
  /** 全量会话（工作区 store 里的 `conversations`）。 */
  conversations: readonly DbConversationSummary[]
  /** 全量任务：用来把「已有关联任务」的会话排除掉，含归档/取消的任务。 */
  tasks: readonly WorkTask[]
  /** 当前文件夹；null 时看板不投影任何普通会话。 */
  folderId: number | null
  showCanceled: boolean
  terms: string[]
  folderNames: Map<number, string>
}

/**
 * 把「未关联任务的普通会话」投影成看板列。纯前端投影：不新建任务记录，
 * 也不改会话本身——只看现有数据。
 *
 * - 只取 `kind === "regular"`、属于当前文件夹、且不是某个任务的
 *   `conversation_id` 的会话；同一会话只出现一次。
 * - 已关联任务的会话一律不重复出现（即便那个任务属于别的文件夹或已归档）。
 * - 会话没有归档字段（Rust `conversation` 表只有软删 `deleted_at`），所以
 *   「显示归档」开关只影响任务；取消的会话跟随「显示已取消」。
 */
export function projectBoardConversations({
  conversations,
  tasks,
  folderId,
  showCanceled,
  terms,
  folderNames,
}: ProjectBoardConversationsInput): Record<
  BoardColumnId,
  DbConversationSummary[]
> {
  const grouped: Record<BoardColumnId, DbConversationSummary[]> = {
    todo: [],
    inProgress: [],
    attention: [],
    done: [],
  }
  if (folderId == null) return grouped

  const linked = new Set<number>()
  for (const task of tasks) {
    if (task.conversation_id != null) linked.add(task.conversation_id)
  }

  const seen = new Set<number>()
  for (const conversation of conversations) {
    if (seen.has(conversation.id)) continue
    seen.add(conversation.id)
    if (conversation.kind !== "regular") continue
    if (conversation.folder_id !== folderId) continue
    if (conversation.parent_id != null) continue
    if (linked.has(conversation.id)) continue
    if (conversation.status === "cancelled" && !showCanceled) continue
    const folderName = folderNames.get(conversation.folder_id) ?? null
    if (!conversationMatchesSearch(conversation, terms, folderName)) continue
    grouped[conversationColumnForStatus(conversation.status)].push(conversation)
  }

  for (const column of BOARD_COLUMN_IDS) {
    grouped[column].sort(
      (a, b) => parseTimestamp(b.updated_at) - parseTimestamp(a.updated_at)
    )
  }
  return grouped
}
