/**
 * 右侧面板的任务页签：只看当前文件夹——任务加上未关联任务的普通会话，按分区
 * 纵向堆叠——卡片、编辑器和对话框与看板一致；归档筛选就在页签里操作。
 */
import { act, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import {
  resetTasksBoardFilterCacheForTests,
  saveTasksBoardFilter,
} from "@/lib/tasks-board-filter-storage"
import type { DbConversationSummary, WorkTask } from "@/lib/types"
import { peekTasksFocus } from "@/lib/workbench-focus"

const scene = vi.hoisted(() => ({
  projectFolderId: 1 as number | null,
  activeFolderId: 1 as number | null,
  setRoute: vi.fn(),
  openTab: vi.fn(),
  allFolders: [
    { id: 1, name: "codeg", alias: null, parent_id: null, kind: "regular" },
    { id: 2, name: "site", alias: null, parent_id: null, kind: "regular" },
  ],
  conversations: [] as unknown[],
}))
const view = {
  tasks: [] as WorkTask[],
  loading: false,
  refetch: vi.fn(async () => {}),
}

vi.mock("@/contexts/tasks-view-context", () => ({
  useTasksView: () => view,
}))
vi.mock("@/hooks/use-active-project-folder", () => ({
  useActiveProjectFolderId: () => scene.projectFolderId,
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ setRoute: scene.setRoute }),
  useOptionalWorkbenchRoute: () => ({ setRoute: scene.setRoute }),
}))
vi.mock("@/stores/tab-store", () => ({
  useTabStore: (selector: (s: { openTab: typeof scene.openTab }) => unknown) =>
    selector({ openTab: scene.openTab }),
}))
vi.mock("@/stores/app-workspace-store", () => {
  const state = {
    allFolders: scene.allFolders,
    get activeFolderId() {
      return scene.activeFolderId
    },
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
  workTaskStart: vi.fn(),
  workTaskUpdate: vi.fn(),
}))
// The editor reports what it was opened with; every other dialog stays shut.
vi.mock("@/components/tasks/task-editor-dialog", () => ({
  TaskEditorDialog: ({
    open,
    defaultFolderId,
  }: {
    open: boolean
    defaultFolderId: number | null
  }) =>
    open ? (
      <div role="dialog" data-default-folder={String(defaultFolderId)}>
        editor
      </div>
    ) : null,
}))
vi.mock("@/components/tasks/task-detail-sheet", () => ({
  TaskDetailSheet: ({
    open,
    task,
  }: {
    open: boolean
    task: WorkTask | null
  }) => (open && task ? <div role="dialog">{`detail #${task.id}`}</div> : null),
}))
vi.mock("@/components/tasks/task-merge-dialog", () => ({
  TaskMergeDialog: () => null,
}))
vi.mock("@/components/tasks/task-complete-dialog", () => ({
  TaskCompleteDialog: () => null,
}))
vi.mock("@/components/tasks/task-deliver-pr-dialog", () => ({
  TaskDeliverPrDialog: () => null,
}))
vi.mock("@/components/tasks/task-cancel-dialog", () => ({
  TaskCancelDialog: () => null,
}))
vi.mock("@/components/tasks/task-restart-dialog", () => ({
  TaskRestartDialog: () => null,
}))
vi.mock("@/components/tasks/task-follow-up-dialog", () => ({
  TaskFollowUpDialog: () => null,
}))
vi.mock("@/components/tasks/task-schedule-dialog", () => ({
  TaskScheduleDialog: () => null,
}))
vi.mock("@/components/tasks/task-transcript-dialog", () => ({
  TaskTranscriptDialog: () => null,
}))

import { TasksAuxTab } from "./aux-panel-tasks-tab"

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
      <TasksAuxTab />
    </NextIntlClientProvider>
  )
}

/** The section headers, top to bottom, by their column name. */
function sections(): string[] {
  return (
    screen
      .getAllByRole("button", { expanded: true })
      .concat(screen.queryAllByRole("button", { expanded: false }))
      // 工具栏的筛选按钮也是 aria-expanded 的 Popover 触发器，不算分区头。
      .filter((button) => !button.hasAttribute("aria-haspopup"))
      .sort((a, b) =>
        a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
      )
      .map((header) => header.textContent ?? "")
  )
}

const DEFERRED_AT = "2026-10-14T01:00:00Z"

