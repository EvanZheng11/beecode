import { describe, expect, it } from "vitest"
import type { DbConversationSummary, WorkTask } from "@/lib/types"
import {
  conversationColumnForStatus,
  conversationMatchesSearch,
  projectBoardConversations,
} from "./folder-board-conversations"

function conversation(
  overrides: Partial<DbConversationSummary>
): DbConversationSummary {
  return {
    id: 1,
    folder_id: 1,
    title: "Session",
    title_locked: false,
    agent_type: "claude_code",
    status: "completed",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 1,
    child_count: 0,
    created_at: "2026-10-14T00:00:00Z",
    updated_at: "2026-10-14T00:00:00Z",
    pinned_at: null,
    ...overrides,
  }
}

function task(overrides: Partial<WorkTask>): WorkTask {
  return {
    id: 1,
    folder_id: 1,
    title: "task",
    config: null,
    status: "todo",
    failure_reason: null,
    last_error: null,
    run_seq: 0,
    sort_order: 1,
    worktree_folder_id: null,
    conversation_id: null,
    connection_id: null,
    base_branch: null,
    base_sha: null,
    work_branch: null,
    cleanup_state: null,
    verdict: null,
    result_summary: null,
    files_changed: null,
    additions: null,
    deletions: null,
    merge_commit: null,
    preflight: null,
    archived_at: null,
    scheduled_at: null,
    created_at: "2026-10-14T00:00:00Z",
    updated_at: "2026-10-14T00:00:00Z",
    started_at: null,
    settled_at: null,
    finished_at: null,
    ...overrides,
  }
}

const folderNames = new Map([[1, "codeg"]])

function project(
  conversations: DbConversationSummary[],
  overrides: {
    tasks?: WorkTask[]
    folderId?: number | null
    showCanceled?: boolean
    terms?: string[]
  } = {}
) {
  return projectBoardConversations({
    conversations,
    tasks: overrides.tasks ?? [],
    folderId: overrides.folderId === undefined ? 1 : overrides.folderId,
    showCanceled: overrides.showCanceled ?? true,
    terms: overrides.terms ?? [],
    folderNames,
  })
}

describe("conversationColumnForStatus", () => {
  it("maps the persisted conversation statuses onto board columns", () => {
    expect(conversationColumnForStatus("in_progress")).toBe("inProgress")
    expect(conversationColumnForStatus("pending_review")).toBe("attention")
    expect(conversationColumnForStatus("completed")).toBe("done")
    expect(conversationColumnForStatus("cancelled")).toBe("done")
    // 更新的后端写入的未知状态不伪装成待办。
    expect(conversationColumnForStatus("archived")).toBe("done")
  })
})

describe("conversationMatchesSearch", () => {
  it("matches every term against title, folder, agent and branch", () => {
    const session = conversation({ title: "Refactor parser", git_branch: "x" })
    expect(conversationMatchesSearch(session, [], null)).toBe(true)
    expect(conversationMatchesSearch(session, ["parser"], null)).toBe(true)
    expect(conversationMatchesSearch(session, ["codeg"], "codeg")).toBe(true)
    expect(conversationMatchesSearch(session, ["claude"], null)).toBe(true)
    expect(
      conversationMatchesSearch(session, ["parser", "site"], "codeg")
    ).toBe(false)
  })
})

describe("projectBoardConversations", () => {
  it("projects only the current folder's regular, unlinked conversations", () => {
    const grouped = project(
      [
        conversation({ id: 1, folder_id: 1, status: "in_progress" }),
        conversation({ id: 2, folder_id: 1, status: "pending_review" }),
        conversation({ id: 3, folder_id: 1, status: "completed" }),
        conversation({ id: 4, folder_id: 2, status: "in_progress" }),
        conversation({ id: 5, folder_id: 1, kind: "delegate" }),
        conversation({ id: 6, folder_id: 1, kind: "chat" }),
        // 已关联任务的会话不重复出现，即便任务是归档的。
        conversation({ id: 7, folder_id: 1, status: "in_progress" }),
      ],
      {
        tasks: [
          task({
            id: 10,
            conversation_id: 7,
            archived_at: "2026-10-14T00:00:00Z",
          }),
        ],
      }
    )
    expect(grouped.inProgress.map((c) => c.id)).toEqual([1])
    expect(grouped.attention.map((c) => c.id)).toEqual([2])
    expect(grouped.done.map((c) => c.id)).toEqual([3])
    expect(grouped.todo).toEqual([])
  })

  it("shows a conversation once even when the list carries it twice", () => {
    const grouped = project([conversation({ id: 1 }), conversation({ id: 1 })])
    expect(grouped.done).toHaveLength(1)
  })

  it("sorts each column freshest-first", () => {
    const grouped = project([
      conversation({ id: 1, updated_at: "2026-10-14T01:00:00Z" }),
      conversation({ id: 2, updated_at: "2026-10-14T03:00:00Z" }),
      conversation({ id: 3, updated_at: "2026-10-14T02:00:00Z" }),
    ])
    expect(grouped.done.map((c) => c.id)).toEqual([2, 3, 1])
  })

  it("hides cancelled conversations with the canceled toggle", () => {
    const conversations = [
      conversation({ id: 1, status: "cancelled" }),
      conversation({ id: 2, status: "completed" }),
    ]
    expect(project(conversations, { showCanceled: true }).done).toHaveLength(2)
    expect(
      project(conversations, { showCanceled: false }).done.map((c) => c.id)
    ).toEqual([2])
  })

  it("applies the search terms", () => {
    const grouped = project(
      [
        conversation({ id: 1, title: "Refactor parser" }),
        conversation({ id: 2, title: "Release notes" }),
      ],
      { terms: ["parser"] }
    )
    expect(grouped.done.map((c) => c.id)).toEqual([1])
  })

  it("projects nothing without a current folder", () => {
    const grouped = project([conversation({ id: 1 })], { folderId: null })
    expect(Object.values(grouped).flat()).toEqual([])
  })
})
