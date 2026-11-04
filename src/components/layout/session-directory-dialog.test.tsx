import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import userEvent from "@testing-library/user-event"
import { toast } from "sonner"
import { beforeEach, describe, expect, it, vi } from "vitest"
import zhMessages from "@/i18n/messages/zh-CN.json"
import type { DbConversationSummary, FolderDetail } from "@/lib/types"
import { SessionDirectoryDialog } from "./session-directory-dialog"

// jsdom 缺少 PointerEvent：用 MouseEvent 兜底，保证 clientX/Y、button 可传入
if (!("PointerEvent" in window))
  (window as unknown as { PointerEvent: unknown }).PointerEvent =
    class extends MouseEvent {}

const state = vi.hoisted(() => ({
  allFolders: [] as FolderDetail[],
  conversations: [] as DbConversationSummary[],
  folders: [] as FolderDetail[],
  folderGroups: [{ id: 10, name: "研发组", color: "inherit", sort_order: 1 }],
  applySidebarLayout: vi.fn(),
  createFolderGroup: vi.fn(),
  removeFolderFromWorkspace: vi.fn(),
  addFolderToWorkspaceById: vi.fn(),
  fetchFolders: vi.fn(),
}))
const archives = vi.hoisted(() => ({ paths: [] as string[], set: vi.fn() }))
vi.mock("@/stores/app-workspace-store", () => ({
  useAppWorkspaceStore: (selector: (s: typeof state) => unknown) =>
    selector(state),
}))
vi.mock("@/lib/folder-archive", () => ({
  useArchivedFolderPaths: () => archives.paths,
  setFoldersArchived: archives.set,
}))
const convArchive = vi.hoisted(() => ({ set: vi.fn() }))
vi.mock("@/lib/conversation-archive", async (orig) => ({
  ...(await orig<typeof import("@/lib/conversation-archive")>()),
  useConversationArchiveState: () => ({
    archived: new Set<number>(),
    restored: new Set<number>(),
  }),
  setConversationsArchived: convArchive.set,
}))
vi.mock("./workspace-folder-dialog", () => ({
  WorkspaceFolderDialog: ({
    open,
    defaultGroupId,
  }: {
    open: boolean
    defaultGroupId: number | null
  }) =>
    open ? <div data-testid="folder-picker">分组 {defaultGroupId}</div> : null,
}))
vi.mock("virtua", () => ({
  Virtualizer: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}))
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
const folder = (id: number, group_id: number | null): FolderDetail => ({
  id,
  name: `项目${id}`,
  path: `/project/${id}`,
  group_id,
  kind: "regular",
  parent_id: null,
  sort_order: id,
  alias: null,
  git_branch: null,
  default_agent_type: null,
  color: "inherit",
  last_opened_at: "",
})
beforeEach(() => {
  vi.clearAllMocks()
  document.elementFromPoint = () => null
  state.folderGroups = [
    { id: 10, name: "研发组", color: "inherit", sort_order: 1 },
  ]
  state.allFolders = [folder(1, 10), folder(2, null)]
  state.conversations = []
  state.folders = state.allFolders
  state.applySidebarLayout.mockResolvedValue(undefined)
  state.fetchFolders.mockResolvedValue(undefined)
  state.removeFolderFromWorkspace.mockResolvedValue(undefined)
  archives.paths = []
})
function renderDialog() {
  return render(
    <NextIntlClientProvider locale="zh-CN" messages={zhMessages}>
      <SessionDirectoryDialog open onOpenChange={vi.fn()} />
    </NextIntlClientProvider>
  )
}

