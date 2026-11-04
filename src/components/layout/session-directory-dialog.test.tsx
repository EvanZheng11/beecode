import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { FolderDetail } from "@/lib/types"
import { SessionDirectoryDialog } from "./session-directory-dialog"

const state = vi.hoisted(() => ({
  allFolders: [] as FolderDetail[],
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
  state.allFolders = [folder(1, 10), folder(2, null)]
  state.folders = state.allFolders
  state.applySidebarLayout.mockResolvedValue(undefined)
  state.fetchFolders.mockResolvedValue(undefined)
  state.removeFolderFromWorkspace.mockResolvedValue(undefined)
  archives.paths = []
})
function renderDialog() {
  return render(<SessionDirectoryDialog open onOpenChange={vi.fn()} />)
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
    fireEvent.click(screen.getByRole("button", { name: "排序", exact: true }))
    fireEvent.click(screen.getByLabelText("上移 项目2"))
    expect(state.applySidebarLayout).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "取消排序" }))
    expect(state.applySidebarLayout).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "排序", exact: true }))
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
    fireEvent.click(screen.getByRole("button", { name: "文件夹", exact: true }))
    expect(screen.getByTestId("folder-picker")).toHaveTextContent("分组 10")
  })
  it("归档状态可过滤并恢复", async () => {
    archives.paths = ["/project/1"]
    renderDialog()
    fireEvent.change(screen.getByLabelText("过滤目录状态"), {
      target: { value: "archived" },
    })
    expect(screen.queryByText("项目2")).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText("选择 项目1"))
    fireEvent.click(
      screen.getAllByRole("button", { name: "恢复", exact: true })[0]
    )
    await waitFor(() =>
      expect(archives.set).toHaveBeenCalledWith(["/project/1"], false)
    )
  })
})
