/**
 * 完整看板与右侧面板同范围：当前文件夹的任务 + 未关联任务的普通会话。
 * 会话卡只打开原会话，不触碰任务操作。
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { DbConversationSummary, WorkTask } from "@/lib/types"
import { requestTasksFocus } from "@/lib/workbench-focus"

const scene = vi.hoisted(() => ({
  conversations: [] as unknown[],
  openTab: vi.fn(),
  activeFolderId: 1 as number | null,
  allFolders: [
    { id: 1, name: "codeg", alias: null, parent_id: null, kind: "regular" },
    { id: 2, name: "site", alias: null, parent_id: null, kind: "regular" },
    { id: 5, name: "wt_login", alias: null, parent_id: 1, kind: "regular" },
  ],
}))
const view = {
  tasks: [] as WorkTask[],
  loading: false,
  refetch: vi.fn(async () => {}),
  viewMode: "board" as "board" | "list",
}
vi.mock("@/contexts/tasks-view-context", () => ({
  useTasksView: () => view,
}))
vi.mock("@/stores/tab-store", () => ({
  useTabStore: (selector: (s: { openTab: typeof scene.openTab }) => unknown) =>
    selector({ openTab: scene.openTab }),
}))
vi.mock("@/stores/app-workspace-store", () => {
  const state = {
    get activeFolderId() {
      return scene.activeFolderId
    },
    allFolders: scene.allFolders,
    folders: [
      { id: 1, name: "codeg", alias: null, parent_id: null, kind: "regular" },
      { id: 2, name: "site", alias: null, parent_id: null, kind: "regular" },
    ],
    get conversations() {
      return scene.conversations
    },
  }
  const useStore = (selector: (s: typeof state) => unknown) => selector(state)
  return { useAppWorkspaceStore: useStore }
})
vi.mock("@/lib/api", () => ({
  workTaskArchive: vi.fn(),
  workTaskCreate: vi.fn(),
  workTaskDefer: vi.fn(),
  workTaskMergeUnqueue: vi.fn(),
  workTaskReorder: vi.fn(),
  workTaskStart: vi.fn(),
  workTaskUpdate: vi.fn(),
}))
vi.mock("./task-detail-sheet", () => ({ TaskDetailSheet: () => null }))
vi.mock("./task-editor-dialog", () => ({ TaskEditorDialog: () => null }))
vi.mock("./task-merge-dialog", () => ({ TaskMergeDialog: () => null }))
vi.mock("./task-complete-dialog", () => ({ TaskCompleteDialog: () => null }))
vi.mock("./task-deliver-pr-dialog", () => ({
  TaskDeliverPrDialog: () => null,
}))
vi.mock("./task-cancel-dialog", () => ({ TaskCancelDialog: () => null }))
vi.mock("./task-restart-dialog", () => ({ TaskRestartDialog: () => null }))
vi.mock("./task-schedule-dialog", () => ({ TaskScheduleDialog: () => null }))
vi.mock("./task-settings-dialog", () => ({ TaskSettingsDialog: () => null }))
vi.mock("./task-transcript-dialog", () => ({
  TaskTranscriptDialog: () => null,
}))
vi.mock("@/components/shared/folder-select", () => ({
  FolderSelect: ({ value }: { value: number | null }) => (
    <div data-testid="folder-select" data-value={String(value)} />
  ),
}))

import { TasksPage } from "./tasks-page"

function task(overrides: Partial<WorkTask>): WorkTask {
  return {
    id: 1,
    folder_id: 1,
    title: "untitled",
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

function conversation(
  overrides: Partial<DbConversationSummary>
): DbConversationSummary {
  return {
    id: 100,
    folder_id: 1,
    title: "Untitled",
    title_locked: false,
    agent_type: "claude_code",
    status: "completed",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 2,
    child_count: 0,
    created_at: "2026-10-14T00:00:00Z",
    updated_at: "2026-10-14T00:00:00Z",
    pinned_at: null,
    ...overrides,
  }
}

function mount() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TasksPage />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  localStorage.clear()
  scene.openTab.mockClear()
  scene.activeFolderId = 1
  view.viewMode = "board"
  view.tasks = [
    task({ id: 1, folder_id: 1, title: "Fix the login timeout" }),
    task({
      id: 2,
      folder_id: 1,
      title: "Task with a session",
      conversation_id: 101,
    }),
  ]
  scene.conversations = [
    conversation({
      id: 101,
      title: "Linked task session",
      status: "in_progress",
    }),
    conversation({
      id: 102,
      title: "Refactor the parser session",
      status: "in_progress",
    }),
    conversation({
      id: 103,
      folder_id: 2,
      title: "Other project session",
      status: "in_progress",
    }),
    conversation({ id: 104, title: "Chat mode session", kind: "chat" }),
  ]
})

describe("TasksPage conversations", () => {
  it("shows the current folder's unlinked conversations beside its tasks", () => {
    requestTasksFocus({ folderId: 1 })
    mount()
    expect(screen.getByText("Fix the login timeout")).toBeInTheDocument()
    expect(screen.getByText("Refactor the parser session")).toBeInTheDocument()
    // 已关联任务的会话、别的文件夹、chat 会话都不显示。
    expect(screen.queryByText("Linked task session")).not.toBeInTheDocument()
    expect(screen.queryByText("Other project session")).not.toBeInTheDocument()
    expect(screen.queryByText("Chat mode session")).not.toBeInTheDocument()
  })

  it("projects no conversations when the board shows every folder", () => {
    mount()
    expect(screen.getByText("Fix the login timeout")).toBeInTheDocument()
    expect(
      screen.queryByText("Refactor the parser session")
    ).not.toBeInTheDocument()
  })

  it("keeps conversations on the active worktree folder", () => {
    // 活动目录是 worktree 5、看板筛选是项目根 1：会话仍只看 worktree 5。
    scene.activeFolderId = 5
    scene.conversations = [
      conversation({ id: 201, folder_id: 5, title: "Worktree session" }),
      conversation({ id: 202, folder_id: 1, title: "Project root session" }),
    ]
    requestTasksFocus({ folderId: 1 })
    mount()
    expect(screen.getByText("Worktree session")).toBeInTheDocument()
    expect(screen.queryByText("Project root session")).not.toBeInTheDocument()
  })

  it("opens a conversation's original tab without task actions", async () => {
    const user = userEvent.setup()
    requestTasksFocus({ folderId: 1 })
    mount()
    await user.click(screen.getByText("Refactor the parser session"))
    expect(scene.openTab).toHaveBeenCalledWith(1, 102, "claude_code", false)
  })
})