beforeEach(() => {
  localStorage.clear()
  resetTasksBoardFilterCacheForTests()
  scene.projectFolderId = 1
  scene.activeFolderId = 1
  scene.setRoute.mockClear()
  scene.openTab.mockClear()
  view.loading = false
  view.tasks = [
    task({ id: 1, title: "Fix the login timeout", status: "todo" }),
    task({ id: 2, title: "Write the release notes", status: "review" }),
    task({ id: 3, title: "Port the parser", status: "running" }),
    task({ id: 4, title: "Login page polish", status: "done" }),
    // 别的项目：当前文件夹范围下不显示。
    task({ id: 5, folder_id: 2, title: "Redesign the landing page" }),
    // 以后处理仍按 review / failed 归入等你处理分区。
    task({
      id: 6,
      title: "Deferred review task",
      status: "review",
      deferred_at: DEFERRED_AT,
    }),
    task({ id: 7, title: "Failing build", status: "failed" }),
    task({
      id: 8,
      title: "Deferred failed task",
      status: "failed",
      deferred_at: DEFERRED_AT,
    }),
    // 已归档：默认不显示，归档筛选打开后显示。
    task({
      id: 9,
      title: "Archived task",
      status: "review",
      archived_at: "2026-10-14T02:00:00Z",
    }),
    // 归档的以后处理任务也不显示。
    task({
      id: 10,
      title: "Archived deferred task",
      status: "failed",
      deferred_at: DEFERRED_AT,
      archived_at: "2026-10-14T02:00:00Z",
    }),
    // 已关联会话的任务：它下面的会话 101 不再作为普通会话重复出现。
    task({
      id: 11,
      title: "Task with a session",
      status: "todo",
      conversation_id: 101,
    }),
  ]
  scene.conversations = [
    conversation({ id: 101, title: "Linked task session" }),
    conversation({
      id: 102,
      title: "Refactor the parser session",
      status: "in_progress",
      updated_at: "2026-10-14T03:00:00Z",
    }),
    conversation({
      id: 103,
      title: "Review the release branch",
      status: "pending_review",
    }),
    conversation({
      id: 104,
      title: "Finished migration notes",
      status: "completed",
    }),
    conversation({ id: 105, title: "Old spike session", status: "cancelled" }),
    // 同一个会话的重复行只显示一次。
    conversation({
      id: 102,
      title: "Refactor the parser session",
      status: "in_progress",
      updated_at: "2026-10-14T03:00:00Z",
    }),
    // 别的文件夹 / 子智能体会话都不投影。
    conversation({ id: 106, folder_id: 2, title: "Other project session" }),
    conversation({ id: 107, title: "Delegated child", kind: "delegate" }),
  ]
})

