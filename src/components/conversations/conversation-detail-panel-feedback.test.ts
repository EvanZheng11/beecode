import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { transpileModule, ScriptTarget } from "typescript"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useMessageQueue } from "@/hooks/use-message-queue"
import { useSessionFeedback } from "@/hooks/use-session-feedback"
import { acpGetSessionSnapshot, submitSessionFeedback } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { notify } from "@/lib/notify"
import { buildSteerPayload } from "@/lib/prompt-draft"
import { flushRetryDelayMs } from "@/lib/queue-flush"
import type {
  FeedbackItem,
  LiveSessionSnapshot,
  PromptDraft,
} from "@/lib/types"

vi.mock("@/contexts/acp-connections-context", () => ({ useAcpEvent: vi.fn() }))
const tCmp = (key: string) => key
vi.mock("next-intl", () => ({ useTranslations: () => tCmp }))
vi.mock("@/lib/api", () => ({
  acpGetSessionSnapshot: vi.fn(),
  submitSessionFeedback: vi.fn(),
}))
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }))
vi.mock("sonner", () => ({ toast: { info: vi.fn() } }))

const source = readFileSync(
  resolve(
    process.cwd(),
    "src/components/conversations/conversation-detail-panel.tsx"
  ),
  "utf8"
)
const handlerStart = source.indexOf(
  "const handleAppendQueuedAsFeedback = useCallback("
)
const handlerEnd = source.indexOf("\n  const messageListNode = (", handlerStart)
const flushStart = source.indexOf(
  "  useEffect(() => {",
  source.indexOf("// Flush queued messages whenever the agent")
)
const flushEnd = source.indexOf(
  "\n\n",
  source.indexOf(
    "}, [connectionReady, runtimeSyncState, msgQueue.length, appendingQueuedId])",
    flushStart
  )
)
expect(handlerStart).toBeGreaterThan(-1)
expect(handlerEnd).toBeGreaterThan(handlerStart)
expect(flushStart).toBeGreaterThan(-1)
expect(flushEnd).toBeGreaterThan(flushStart)

// 完整面板依赖会话生命周期和工作区布局。直接编译并执行生产回调与 flush
// effect，避免在 harness 中复制待测逻辑；队列、反馈 hook 和 payload 编码均用实物。
const usePanelQueueActions = runInNewContext(
  transpileModule(
    `(function ({ useCallback, useEffect, msgQueue, mqRemove, mqRequeueFront,
      feedback, feedbackSteer, appendingQueuedIdRef, appendingQueuedId,
      setAppendingQueuedId, notify, toErrorMessage, buildSteerPayload, tabId, tCmp,
      connectionReady, connectionReadyRef, runtimeSyncState, flushRetryDelayMs,
      lastFlushBounceAtRef, autoSendQueueRef, handleSendRef, selectedModeIdRef,
      setTimeout, clearTimeout }) {
      ${source.slice(handlerStart, handlerEnd)}
      ${source.slice(flushStart, flushEnd)}
      return handleAppendQueuedAsFeedback
    })`,
    { compilerOptions: { target: ScriptTarget.ES2022 } }
  ).outputText
) as (scope: Record<string, unknown>) => (id: string) => Promise<void>

const mockSnapshot = vi.mocked(acpGetSessionSnapshot)
const mockSubmit = vi.mocked(submitSessionFeedback)
const attachmentDraft: PromptDraft = {
  displayText: "完整反馈文本\n第二行 [截图]",
  blocks: [
    { type: "text", text: "完整反馈文本\n第二行" },
    { type: "image", data: "QUJD", mime_type: "image/png" },
    { type: "resource_link", uri: "file:///notes.md", name: "notes.md" },
  ],
}
const nextDraft: PromptDraft = {
  displayText: "下一条",
  blocks: [{ type: "text", text: "下一条" }],
}
function note(status: FeedbackItem["status"] = "delivered"): FeedbackItem {
  return {
    id: "feedback-1",
    text: attachmentDraft.displayText,
    status,
    created_at: "2026-10-14T00:00:00Z",
  }
}
function snapshot(native = true): LiveSessionSnapshot {
  return {
    feedback: [],
    feedback_tool_available: true,
    native_steering_available: native,
  } as unknown as LiveSessionSnapshot
}

