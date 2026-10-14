import { describe, it, expect } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useMessageQueue } from "./use-message-queue"
import type { PromptDraft } from "@/lib/types"

function draft(text: string): PromptDraft {
  return { blocks: [{ type: "text", text }], displayText: text }
}

function texts(q: { draft: PromptDraft }[]): string[] {
  return q.map((item) => item.draft.displayText)
}

describe("useMessageQueue bounce FIFO ordering", () => {
  it("prioritizes a clicked item using its latest draft and mode without dropping new items", () => {
    const { result } = renderHook(() => useMessageQueue())
    act(() => {
      result.current.enqueue(draft("A"), null)
      result.current.enqueue(draft("B"), "plan", { adoptSendTimeMode: true })
    })
    const target = result.current.queue[1]
    act(() => {
      result.current.updateItem(target.id, draft("edited B"))
      result.current.enqueue(draft("C"), "agent")
      result.current.moveToFront(target.id)
    })
    expect(texts(result.current.queue)).toEqual(["edited B", "A", "C"])
    expect(result.current.queue[0]).toMatchObject({
      id: target.id,
      modeId: "plan",
      adoptSendTimeMode: true,
    })
    let sent: ReturnType<typeof result.current.dequeue>
    act(() => {
      sent = result.current.dequeue()
    })
    expect(sent).toEqual({
      ...target,
      draft: draft("edited B"),
    })
  })

  it("does not resurrect a removed item when an insertion reply arrives late", () => {
    const { result } = renderHook(() => useMessageQueue())
    act(() => {
      result.current.enqueue(draft("A"), null)
      result.current.enqueue(draft("B"), null)
    })
    const target = result.current.queue[1]
    act(() => {
      result.current.remove(target.id)
      result.current.moveToFront(target.id)
    })
    expect(texts(result.current.queue)).toEqual(["A"])
  })

  it("remove 返回权威项，已被其他路径移除时返回 undefined", () => {
    const { result } = renderHook(() => useMessageQueue())
    act(() => result.current.enqueue(draft("A"), null))
    const id = result.current.queue[0].id
    let removed: ReturnType<typeof result.current.remove>
    act(() => {
      result.current.updateItem(id, draft("edited A"))
      expect(result.current.getItem(id)?.draft.displayText).toBe("edited A")
      removed = result.current.remove(id)
      expect(result.current.getItem(id)).toBeUndefined()
    })
    expect(removed?.id).toBe(id)
    expect(removed?.draft.displayText).toBe("edited A")
    act(() => {
      removed = result.current.remove(id)
    })
    expect(removed).toBeUndefined()
  })

  it("requeueFront keeps a bounced head ahead of items behind it", () => {
    const { result } = renderHook(() => useMessageQueue())

    // Queue [A, B].
    act(() => result.current.enqueue(draft("A"), null))
    act(() => result.current.enqueue(draft("B"), null))
    expect(texts(result.current.queue)).toEqual(["A", "B"])

    // The auto-flush dequeues the head (A) and sends it.
    let dequeued: ReturnType<typeof result.current.dequeue>
    act(() => {
      dequeued = result.current.dequeue()
    })
    expect(dequeued?.draft.displayText).toBe("A")
    expect(texts(result.current.queue)).toEqual(["B"])

    // A bounces (TurnBusyError) → re-queued at the FRONT, NOT the tail, so it
    // retries before B. (Re-enqueuing at the tail here would yield [B, A] and
    // send B before A — the FIFO regression this guards against.)
    act(() => result.current.requeueFront(draft("A"), null))
    expect(texts(result.current.queue)).toEqual(["A", "B"])

    // The next flush therefore dequeues A again, not B.
    act(() => {
      dequeued = result.current.dequeue()
    })
    expect(dequeued?.draft.displayText).toBe("A")
  })

  it("requeueFront preserves adoptSendTimeMode via opts (append-failure recovery)", () => {
    const { result } = renderHook(() => useMessageQueue())
    act(() => result.current.enqueue(draft("A"), null))

    // 追加为实时反馈失败：原始项的 adoptSendTimeMode 随 requeueFront 回队首，
    // 发送时机语义不丢失；队首语义保持（它先于后面的项被 flush）。
    act(() =>
      result.current.requeueFront(draft("B"), null, {
        adoptSendTimeMode: true,
      })
    )
    expect(texts(result.current.queue)).toEqual(["B", "A"])
    expect(result.current.queue[0]).toMatchObject({
      modeId: null,
      adoptSendTimeMode: true,
    })

    // 不传 opts 的既有调用（TurnBusyError 弹回）不新增该字段。
    act(() => result.current.requeueFront(draft("C"), "plan"))
    expect(result.current.queue[0]).not.toHaveProperty("adoptSendTimeMode")
    expect(texts(result.current.queue)).toEqual(["C", "B", "A"])
  })

  it("enqueue still appends to the tail (front vs tail are distinct)", () => {
    const { result } = renderHook(() => useMessageQueue())
    act(() => result.current.enqueue(draft("A"), null))
    act(() => result.current.enqueue(draft("tail"), null))
    act(() => result.current.requeueFront(draft("front"), null))
    expect(texts(result.current.queue)).toEqual(["front", "A", "tail"])
  })

  it("getQueueLength reflects mutations SYNCHRONOUSLY (same tick, before re-render)", () => {
    const { result } = renderHook(() => useMessageQueue())
    // Multiple mutations within a single act() — getQueueLength must observe
    // each one immediately, without waiting for a React commit. This is what
    // the direct-send routing relies on: a draft re-queued by a same-tick
    // bounce must be visible before the next send decides whether to tail-route.
    act(() => {
      expect(result.current.getQueueLength()).toBe(0)
      result.current.enqueue(draft("A"), null)
      expect(result.current.getQueueLength()).toBe(1)
      result.current.requeueFront(draft("B"), null)
      expect(result.current.getQueueLength()).toBe(2)
      result.current.dequeue()
      expect(result.current.getQueueLength()).toBe(1)
    })
    // After commit the rendered queue matches the authoritative ref.
    expect(texts(result.current.queue)).toEqual(["A"])
    expect(result.current.getQueueLength()).toBe(1)
  })

  it("applies a valid reorder (a permutation of the live queue)", () => {
    const { result } = renderHook(() => useMessageQueue())
    act(() => result.current.enqueue(draft("A"), null))
    act(() => result.current.enqueue(draft("B"), null))
    const [a, b] = result.current.queue
    act(() => result.current.reorder([b, a]))
    expect(texts(result.current.queue)).toEqual(["B", "A"])
  })

  it("ignores a STALE reorder whose id set no longer matches (no resurrect/drop)", () => {
    const { result } = renderHook(() => useMessageQueue())
    act(() => result.current.enqueue(draft("A"), null))
    act(() => result.current.enqueue(draft("B"), null))
    const stale = [...result.current.queue].reverse() // snapshot of [A, B] → [B, A]
    // The queue changes (A dequeued) AFTER the drag snapshot was taken.
    act(() => result.current.dequeue())
    expect(texts(result.current.queue)).toEqual(["B"])
    // Applying the stale [B, A] order would resurrect A — it must be ignored.
    act(() => result.current.reorder(stale))
    expect(texts(result.current.queue)).toEqual(["B"])
  })

  it("ignores a reorder containing a duplicate id (would drop another item)", () => {
    const { result } = renderHook(() => useMessageQueue())
    act(() => result.current.enqueue(draft("A"), null))
    act(() => result.current.enqueue(draft("B"), null))
    const [a] = result.current.queue
    // [A, A] matches length + membership but is NOT a permutation — applying it
    // would duplicate A and drop B. Must be ignored.
    act(() => result.current.reorder([a, a]))
    expect(texts(result.current.queue)).toEqual(["A", "B"])
  })

  it("reorders the AUTHORITATIVE items, not the caller's stale objects", () => {
    const { result } = renderHook(() => useMessageQueue())
    act(() => result.current.enqueue(draft("A"), null))
    act(() => result.current.enqueue(draft("B"), null))
    const [a, b] = result.current.queue
    // A is edited AFTER the drag snapshot [a, b] was captured.
    act(() => result.current.updateItem(a.id, draft("A-edited")))
    // The stale reorder carries the OLD `a` object (draft "A"); the commit must
    // use the authoritative edited A (by id), only applying the requested order.
    act(() => result.current.reorder([b, a]))
    expect(texts(result.current.queue)).toEqual(["B", "A-edited"])
  })
})
