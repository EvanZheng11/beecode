import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  excludeArchivedFolders,
  setFoldersArchived,
  useArchivedFolderPaths,
} from "./folder-archive"
import type { FolderDetail } from "./types"
const remote = vi.hoisted(() => ({ id: null as number | null }))
vi.mock("@/lib/transport", () => ({
  getActiveRemoteConnectionId: () => remote.id,
}))
beforeEach(() => {
  localStorage.clear()
  remote.id = null
})
describe("目录归档显示偏好", () => {
  it("归档和恢复同步订阅者并持久化", () => {
    const { result } = renderHook(useArchivedFolderPaths)
    expect(result.current).toEqual([])
    act(() => setFoldersArchived(["/project/1"], true))
    expect(result.current).toEqual(["/project/1"])
    expect(localStorage.getItem("workspace:archived-folders:local")).toContain(
      "/project/1"
    )
    act(() => setFoldersArchived(["/project/1"], false))
    expect(result.current).toEqual([])
  })
  it("按远端后端隔离", () => {
    act(() => setFoldersArchived(["/local"], true))
    remote.id = 2
    const { result } = renderHook(useArchivedFolderPaths)
    expect(result.current).toEqual([])
  })
  it("隐藏归档父目录及其工作树但不更改数据", () => {
    const folders = [
      { id: 1, path: "/one", parent_id: null },
      { id: 2, path: "/two", parent_id: 1 },
      { id: 3, path: "/three", parent_id: null },
    ] as FolderDetail[]
    expect(excludeArchivedFolders(folders, ["/one"]).map((f) => f.id)).toEqual([
      3,
    ])
    expect(folders).toHaveLength(3)
  })
})