function useQueuePanelHarness({ connectionReady = false } = {}) {
  const queue = useMessageQueue()
  const feedback = useSessionFeedback({
    connectionId: "c1",
    connStatus: "prompting",
    enabled: true,
  })
  const remove = useMemo(() => vi.fn(queue.remove), [queue.remove])
  const requeueFront = useMemo(
    () => vi.fn(queue.requeueFront),
    [queue.requeueFront]
  )
  const [appendingQueuedId, setAppendingQueuedId] = useState<string | null>(
    null
  )
  const appendingQueuedIdRef = useRef<string | null>(null)
  const connectionReadyRef = useRef(connectionReady)
  connectionReadyRef.current = connectionReady
  const lastFlushBounceAtRef = useRef(0)
  const autoSendQueueRef = useRef(queue.dequeue)
  const handleSendRef = useRef(vi.fn())
  const selectedModeIdRef = useRef("当前模式")
  const append = usePanelQueueActions({
    useCallback,
    useEffect,
    msgQueue: queue.queue,
    mqRemove: remove,
    mqRequeueFront: requeueFront,
    feedback,
    feedbackSteer: feedback.steer,
    appendingQueuedIdRef,
    appendingQueuedId,
    setAppendingQueuedId,
    notify,
    toErrorMessage,
    buildSteerPayload,
    tabId: "tab-1",
    tCmp,
    connectionReady,
    connectionReadyRef,
    runtimeSyncState: "idle",
    flushRetryDelayMs,
    lastFlushBounceAtRef,
    autoSendQueueRef,
    handleSendRef,
    selectedModeIdRef,
    setTimeout,
    clearTimeout,
  })
  return {
    queue,
    feedback,
    remove,
    requeueFront,
    appendingQueuedId,
    appendingQueuedIdRef,
    append,
    flushSend: handleSendRef.current,
  }
}

async function setup(connectionReady = false) {
  const harness = renderHook(useQueuePanelHarness, {
    initialProps: { connectionReady },
  })
  await waitFor(() =>
    expect(harness.result.current.feedback.steerAvailable).toBe(true)
  )
  act(() => {
    harness.result.current.queue.enqueue(nextDraft, "下一条模式")
    harness.result.current.queue.enqueue(attachmentDraft, "原模式", {
      adoptSendTimeMode: true,
    })
  })
  return { ...harness, id: harness.result.current.queue.queue[1].id }
}