describe("TasksAuxTab", () => {
  it("stacks the current folder's tasks and unlinked conversations", () => {
    mount()
    expect(sections()).toEqual([
      "Needs you5",
      "In progress2",
      "To do2",
      "Done3",
    ])
    // 当前文件夹的任务。
    expect(screen.getByText("Write the release notes")).toBeInTheDocument()
    expect(screen.getByText("Port the parser")).toBeInTheDocument()
    expect(screen.getByText("Fix the login timeout")).toBeInTheDocument()
    expect(screen.getByText("Failing build")).toBeInTheDocument()
    expect(screen.getByText("Deferred review task")).toBeInTheDocument()
    expect(screen.getByText("Deferred failed task")).toBeInTheDocument()
    // 未关联任务的普通会话按会话状态落列。
    expect(screen.getByText("Refactor the parser session")).toBeInTheDocument()
    expect(screen.getByText("Review the release branch")).toBeInTheDocument()
    // 已关联任务的会话不重复出现，重复行也只出现一次。
    expect(screen.queryByText("Linked task session")).not.toBeInTheDocument()
    expect(screen.getAllByText("Refactor the parser session")).toHaveLength(1)
    // 别的项目 / 别的文件夹 / 子智能体会话都不显示。
    expect(
      screen.queryByText("Redesign the landing page")
    ).not.toBeInTheDocument()
    expect(screen.queryByText("Other project session")).not.toBeInTheDocument()
    expect(screen.queryByText("Delegated child")).not.toBeInTheDocument()
    // 折叠的已完成分区与归档任务默认都不显示。
    expect(screen.queryByText("Login page polish")).not.toBeInTheDocument()
    expect(screen.queryByText("Archived task")).not.toBeInTheDocument()
    expect(screen.queryByText("Archived deferred task")).not.toBeInTheDocument()
  })

  it("unfolds a section from its header, archived tasks still hidden", async () => {
    const user = userEvent.setup()
    mount()
    const done = screen.getByRole("button", { name: /Done/, expanded: false })
    await user.click(done)
    expect(done).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("Login page polish")).toBeInTheDocument()
    expect(screen.getByText("Finished migration notes")).toBeInTheDocument()
    expect(screen.getByText("Old spike session")).toBeInTheDocument()
    // 归档的仍然不显示，即使展开了已完成分区。
    expect(screen.queryByText("Archived task")).not.toBeInTheDocument()
    expect(screen.queryByText("Archived deferred task")).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /^Needs you/ }))
    expect(
      screen.queryByText("Write the release notes")
    ).not.toBeInTheDocument()
  })

  it("shows nothing without a current folder", () => {
    scene.projectFolderId = null
    scene.activeFolderId = null
    mount()
    expect(screen.queryByText("Fix the login timeout")).not.toBeInTheDocument()
    expect(
      screen.queryByText("Refactor the parser session")
    ).not.toBeInTheDocument()
    expect(screen.getByText(enMessages.Tasks.empty)).toBeInTheDocument()
  })

  it("opens a new task with the current folder as its default", async () => {
    const user = userEvent.setup()
    mount()
    await user.click(screen.getByRole("button", { name: "New task" }))
    expect(screen.getByRole("dialog")).toHaveAttribute(
      "data-default-folder",
      "1"
    )
  })

  it("searches tasks and conversations of the current folder", async () => {
    const user = userEvent.setup()
    mount()
    const box = screen.getByRole("textbox", { name: "Search tasks" })
    await user.type(box, "parser")
    // 折叠的 Done 分区里的命中会展开；任务和会话都参与搜索。
    expect(screen.getByText("Port the parser")).toBeInTheDocument()
    expect(screen.getByText("Refactor the parser session")).toBeInTheDocument()
    expect(
      screen.queryByText("Write the release notes")
    ).not.toBeInTheDocument()

    await user.clear(box)
    await user.type(box, "site")
    // 别的项目的任务/会话不在当前文件夹范围里。
    expect(screen.getByText(/No tasks match/)).toBeInTheDocument()

    await user.clear(box)
    await user.type(box, "login")
    await user.type(box, " kubernetes")
    const empty = screen.getByText("No tasks match “login kubernetes”")
      .parentElement as HTMLElement
    // The empty state's own way out, beside the field's ✕.
    await user.click(
      within(empty).getByRole("button", { name: "Clear search" })
    )
    expect(screen.getByText("Port the parser")).toBeInTheDocument()
  })

  it("opens a task's detail sheet", async () => {
    const user = userEvent.setup()
    mount()
    await user.click(screen.getByText("Port the parser"))
    expect(screen.getByRole("dialog")).toHaveTextContent("detail #3")
  })

  it("opens an ordinary conversation in its own tab, not as a task", async () => {
    const user = userEvent.setup()
    mount()
    await user.click(screen.getByText("Refactor the parser session"))
    expect(scene.setRoute).toHaveBeenCalledWith("conversations")
    expect(scene.openTab).toHaveBeenCalledWith(1, 102, "claude_code", false)
    // 普通会话没有任务行，不会打开任务详情。
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("strictly follows the active worktree folder for conversations", () => {
    // 任务仍属于项目根（folder 1），会话只看当前 worktree（folder 5）。
    scene.activeFolderId = 5
    scene.conversations = [
      conversation({
        id: 201,
        folder_id: 5,
        title: "Worktree session",
        status: "in_progress",
      }),
      conversation({ id: 202, folder_id: 1, title: "Project root session" }),
    ]
    mount()
    expect(screen.getByText("Fix the login timeout")).toBeInTheDocument()
    expect(screen.getByText("Worktree session")).toBeInTheDocument()
    expect(screen.queryByText("Project root session")).not.toBeInTheDocument()
  })

  it("toggles the archive filter from the panel itself", async () => {
    const user = userEvent.setup()
    mount()
    expect(screen.queryByText("Archived task")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Filter" }))
    await user.click(screen.getByRole("checkbox", { name: "Show archived" }))
    expect(screen.getByText("Archived task")).toBeInTheDocument()
    expect(screen.getByText("Archived deferred task")).toBeInTheDocument()
    expect(sections()).toEqual([
      "Needs you7",
      "In progress2",
      "To do2",
      "Done3",
    ])
    // 与完整页共用同一份设置。
    expect(
      JSON.parse(localStorage.getItem("workspace:tasks-board-filter") ?? "{}")
    ).toMatchObject({ showArchived: true })
  })

  it("opens the board on the current folder", async () => {
    const user = userEvent.setup()
    mount()
    await user.click(screen.getByRole("button", { name: "Open full page" }))
    expect(peekTasksFocus()).toEqual({ folderId: 1 })
    expect(scene.setRoute).toHaveBeenCalledWith("tasks")
  })

  it("offers the first task when nothing is listed at all", async () => {
    const user = userEvent.setup()
    view.tasks = []
    scene.conversations = []
    mount()
    const empty = screen.getByText(enMessages.Tasks.empty).parentElement
      ?.parentElement as HTMLElement
    await user.click(within(empty).getByRole("button", { name: "New task" }))
    expect(screen.getByRole("dialog")).toHaveAttribute(
      "data-default-folder",
      "1"
    )
  })

  it("follows the board's canceled toggle as it changes", async () => {
    const user = userEvent.setup()
    view.tasks = [
      ...view.tasks,
      task({ id: 20, title: "Drop the old importer", status: "canceled" }),
    ]
    mount()
    await user.click(screen.getByRole("button", { name: /Done/ }))
    // Canceled tasks show by default, as on the board.
    expect(screen.getByText("Drop the old importer")).toBeInTheDocument()
    expect(screen.getByText("Old spike session")).toBeInTheDocument()

    // Switched off elsewhere, while this tab stays mounted.
    act(() =>
      saveTasksBoardFilter({ showCanceled: false, showArchived: false })
    )
    expect(screen.queryByText("Drop the old importer")).not.toBeInTheDocument()
    expect(screen.queryByText("Old spike session")).not.toBeInTheDocument()
    expect(screen.getByText("Login page polish")).toBeInTheDocument()
  })

  it("explains itself when neither task nor conversation is left", () => {
    view.tasks = []
    scene.conversations = []
    mount()
    expect(screen.getByText(enMessages.Tasks.empty)).toBeInTheDocument()
  })
})
