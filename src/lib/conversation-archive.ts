"use client"

import { useSyncExternalStore } from "react"
import { getActiveRemoteConnectionId } from "@/lib/transport"
import type { DbConversationSummary } from "@/lib/types"
import { isConversationAutoArchived } from "@/lib/conversation-auto-archive"

/**
 * 会话归档是当前设备的显示偏好（按后端隔离、按会话 ID 记录），不改数据库，
 * 也不修改会话状态或删除会话。
 * - archived：手动归档，始终隐藏；
 * - restored：手动恢复，覆盖“超过 3 天未更新”的自动归档。
 */
export interface ConversationArchiveState {
  archived: ReadonlySet<number>
  restored: ReadonlySet<number>
}

const EVENT = "workspace:conversation-archive-changed"
const EMPTY: ConversationArchiveState = {
  archived: new Set(),
  restored: new Set(),
}
let cachedRaw: string | null = null
let cached: ConversationArchiveState = EMPTY

function key() {
  return `workspace:archived-conversations:${getActiveRemoteConnectionId() ?? "local"}`
}

function ids(value: unknown): Set<number> {
  return new Set(
    Array.isArray(value)
      ? value.filter((v): v is number => Number.isInteger(v))
      : []
  )
}

function snapshot(): ConversationArchiveState {
  if (typeof window === "undefined") return EMPTY
  let raw: string | null
  try {
    raw = localStorage.getItem(key())
  } catch {
    return EMPTY
  }
  if (raw === cachedRaw) return cached
  cachedRaw = raw
  try {
    const parsed = raw ? JSON.parse(raw) : null
    cached = parsed
      ? { archived: ids(parsed.archived), restored: ids(parsed.restored) }
      : EMPTY
  } catch {
    cached = EMPTY
  }
  return cached
}

function subscribe(callback: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === key() || event.key === null) callback()
  }
  window.addEventListener(EVENT, callback)
  window.addEventListener("storage", onStorage)
  return () => {
    window.removeEventListener(EVENT, callback)
    window.removeEventListener("storage", onStorage)
  }
}

export function useConversationArchiveState() {
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY)
}

export function setConversationsArchived(
  conversationIds: readonly number[],
  archived: boolean
) {
  const { archived: a, restored: r } = snapshot()
  const nextArchived = new Set(a)
  const nextRestored = new Set(r)
  for (const id of conversationIds) {
    if (archived) {
      nextArchived.add(id)
      nextRestored.delete(id)
    } else {
      nextArchived.delete(id)
      nextRestored.add(id)
    }
  }
  localStorage.setItem(
    key(),
    JSON.stringify({
      archived: [...nextArchived],
      restored: [...nextRestored],
    })
  )
  window.dispatchEvent(new Event(EVENT))
}

export type ConversationArchiveReason = "manual" | "auto" | null

/** 手动归档优先；手动恢复可覆盖自动归档；置顶/运行中仍不自动归档。 */
export function conversationArchiveReason(
  conversation: Pick<
    DbConversationSummary,
    "id" | "updated_at" | "pinned_at" | "status"
  >,
  now: number,
  state: ConversationArchiveState
): ConversationArchiveReason {
  if (state.archived.has(conversation.id)) return "manual"
  if (state.restored.has(conversation.id)) return null
  return isConversationAutoArchived(
    conversation,
    now,
    conversation.status === "in_progress"
  )
    ? "auto"
    : null
}