beforeEach(() => {
  vi.resetAllMocks()
  mockSnapshot.mockResolvedValue(snapshot())
  mockSubmit.mockResolvedValue(note())
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("ConversationDetailPanel 追加队列反馈行为", () => {
  it.each(["delivered", "pending"] as const)(
    "steer %s 成功保持移除、完整传递文本与 blocks，不再次回队",
    async (status) => {
      const { result, id } = await setup()
      const accepted = note(status)
      mockSubmit.mockResolvedValue(accepted)
      await act(async () => {
        await result.current.append(id)
      })
      expect(result.current.remove).toHaveBeenCalledTimes(1)
      expect(result.current.remove).toHaveBeenCalledWith(id)
      expect(mockSubmit).toHaveBeenCalledTimes(1)
      expect(mockSubmit).toHaveBeenCalledWith(
        "c1",
        attachmentDraft.displayText,
        attachmentDraft.blocks
      )
      expect(mockSubmit.mock.calls[0][2]).toBe(attachmentDraft.blocks)
      expect(result.current.queue.queue.map((item) => item.draft)).toEqual([
        nextDraft,
      ])
      expect(result.current.feedback.notes).toEqual([accepted])
      expect(result.current.requeueFront).not.toHaveBeenCalled()
      expect(notify).not.toHaveBeenCalled()
      expect(result.current.appendingQueuedId).toBeNull()
      expect(result.current.appendingQueuedIdRef.current).toBeNull()
      if (status === "pending")
        expect(result.current.feedback.channel).toBe("pull")
    }
  )

  it("内部降级仍返回 delivered 时不回队，并接受反馈 hook 的通道转换", async () => {
    const { result, id } = await setup()
    mockSnapshot.mockResolvedValue(snapshot(false))
    await act(async () => {
      await result.current.append(id)
    })
    expect(result.current.feedback.channel).toBe("pull")
    expect(result.current.feedback.notes).toEqual([note()])
    expect(result.current.queue.queue.map((item) => item.draft)).toEqual([
      nextDraft,
    ])
    expect(result.current.remove).toHaveBeenCalledTimes(1)
    expect(result.current.remove).toHaveBeenCalledWith(id)
    expect(result.current.requeueFront).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it.each([true, false])(
    "steer reject 恢复原 draft、mode 和 adoptSendTimeMode 到队首，提示失败（native=%s）",
    async (native) => {
      mockSnapshot.mockResolvedValue(snapshot(native))
      const { result, id } = await setup()
      mockSubmit.mockRejectedValue(new Error("反馈提交失败"))
      await act(async () => {
        await result.current.append(id)
      })
      expect(result.current.remove).toHaveBeenCalledTimes(1)
      expect(result.current.remove).toHaveBeenCalledWith(id)
      expect(result.current.requeueFront).toHaveBeenCalledTimes(1)
      expect(result.current.requeueFront).toHaveBeenCalledWith(
        attachmentDraft,
        "原模式",
        { adoptSendTimeMode: true }
      )
      const restored = result.current.queue.queue[0]
      expect(restored.draft).toBe(attachmentDraft)
      expect(restored.modeId).toBe("原模式")
      expect(restored.adoptSendTimeMode).toBe(true)
      expect(result.current.queue.queue[1].draft).toBe(nextDraft)
      expect(result.current.feedback.notes).toEqual([])
      expect(notify).toHaveBeenCalledTimes(1)
      expect(notify).toHaveBeenCalledWith({
        level: "error",
        key: "steer-failed:tab-1",
        title: native ? "steerFailed" : "steerNoteFailed",
        description: "反馈提交失败",
      })
      expect(result.current.appendingQueuedId).toBeNull()
      expect(result.current.appendingQueuedIdRef.current).toBeNull()
    }
  )

  it("同 tick 重复、另一项竞争和重渲染后的追加只提交一次，完成后释放锁", async () => {
    const { result, id } = await setup()
    const otherId = result.current.queue.queue[0].id
    let release!: (item: FeedbackItem) => void
    mockSubmit.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const originalAppend = result.current.append
    let pending!: Promise<void>
    act(() => {
      pending = originalAppend(id)
      void originalAppend(id)
      void originalAppend(otherId)
    })
    expect(result.current.appendingQueuedId).toBe(id)
    expect(result.current.appendingQueuedIdRef.current).toBe(id)
    expect(result.current.queue.queue.map((item) => item.id)).toEqual([otherId])
    act(() => {
      void result.current.append(otherId)
    })
    expect(mockSubmit).toHaveBeenCalledTimes(1)
    expect(result.current.remove).toHaveBeenCalledTimes(1)
    expect(result.current.remove).toHaveBeenCalledWith(id)
    await act(async () => {
      release(note())
      await pending
    })
    await act(async () => {
      await result.current.append(otherId)
    })
    expect(mockSubmit).toHaveBeenCalledTimes(2)
    expect(result.current.queue.queue).toEqual([])
    expect(result.current.requeueFront).not.toHaveBeenCalled()
  })

  it("不存在或空 payload 的队列项不修改队列、不调用后端", async () => {
    const { result } = await setup()
    const emptyDraft: PromptDraft = {
      displayText: "",
      blocks: [{ type: "image", data: "QUJD", mime_type: "image/png" }],
    }
    act(() => {
      result.current.queue.enqueue(emptyDraft, null)
    })
    const before = result.current.queue.queue
    await act(async () => {
      await result.current.append("missing")
      await result.current.append(before[2].id)
    })
    expect(result.current.queue.queue).toBe(before)
    expect(result.current.remove).not.toHaveBeenCalled()
    expect(result.current.requeueFront).not.toHaveBeenCalled()
    expect(mockSubmit).not.toHaveBeenCalled()
  })

  it("追加期间即使连接就绪也暂停 flush，完成后恢复剩余队列", async () => {
    const { result, rerender, id } = await setup()
    vi.useFakeTimers()
    let release!: (item: FeedbackItem) => void
    mockSubmit.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    let pending!: Promise<void>
    act(() => {
      pending = result.current.append(id)
    })
    rerender({ connectionReady: true })
    act(() => {
      vi.runOnlyPendingTimers()
    })
    expect(result.current.flushSend).not.toHaveBeenCalled()
    expect(result.current.queue.queue.map((item) => item.draft)).toEqual([
      nextDraft,
    ])
    await act(async () => {
      release(note())
      await pending
    })
    act(() => {
      vi.runOnlyPendingTimers()
    })
    expect(result.current.flushSend).toHaveBeenCalledTimes(1)
    expect(result.current.flushSend).toHaveBeenCalledWith(
      nextDraft,
      "下一条模式",
      { fromQueueFlush: true }
    )
    expect(result.current.queue.queue).toEqual([])
  })
})
