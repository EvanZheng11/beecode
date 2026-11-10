/**
 * 远程文件快照的进行中状态（按连接隔离）。
 *
 * 发送边界在后端把消息里的 `codeg://remote/...` 引用拉回本机时，会先后发出
 * `remote_snapshot_preparing{count}` / `remote_snapshot_done{degraded[]}`
 * （设计 4.1.3.1 / 7.4）。前端只在输入框上方显示「正在获取远程文件（N）…」并
 * 对降级项 toast 一次 —— 发送、队列、插话链路一概不动。
 *
 * 状态以连接的 `contextKey` 为键（同一后端 connection 可能被多个界面共视，但
 * 「这条会话的输入框」只认自己的 contextKey）。事件由
 * `acp-connections-context` 的 `handleMappedEvent` 落到这里，输入框订阅自己那份。
 *
 * 兜底：`preparing` 自带过期时间。后端整体快照超时 30 s，若进程被杀/事件丢失，
 * 没有 `done` 也不会把提示永久留在界面上。
 */

import type { RemoteSnapshotDegraded } from "@/lib/types"

/** `preparing` 的最长展示时间（后端快照整体超时 30 s + 余量）。 */
const PREPARING_TTL_MS = 45_000

export interface RemoteSnapshotProgress {
  /** 正在获取的远程引用数；0 表示没有进行中的快照。 */
  preparing: number
  /** 待提示的降级项（消费即清空，保证每一项只 toast 一次）。 */
  degraded: RemoteSnapshotDegraded[]
}

const EMPTY: RemoteSnapshotProgress = { preparing: 0, degraded: [] }

const state = new Map<string, RemoteSnapshotProgress>()
const listeners = new Map<string, Set<() => void>>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

function emit(contextKey: string) {
  const set = listeners.get(contextKey)
  if (!set) return
  for (const cb of set) {
    try {
      cb()
    } catch (err) {
      console.error("[remote-snapshot] listener threw:", err)
    }
  }
}

function clearTimer(contextKey: string) {
  const t = timers.get(contextKey)
  if (t !== undefined) {
    clearTimeout(t)
    timers.delete(contextKey)
  }
}

function write(contextKey: string, next: RemoteSnapshotProgress) {
  if (next.preparing === 0 && next.degraded.length === 0) {
    if (!state.delete(contextKey)) return
  } else {
    state.set(contextKey, next)
  }
  emit(contextKey)
}

/** 快照开始：记下待取回的远程引用数，并重置兜底过期计时。 */
export function beginRemoteSnapshotPreparing(
  contextKey: string,
  count: number
): void {
  if (!contextKey) return
  const preparing = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
  clearTimer(contextKey)
  if (preparing === 0) {
    write(contextKey, { ...(state.get(contextKey) ?? EMPTY), preparing: 0 })
    return
  }
  write(contextKey, { ...(state.get(contextKey) ?? EMPTY), preparing })
  timers.set(
    contextKey,
    setTimeout(() => {
      timers.delete(contextKey)
      const current = state.get(contextKey)
      if (!current) return
      write(contextKey, { ...current, preparing: 0 })
    }, PREPARING_TTL_MS)
  )
}

/** 快照结束：清掉进行中计数，把降级项挂上去等输入框提示。 */
export function endRemoteSnapshotDone(
  contextKey: string,
  degraded: RemoteSnapshotDegraded[] | null | undefined
): void {
  if (!contextKey) return
  clearTimer(contextKey)
  const current = state.get(contextKey) ?? EMPTY
  const items = Array.isArray(degraded) ? degraded.filter(isDegraded) : []
  write(contextKey, {
    preparing: 0,
    degraded: items.length > 0 ? items : current.degraded,
  })
}

function isDegraded(value: unknown): value is RemoteSnapshotDegraded {
  if (!value || typeof value !== "object") return false
  const obj = value as Record<string, unknown>
  return typeof obj.uri === "string" && typeof obj.reason === "string"
}

/**
 * 取走待提示的降级项：读一次就用掉，避免重渲染/严格模式下重复 toast。
 */
export function consumeRemoteSnapshotDegraded(
  contextKey: string
): RemoteSnapshotDegraded[] {
  const current = state.get(contextKey)
  if (!current || current.degraded.length === 0) return []
  const items = current.degraded
  write(contextKey, { preparing: current.preparing, degraded: [] })
  return items
}

/** 连接被移除 / 全部清空时丢弃该连接的状态与计时器。 */
export function clearRemoteSnapshotProgress(contextKey: string): void {
  if (!contextKey) return
  clearTimer(contextKey)
  if (state.delete(contextKey)) emit(contextKey)
}

/** 全部连接的状态（测试与整块清理用）。 */
export function clearAllRemoteSnapshotProgress(): void {
  for (const key of Array.from(timers.keys())) clearTimer(key)
  const keys = Array.from(state.keys())
  state.clear()
  for (const key of keys) emit(key)
}

/** 供 `useSyncExternalStore` 订阅；返回退订函数。 */
export function subscribeRemoteSnapshotProgress(
  contextKey: string,
  onChange: () => void
): () => void {
  let set = listeners.get(contextKey)
  if (!set) {
    set = new Set()
    listeners.set(contextKey, set)
  }
  set.add(onChange)
  return () => {
    const current = listeners.get(contextKey)
    if (!current) return
    current.delete(onChange)
    if (current.size === 0) listeners.delete(contextKey)
  }
}

/** 供 `useSyncExternalStore` 读取；无状态时返回同一个空对象（引用稳定）。 */
export function getRemoteSnapshotProgress(
  contextKey: string
): RemoteSnapshotProgress {
  return state.get(contextKey) ?? EMPTY
}
