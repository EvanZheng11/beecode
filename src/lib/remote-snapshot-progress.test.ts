import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  beginRemoteSnapshotPreparing,
  clearAllRemoteSnapshotProgress,
  clearRemoteSnapshotProgress,
  consumeRemoteSnapshotDegraded,
  endRemoteSnapshotDone,
  getRemoteSnapshotProgress,
  subscribeRemoteSnapshotProgress,
} from "@/lib/remote-snapshot-progress"

/**
 * 远程文件快照进度（设计 4.1.3.1 / 7.4）：按连接隔离的进行中计数 + 一次性降级
 * 队列。这里只验证这份状态机 —— 事件接线与输入框渲染各有自己的测试。
 */

describe("remote snapshot progress", () => {
  beforeEach(() => {
    clearAllRemoteSnapshotProgress()
  })

  afterEach(() => {
    clearAllRemoteSnapshotProgress()
    vi.useRealTimers()
  })

  it("starts empty and stays reference-stable for an untouched connection", () => {
    const a = getRemoteSnapshotProgress("conv-a")
    const b = getRemoteSnapshotProgress("conv-a")
    expect(a).toEqual({ preparing: 0, degraded: [] })
    expect(a).toBe(b)
  })

  it("records the preparing count and clears it on done", () => {
    beginRemoteSnapshotPreparing("conv-a", 3)
    expect(getRemoteSnapshotProgress("conv-a").preparing).toBe(3)

    endRemoteSnapshotDone("conv-a", [])
    expect(getRemoteSnapshotProgress("conv-a")).toEqual({
      preparing: 0,
      degraded: [],
    })
  })

  it("keeps two connections' progresses isolated", () => {
    beginRemoteSnapshotPreparing("conv-a", 2)
    beginRemoteSnapshotPreparing("conv-b", 1)
    expect(getRemoteSnapshotProgress("conv-a").preparing).toBe(2)
    expect(getRemoteSnapshotProgress("conv-b").preparing).toBe(1)

    endRemoteSnapshotDone("conv-a", [])
    expect(getRemoteSnapshotProgress("conv-a").preparing).toBe(0)
    expect(getRemoteSnapshotProgress("conv-b").preparing).toBe(1)
  })

  it("hands the degraded items over exactly once", () => {
    endRemoteSnapshotDone("conv-a", [
      {
        uri: "codeg://remote/7/file/src/a.ts",
        reason: "too_large",
        bytes: 900,
      },
      { uri: "codeg://remote/7/file/logo.png", reason: "binary" },
    ])
    expect(consumeRemoteSnapshotDegraded("conv-a")).toHaveLength(2)
    // 第二次读不到东西：重渲染/严格模式不会重复 toast。
    expect(consumeRemoteSnapshotDegraded("conv-a")).toEqual([])
  })

  it("ignores malformed degraded entries instead of surfacing them", () => {
    endRemoteSnapshotDone("conv-a", [
      { uri: "codeg://remote/7/file/a.ts" },
      { reason: "timeout" },
      { uri: "codeg://remote/7/file/b.ts", reason: "timeout" },
    ] as never)
    const items = consumeRemoteSnapshotDegraded("conv-a")
    expect(items).toEqual([
      { uri: "codeg://remote/7/file/b.ts", reason: "timeout" },
    ])
  })

  it("notifies subscribers per connection and stops after unsubscribe", () => {
    const onChangeA = vi.fn()
    const onChangeB = vi.fn()
    const offA = subscribeRemoteSnapshotProgress("conv-a", onChangeA)
    const offB = subscribeRemoteSnapshotProgress("conv-b", onChangeB)

    beginRemoteSnapshotPreparing("conv-a", 1)
    expect(onChangeA).toHaveBeenCalledTimes(1)
    expect(onChangeB).not.toHaveBeenCalled()

    endRemoteSnapshotDone("conv-a", [{ uri: "u", reason: "r" }])
    expect(onChangeA).toHaveBeenCalledTimes(2)

    offA()
    offB()
    beginRemoteSnapshotPreparing("conv-a", 2)
    expect(onChangeA).toHaveBeenCalledTimes(2)
  })

  it("clears a removed connection's progress and timer", () => {
    vi.useFakeTimers()
    beginRemoteSnapshotPreparing("conv-a", 4)
    clearRemoteSnapshotProgress("conv-a")
    expect(getRemoteSnapshotProgress("conv-a").preparing).toBe(0)
    // 计时器已随之取消：推进时间不会再触发任何写入。
    const onChange = vi.fn()
    subscribeRemoteSnapshotProgress("conv-a", onChange)
    vi.advanceTimersByTime(120_000)
    expect(onChange).not.toHaveBeenCalled()
  })

  it("drops a preparing count nothing ever finishes (backend died / event lost)", () => {
    vi.useFakeTimers()
    beginRemoteSnapshotPreparing("conv-a", 2)
    expect(getRemoteSnapshotProgress("conv-a").preparing).toBe(2)
    vi.advanceTimersByTime(46_000)
    expect(getRemoteSnapshotProgress("conv-a").preparing).toBe(0)
  })

  it("treats a zero / invalid count as nothing preparing", () => {
    beginRemoteSnapshotPreparing("conv-a", 0)
    expect(getRemoteSnapshotProgress("conv-a").preparing).toBe(0)
    beginRemoteSnapshotPreparing("conv-a", Number.NaN)
    expect(getRemoteSnapshotProgress("conv-a").preparing).toBe(0)
  })
})