describe("会话目录管理交互", () => {
  it("按名称过滤并批量归档", async () => {
    renderDialog()
    fireEvent.change(screen.getByLabelText("过滤目录名称"), {
      target: { value: "项目1" },
    })
    expect(screen.queryByText("项目2")).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText("选择全部筛选目录"))
    fireEvent.click(screen.getByRole("button", { name: "批量归档" }))
    await waitFor(() =>
      expect(archives.set).toHaveBeenCalledWith(["/project/1"], true)
    )
  })
  it("移出工作区需要确认，不删除目录", async () => {
    renderDialog()
    fireEvent.click(screen.getByLabelText("选择 项目1"))
    fireEvent.click(screen.getByRole("button", { name: "移出工作区" }))
    expect(state.removeFolderFromWorkspace).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "确认移出" }))
    await waitFor(() =>
      expect(state.removeFolderFromWorkspace).toHaveBeenCalledWith(1)
    )
  })
  it("排序取消不写入，保存才提交完整布局", async () => {
    renderDialog()
    fireEvent.click(screen.getByRole("button", { name: /^排序$/ }))
    fireEvent.click(screen.getByLabelText("上移 项目2"))
    expect(state.applySidebarLayout).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "取消排序" }))
    expect(state.applySidebarLayout).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: /^排序$/ }))
    fireEvent.click(screen.getByLabelText("上移 项目2"))
    fireEvent.click(screen.getByRole("button", { name: "保存排序" }))
    await waitFor(() =>
      expect(state.applySidebarLayout).toHaveBeenCalledWith([
        { kind: "folder", id: 2, groupId: null },
        { kind: "group", id: 10, groupId: null },
        { kind: "folder", id: 1, groupId: 10 },
      ])
    )
  })
  it("从分组添加文件夹会传递预选分组", () => {
    renderDialog()
    fireEvent.click(screen.getByRole("button", { name: /^文件夹$/ }))
    expect(screen.getByTestId("folder-picker")).toHaveTextContent("分组 10")
  })
  it("状态过滤使用项目共享 Select（非原生 select）并可恢复", async () => {
    archives.paths = ["/project/1"]
    renderDialog()
    expect(document.querySelector("select")).toBeNull()
    const user = userEvent.setup()
    await user.click(screen.getByRole("combobox", { name: "过滤目录状态" }))
    await user.click(await screen.findByRole("option", { name: "已归档" }))
    expect(screen.queryByText("项目2")).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText("选择 项目1"))
    fireEvent.click(screen.getAllByRole("button", { name: /^恢复$/ })[0])
    await waitFor(() =>
      expect(archives.set).toHaveBeenCalledWith(["/project/1"], false)
    )
  })
  it("已归档并移出的目录重新加入时恢复可见", async () => {
    archives.paths = ["/project/2"]
    state.folders = [state.allFolders[0]]
    state.addFolderToWorkspaceById.mockResolvedValue(undefined)
    renderDialog()
    const row = screen.getByLabelText("选择 项目2").closest('[role="row"]')!
    fireEvent.click(
      within(row as HTMLElement).getByRole("button", { name: "重新加入" })
    )
    await waitFor(() =>
      expect(state.addFolderToWorkspaceById).toHaveBeenCalledWith(2)
    )
    await waitFor(() =>
      expect(archives.set).toHaveBeenCalledWith(["/project/2"], false)
    )
  })
  it("分组拖到成员行上半部时按所属组的位置落点（指针拖动）", async () => {
    state.folderGroups = [
      { id: 10, name: "研发组", color: "inherit", sort_order: 1 },
      { id: 11, name: "运营组", color: "inherit", sort_order: 2 },
    ]
    state.allFolders = [folder(1, 10), folder(2, null), folder(4, 11)]
    state.folders = state.allFolders
    renderDialog()
    fireEvent.click(screen.getByRole("button", { name: /^排序$/ }))
    const rowOf = (name: string) =>
      screen
        .getByLabelText(`上移 ${name}`)
        .closest('[role="row"]') as HTMLElement
    const target = rowOf("项目1")
    target.getBoundingClientRect = () =>
      ({ top: 0, height: 28, bottom: 28 }) as DOMRect
    fireEvent.pointerDown(rowOf("运营组"), {
      button: 0,
      clientX: 5,
      clientY: 90,
    })
    document.elementFromPoint = () => target
    fireEvent.pointerMove(window, { clientX: 5, clientY: 4 })
    expect(rowOf("研发组").className).toContain("shadow-")
    fireEvent.pointerUp(window)
    fireEvent.click(screen.getByRole("button", { name: "保存排序" }))
    await waitFor(() =>
      expect(state.applySidebarLayout).toHaveBeenCalledWith([
        { kind: "group", id: 11, groupId: null },
        { kind: "folder", id: 4, groupId: 11 },
        { kind: "group", id: 10, groupId: null },
        { kind: "folder", id: 1, groupId: 10 },
        { kind: "folder", id: 2, groupId: null },
      ])
    )
  })
  it("行高压缩为 h-7（原 h-14）", () => {
    renderDialog()
    const row = screen.getByLabelText("选择 项目2").closest('[role="row"]')!
    expect(row.className).toContain("h-7")
    expect(row.className).not.toContain("h-14")
  })
  it("行内分组按钮：弹窗选择目标分组，仅一次保存且不碰会话", async () => {
    renderDialog()
    const user = userEvent.setup()
    const row = screen.getByLabelText("选择 项目2").closest('[role="row"]')!
    await user.click(
      within(row as HTMLElement).getByRole("button", { name: "分组" })
    )
    await user.click(screen.getByRole("combobox", { name: "目标分组" }))
    await user.click(await screen.findByRole("option", { name: "研发组" }))
    await user.click(screen.getByRole("button", { name: "确认移动" }))
    await waitFor(() =>
      expect(state.applySidebarLayout).toHaveBeenCalledTimes(1)
    )
    expect(state.applySidebarLayout).toHaveBeenCalledWith([
      { kind: "group", id: 10, groupId: null },
      { kind: "folder", id: 1, groupId: 10 },
      { kind: "folder", id: 2, groupId: 10 },
    ])
  })
  it("批量分组与取消：取消零写入，worktree 子目录被跳过", async () => {
    state.allFolders = [
      folder(1, 10),
      folder(2, null),
      { ...folder(3, null), parent_id: 2 },
    ]
    state.folders = state.allFolders
    renderDialog()
    const user = userEvent.setup()
    fireEvent.click(screen.getByLabelText("选择 项目2"))
    fireEvent.click(screen.getByLabelText("选择 项目3"))
    await user.click(screen.getByRole("button", { name: "批量分组" }))
    expect(screen.getByText(/1 个 worktree 子目录将被跳过/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "取消" }))
    expect(state.applySidebarLayout).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "批量分组" }))
    await user.click(screen.getByRole("button", { name: "确认移动" }))
    await waitFor(() =>
      expect(state.applySidebarLayout).toHaveBeenCalledTimes(1)
    )
    // 默认目标为第一个分组；项目3 不在布局中被移动
    expect(state.applySidebarLayout).toHaveBeenCalledWith([
      { kind: "group", id: 10, groupId: null },
      { kind: "folder", id: 1, groupId: 10 },
      { kind: "folder", id: 2, groupId: 10 },
    ])
  })
  it("分组保存失败显示错误并保留弹窗", async () => {
    state.applySidebarLayout.mockRejectedValue(new Error("boom"))
    renderDialog()
    const user = userEvent.setup()
    fireEvent.click(screen.getByLabelText("选择 项目2"))
    await user.click(screen.getByRole("button", { name: "批量分组" }))
    await user.click(screen.getByRole("button", { name: "确认移动" }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(screen.getByRole("button", { name: "确认移动" })).toBeInTheDocument()
  })
  it("行内移出需确认；取消不调用；失败提示", async () => {
    renderDialog()
    const user = userEvent.setup()
    const row = screen.getByLabelText("选择 项目2").closest('[role="row"]')!
    await user.click(
      within(row as HTMLElement).getByRole("button", { name: "移出" })
    )
    await user.click(screen.getByRole("button", { name: "取消" }))
    expect(state.removeFolderFromWorkspace).not.toHaveBeenCalled()
    await user.click(
      within(row as HTMLElement).getByRole("button", { name: "移出" })
    )
    state.removeFolderFromWorkspace.mockRejectedValueOnce(new Error("x"))
    await user.click(screen.getByRole("button", { name: "确认移出" }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(state.removeFolderFromWorkspace).toHaveBeenCalledWith(2)
  })
  it("展开会话后可单条归档、批量归档会话（不写目录归档）", async () => {
    state.conversations = [
      {
        id: 7,
        folder_id: 2,
        title: "修复登录",
        status: "completed",
        updated_at: new Date().toISOString(),
        pinned_at: null,
        parent_id: null,
      } as DbConversationSummary,
    ]
    renderDialog()
    expect(screen.queryByText("修复登录")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "展开 项目2 的会话" }))
    const row = screen.getByText("修复登录").closest('[role="row"]')!
    fireEvent.click(
      within(row as HTMLElement).getByRole("button", { name: "归档" })
    )
    expect(convArchive.set).toHaveBeenCalledWith([7], true)
    fireEvent.click(screen.getByLabelText("选择 修复登录"))
    fireEvent.click(screen.getByRole("button", { name: "批量归档" }))
    await waitFor(() => expect(convArchive.set).toHaveBeenCalledWith([7], true))
    expect(archives.set).not.toHaveBeenCalled()
    // 会话行没有分组/移出/删除入口
    expect(
      within(row as HTMLElement).queryByRole("button", {
        name: /分组|移出|删除/,
      })
    ).toBeNull()
  })
  it("归档目录下的会话显示为随目录归档，无单独恢复入口", () => {
    archives.paths = ["/project/2"]
    state.conversations = [
      {
        id: 7,
        folder_id: 2,
        title: "修复登录",
        status: "completed",
        updated_at: new Date().toISOString(),
        pinned_at: null,
        parent_id: null,
      } as DbConversationSummary,
    ]
    renderDialog()
    fireEvent.click(screen.getByRole("button", { name: "展开 项目2 的会话" }))
    const row = screen
      .getByText("修复登录")
      .closest('[role="row"]') as HTMLElement
    expect(within(row).getByText("所在目录已归档")).toBeInTheDocument()
    expect(within(row).queryByRole("button")).toBeNull()
  })

  describe("指针拖动（非 HTML5 DnD）", () => {
    const rowOf = (name: string) =>
      screen
        .getByLabelText(`上移 ${name}`)
        .closest('[role="row"]') as HTMLElement
    function underPointer(el: Element | null) {
      document.elementFromPoint = () => el
    }
    it("按下→移动→松开：拖到分组行移入，保存一次写入", async () => {
      renderDialog()
      fireEvent.click(screen.getByRole("button", { name: /^排序$/ }))
      fireEvent.pointerDown(rowOf("项目2"), {
        button: 0,
        clientX: 10,
        clientY: 100,
      })
      underPointer(rowOf("研发组"))
      fireEvent.pointerMove(window, { clientX: 10, clientY: 60 })
      expect(rowOf("研发组").className).toContain("ring-primary")
      fireEvent.pointerUp(window)
      expect(state.applySidebarLayout).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole("button", { name: "保存排序" }))
      await waitFor(() =>
        expect(state.applySidebarLayout).toHaveBeenCalledTimes(1)
      )
      expect(state.applySidebarLayout).toHaveBeenCalledWith([
        { kind: "group", id: 10, groupId: null },
        { kind: "folder", id: 2, groupId: 10 },
        { kind: "folder", id: 1, groupId: 10 },
      ])
    })
    it("Esc/pointercancel 取消拖动并清理，不改变草稿", async () => {
      renderDialog()
      fireEvent.click(screen.getByRole("button", { name: /^排序$/ }))
      for (const cancel of [
        () => fireEvent.keyDown(window, { key: "Escape" }),
        () => fireEvent.pointerCancel(window),
      ]) {
        fireEvent.pointerDown(rowOf("项目2"), {
          button: 0,
          clientX: 10,
          clientY: 100,
        })
        underPointer(rowOf("研发组"))
        fireEvent.pointerMove(window, { clientX: 10, clientY: 60 })
        cancel()
        fireEvent.pointerUp(window)
        expect(rowOf("研发组").className).not.toContain("ring-primary")
      }
      fireEvent.click(screen.getByRole("button", { name: "取消排序" }))
      expect(state.applySidebarLayout).not.toHaveBeenCalled()
    })
    it("移动不足阈值视为点击，不触发排序", () => {
      renderDialog()
      fireEvent.click(screen.getByRole("button", { name: /^排序$/ }))
      fireEvent.pointerDown(rowOf("项目2"), {
        button: 0,
        clientX: 10,
        clientY: 100,
      })
      underPointer(rowOf("研发组"))
      fireEvent.pointerMove(window, { clientX: 11, clientY: 101 })
      fireEvent.pointerUp(window)
      fireEvent.click(screen.getByRole("button", { name: "保存排序" }))
      expect(state.applySidebarLayout).toHaveBeenCalledWith([
        { kind: "group", id: 10, groupId: null },
        { kind: "folder", id: 1, groupId: 10 },
        { kind: "folder", id: 2, groupId: null },
      ])
    })
  })
})
