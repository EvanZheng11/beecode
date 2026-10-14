"use client"

import { useCallback, useRef, useState } from "react"
import type { PromptDraft } from "@/lib/types"
import { randomUUID } from "@/lib/utils"

export interface QueuedMessage {
  id: string
  draft: PromptDraft
  /**
   * The mode this message will be sent under. `null` means "leave the agent's
   * mode alone" — an explicit choice for the answer / plan-notes retry paths,
   * which must not switch mode on their way out.
   *
   * That is why {@link QueuedMessage.adoptSendTimeMode} exists as a separate
   * flag rather than being spelled `modeId === null`: "unknown yet" and
   * "deliberately none" are different intents.
   */
  modeId: string | null
  /**
   * Resolve the mode when this message actually SENDS, ignoring `modeId`.
   *
   * For messages queued before their tab could know its modes — a prompt parked
   * on a brand-new draft by "ask about this selection", which is enqueued while
   * the connection is still coming up. Without it the agent would run in
   * whatever mode it happened to start in while the composer above displayed the
   * user's saved mode.
   */
  adoptSendTimeMode?: boolean
}

export interface UseMessageQueueReturn {
  queue: QueuedMessage[]
  enqueue: (
    draft: PromptDraft,
    modeId: string | null,
    opts?: { adoptSendTimeMode?: boolean }
  ) => void
  /**
   * 将草稿放回队首。自动 flush 取出消息后遇到 TurnBusyError，或追加为实时
   * 反馈失败时，都必须回到队首，确保它先于原本排在后面的消息重试。
   *
   * 恢复完整队列项时，通过 opts 传入原项的 `adoptSendTimeMode`；该标记决定
   * 发送时的模式语义，不能静默丢失。未传 opts 的既有调用行为保持不变。
   */
  requeueFront: (
    draft: PromptDraft,
    modeId: string | null,
    opts?: { adoptSendTimeMode?: boolean }
  ) => void
  dequeue: () => QueuedMessage | undefined
  /** 同步读取权威队列的当前项，用于追加前的 payload 门控。 */
  getItem: (id: string) => QueuedMessage | undefined
  /**
   * 从权威队列中原子移除指定项，并返回实际移除的项；项已被 flush 或不存在
   * 时返回 undefined。
   */
  remove: (id: string) => QueuedMessage | undefined
  reorder: (items: QueuedMessage[]) => void
  /** Prioritize a still-queued item using its latest draft and mode. */
  moveToFront: (id: string) => void
  updateItem: (id: string, draft: PromptDraft) => void
  /**
   * The queue length, read SYNCHRONOUSLY from the authoritative ref — it
   * reflects the same-tick result of an enqueue/requeue/dequeue, before React
   * commits the next render. Callers gating on "is the queue non-empty right
   * now" — the direct-send routing — must use this rather than `queue.length`
   * (which lags a render).
   */
  getQueueLength: () => number
  editingItemId: string | null
  startEditing: (id: string) => void
  cancelEditing: () => void
}

export function useMessageQueue(): UseMessageQueueReturn {
  const [queue, setQueue] = useState<QueuedMessage[]>([])
  const [editingItemId, setEditingItemId] = useState<string | null>(null)
  // Authoritative copy of the queue, updated SYNCHRONOUSLY by every mutation
  // (before the React state commit). Reads that must observe the same-tick
  // result of a mutation — the direct-send queue routing — go through this
  // ref / `getQueueLength`, NOT the `queue` state (which lags until React
  // commits) and NOT a passive-effect-synced mirror (which lags a full
  // render). Without this, a bounce that re-queues a draft leaves a window
  // where a caller still sees an empty queue.
  const queueRef = useRef<QueuedMessage[]>(queue)

  // Update the authoritative ref first, then schedule the render. A plain value
  // (not a functional updater) is correct because `queueRef.current` is always
  // the latest committed value.
  const commit = useCallback((next: QueuedMessage[]) => {
    queueRef.current = next
    setQueue(next)
  }, [])

  const enqueue = useCallback(
    (
      draft: PromptDraft,
      modeId: string | null,
      opts?: { adoptSendTimeMode?: boolean }
    ) => {
      commit([
        ...queueRef.current,
        {
          id: randomUUID(),
          draft,
          modeId,
          ...(opts?.adoptSendTimeMode ? { adoptSendTimeMode: true } : {}),
        },
      ])
    },
    [commit]
  )

  const requeueFront = useCallback(
    (
      draft: PromptDraft,
      modeId: string | null,
      opts?: { adoptSendTimeMode?: boolean }
    ) => {
      commit([
        {
          id: randomUUID(),
          draft,
          modeId,
          ...(opts?.adoptSendTimeMode ? { adoptSendTimeMode: true } : {}),
        },
        ...queueRef.current,
      ])
    },
    [commit]
  )

  const dequeue = useCallback((): QueuedMessage | undefined => {
    const current = queueRef.current
    if (current.length === 0) return undefined
    commit(current.slice(1))
    return current[0]
  }, [commit])

  const getItem = useCallback(
    (id: string) => queueRef.current.find((item) => item.id === id),
    []
  )

  const remove = useCallback(
    (id: string): QueuedMessage | undefined => {
      const current = queueRef.current
      const item = current.find((candidate) => candidate.id === id)
      if (!item) return undefined
      if (editingItemId === id) {
        setEditingItemId(null)
      }
      commit(current.filter((candidate) => candidate.id !== id))
      return item
    },
    [commit, editingItemId]
  )

  const reorder = useCallback(
    (items: QueuedMessage[]) => {
      // Apply a reorder ONLY if it is a true permutation of the live queue, and
      // rebuild it from the AUTHORITATIVE items rather than the caller's
      // (possibly stale) objects. A drag emission carries the queue order from
      // the render it began in; if the live queue changed since (dequeue /
      // requeue / remove / updateItem), the dragged array is stale. Reject any
      // length mismatch, unknown id, or repeated id (e.g. `[A, A]` would
      // otherwise drop `B` and duplicate `A`); commit the current item objects
      // in the requested order so a concurrent `updateItem` isn't clobbered.
      const current = queueRef.current
      if (items.length !== current.length) return
      const byId = new Map(current.map((item) => [item.id, item]))
      const seen = new Set<string>()
      const next: QueuedMessage[] = []
      for (const item of items) {
        const authoritative = byId.get(item.id)
        if (!authoritative || seen.has(item.id)) return
        seen.add(item.id)
        next.push(authoritative)
      }
      commit(next)
    },
    [commit]
  )

  const updateItem = useCallback(
    (id: string, draft: PromptDraft) => {
      commit(
        queueRef.current.map((item) =>
          item.id === id ? { ...item, draft } : item
        )
      )
      setEditingItemId(null)
    },
    [commit]
  )

  const moveToFront = useCallback(
    (id: string) => {
      const current = queueRef.current
      const index = current.findIndex((item) => item.id === id)
      if (index <= 0) return
      commit([current[index], ...current.filter((item) => item.id !== id)])
    },
    [commit]
  )

  const getQueueLength = useCallback(() => queueRef.current.length, [])

  const startEditing = useCallback((id: string) => {
    setEditingItemId(id)
  }, [])

  const cancelEditing = useCallback(() => {
    setEditingItemId(null)
  }, [])

  return {
    queue,
    enqueue,
    requeueFront,
    dequeue,
    getItem,
    remove,
    reorder,
    moveToFront,
    updateItem,
    getQueueLength,
    editingItemId,
    startEditing,
    cancelEditing,
  }
}
