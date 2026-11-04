import { useEffect, useMemo, useState } from "react"
import { gitListMergedWorktrees } from "@/lib/api"
import type { FolderDetail } from "@/lib/types"

export function visibleWorktreeFolders(
  folders: FolderDetail[],
  mergedPaths: ReadonlySet<string>
): FolderDetail[] {
  return folders.filter(
    (folder) => folder.parent_id == null || !mergedPaths.has(folder.path)
  )
}

/** 只过滤显示；完整 folders/allFolders 仍留在 store，供管理与恢复入口使用。 */
export function useMergedWorktreePaths(folders: FolderDetail[]) {
  const [mergedPaths, setMergedPaths] = useState<ReadonlySet<string>>(new Set())
  const queryPaths = useMemo(() => {
    const byId = new Map(folders.map((folder) => [folder.id, folder]))
    return [
      ...new Set(
        folders
          .filter((folder) => folder.parent_id != null)
          .map((folder) => byId.get(folder.parent_id!)?.path ?? folder.path)
      ),
    ]
  }, [folders])

  useEffect(() => {
    let cancelled = false
    let pending = false
    const refresh = async () => {
      if (pending) return
      pending = true
      const results = await Promise.all(
        queryPaths.map((path) => gitListMergedWorktrees(path).catch(() => []))
      )
      pending = false
      if (!cancelled) setMergedPaths(new Set(results.flat()))
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 30_000)
    window.addEventListener("focus", refresh)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener("focus", refresh)
    }
  }, [queryPaths])

  return mergedPaths
}
