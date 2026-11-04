import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { gitListMergedWorktrees } from "@/lib/api"
import type { FolderDetail } from "@/lib/types"
import {
  useMergedWorktreePaths,
  visibleWorktreeFolders,
} from "./sidebar-merged-worktrees"

vi.mock("@/lib/api", () => ({ gitListMergedWorktrees: vi.fn() }))

const folder = (id: number, path: string, parent_id: number | null) =>
  ({ id, path, parent_id }) as FolderDetail
const folders = [
  folder(1, "/repo", null),
  folder(2, "/merged", 1),
  folder(3, "/unknown", 1),
]

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe("已合并 worktree 侧栏过滤", () => {
  it("仅隐藏确认的附属目录，保留主目录、未知目录和输入数据", () => {
    const visible = visibleWorktreeFolders(
      folders,
      new Set(["/repo", "/merged"])
    )
    expect(visible.map((f) => f.id)).toEqual([1, 3])
    expect(folders).toHaveLength(3)
    expect(visibleWorktreeFolders(folders, new Set())).toEqual(folders)
  })

  it("每仓库查询一次，查询失败后恢复显示，卸载后停止轮询", async () => {
    vi.mocked(gitListMergedWorktrees).mockResolvedValue(["/merged"])
    const { result, unmount } = renderHook(() =>
      useMergedWorktreePaths(folders)
    )
    await waitFor(() => expect([...result.current]).toEqual(["/merged"]))
    expect(gitListMergedWorktrees).toHaveBeenCalledExactlyOnceWith("/repo")
    vi.mocked(gitListMergedWorktrees).mockRejectedValue(new Error("unknown"))
    await act(async () => window.dispatchEvent(new Event("focus")))
    expect(result.current.size).toBe(0)
    unmount()
    window.dispatchEvent(new Event("focus"))
    expect(gitListMergedWorktrees).toHaveBeenCalledTimes(2)
  })

  it("30 秒重新判定，合并状态变化后显示目录", async () => {
    vi.useFakeTimers()
    vi.mocked(gitListMergedWorktrees).mockResolvedValue(["/merged"])
    const { result, unmount } = renderHook(() =>
      useMergedWorktreePaths(folders)
    )
    await act(async () => {})
    expect(result.current.has("/merged")).toBe(true)
    vi.mocked(gitListMergedWorktrees).mockResolvedValue([])
    await act(async () => vi.advanceTimersByTimeAsync(30_000))
    expect(result.current.size).toBe(0)
    unmount()
  })
})
