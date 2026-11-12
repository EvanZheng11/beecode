import { useEffect, useState } from "react"

import { isLocalDesktop } from "@/lib/platform"
import { listRemoteWorkspaceConnections } from "@/lib/remote-workspace"

/** 正文与导航共用连接缓存，避免每张远程卡片分别查询。 */
let remoteConnectionIdsCache: { at: number; ids: Set<number> } | null = null
const REMOTE_CONNECTION_IDS_TTL_MS = 15_000
let remoteConnectionIdsLoading: Promise<Set<number>> | null = null
/** 重置后，在途旧请求不再覆盖新缓存。 */
let remoteConnectionIdsEpoch = 0

/** 测试用：清掉连接 id 缓存。 */
export function resetRemoteConnectionIdsCache(): void {
  remoteConnectionIdsEpoch += 1
  remoteConnectionIdsCache = null
  remoteConnectionIdsLoading = null
}

async function loadRemoteConnectionIds(): Promise<Set<number>> {
  const now = Date.now()
  if (
    remoteConnectionIdsCache &&
    now - remoteConnectionIdsCache.at < REMOTE_CONNECTION_IDS_TTL_MS
  ) {
    return remoteConnectionIdsCache.ids
  }
  if (remoteConnectionIdsLoading) return remoteConnectionIdsLoading
  const epoch = remoteConnectionIdsEpoch
  const loading = listRemoteWorkspaceConnections()
    .then((list) => {
      const ids = new Set(list.map((c) => c.id))
      if (epoch === remoteConnectionIdsEpoch) {
        remoteConnectionIdsCache = { at: Date.now(), ids }
      }
      return ids
    })
    .finally(() => {
      // 失败不缓存；重置后也不能清掉新一代的在途请求。
      if (epoch === remoteConnectionIdsEpoch) remoteConnectionIdsLoading = null
    })
  remoteConnectionIdsLoading = loading
  return loading
}

export type RemoteAvailability = "unknown" | "available" | "deleted"

/** 连接已删除时禁用跳转；查询失败保持 unknown，由点击时的错误提示说明。 */
export function useRemoteConnectionAvailability(
  connectionId: number | null
): RemoteAvailability {
  const [known, setKnown] = useState<{
    connectionId: number
    availability: RemoteAvailability
  } | null>(null)
  useEffect(() => {
    if (connectionId === null || !isLocalDesktop()) return
    let cancelled = false
    void loadRemoteConnectionIds()
      .then((ids) => {
        if (cancelled) return
        setKnown({
          connectionId,
          availability: ids.has(connectionId) ? "available" : "deleted",
        })
      })
      .catch(() => {
        // 查不到就保持 unknown，失败由点击时的 toast 说清楚。
      })
    return () => {
      cancelled = true
    }
  }, [connectionId])
  // 换连接后不能沿用上一个连接的结果。
  if (connectionId === null || known?.connectionId !== connectionId) {
    return "unknown"
  }
  return known.availability
}
