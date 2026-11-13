import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useResourceMonitor } from "./use-resource-monitor"

const { call } = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock("@/lib/transport", () => ({ getTransport: () => ({ call }) }))

function sample(at = 1000) {
  return {
    enabled: true,
    sampledAt: at,
    sampleIntervalMs: 2000,
    collectionDurationMs: 1,
    totalCpuPercent: 5,
    totalMemoryBytes: 1024,
    activeProcessCount: 0,
    processes: [],
    warnings: [],
  }
}

async function settle() {
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  call.mockReset()
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: false,
  })
  call.mockImplementation(
    async (command: string, args?: { enabled: boolean }) => {
      if (command === "get_resource_monitor_settings") return { enabled: false }
      if (command === "set_resource_monitor_enabled") return args
      return sample()
    }
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("资源监控按需采样", () => {
  it("默认关闭时只读取设置，不启动采样", async () => {
    const { result } = renderHook(useResourceMonitor)
    await settle()
    await act(async () => vi.advanceTimersByTimeAsync(10000))
    expect(result.current.enabled).toBe(false)
    expect(result.current.loading).toBe(false)
    expect(call.mock.calls.map(([command]) => command)).toEqual([
      "get_resource_monitor_settings",
    ])
  })

  it("开启后实时更新，历史最多60点，关闭和卸载均停止请求", async () => {
    let time = 0
    call.mockImplementation(
      async (command: string, args?: { enabled: boolean }) => {
        if (command === "get_resource_monitor_settings")
          return { enabled: false }
        if (command === "set_resource_monitor_enabled") return args
        return sample(++time)
      }
    )
    const { result, unmount } = renderHook(useResourceMonitor)
    await settle()
    await act(async () => result.current.changeEnabled(true))
    expect(result.current.snapshot?.totalCpuPercent).toBe(5)
    await act(async () => vi.advanceTimersByTimeAsync(130000))
    expect(result.current.history).toHaveLength(60)
    await act(async () => result.current.changeEnabled(false))
    const calls = call.mock.calls.length
    await act(async () => vi.advanceTimersByTimeAsync(10000))
    expect(call).toHaveBeenCalledTimes(calls)
    expect(result.current.history).toEqual([])
    await act(async () => result.current.changeEnabled(true))
    unmount()
    const afterUnmount = call.mock.calls.length
    await act(async () => vi.advanceTimersByTimeAsync(10000))
    expect(call).toHaveBeenCalledTimes(afterUnmount)
  })

  it("隐藏页面停止刷新，返回时重新采样", async () => {
    const { result } = renderHook(useResourceMonitor)
    await settle()
    await act(async () => result.current.changeEnabled(true))
    act(() => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: true,
      })
      document.dispatchEvent(new Event("visibilitychange"))
    })
    const calls = call.mock.calls.length
    await act(async () => vi.advanceTimersByTimeAsync(10000))
    expect(call).toHaveBeenCalledTimes(calls)
    expect(result.current.paused).toBe(true)
    act(() => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: false,
      })
      document.dispatchEvent(new Event("visibilitychange"))
    })
    await settle()
    expect(call).toHaveBeenCalledTimes(calls + 1)
    expect(result.current.paused).toBe(false)
  })

  it("慢请求不重入，关停之后返回的旧样本被丢弃", async () => {
    let resolveSample!: (value: ReturnType<typeof sample>) => void
    call.mockImplementation(
      async (command: string, args?: { enabled: boolean }) => {
        if (command === "get_resource_monitor_settings")
          return { enabled: false }
        if (command === "set_resource_monitor_enabled") return args
        return new Promise((resolve) => {
          resolveSample = resolve
        })
      }
    )
    const { result } = renderHook(useResourceMonitor)
    await settle()
    await act(async () => result.current.changeEnabled(true))
    await act(async () => vi.advanceTimersByTimeAsync(10000))
    expect(
      call.mock.calls.filter(([cmd]) => cmd === "get_resource_monitor_snapshot")
    ).toHaveLength(1)
    await act(async () => result.current.changeEnabled(false))
    await act(async () => resolveSample(sample()))
    expect(result.current.snapshot).toBeNull()
    expect(result.current.history).toEqual([])
  })

  it("失败可见，手动重试后恢复", async () => {
    call.mockRejectedValueOnce(new Error("读取设置失败"))
    const { result } = renderHook(useResourceMonitor)
    await settle()
    expect(result.current.error).toBe("读取设置失败")
    act(() => result.current.retry())
    await settle()
    expect(result.current.error).toBeNull()
  })

  it("操作失败不被后续正常采样悄悄清除，也不自动重试动作", async () => {
    const { result } = renderHook(useResourceMonitor)
    await settle()
    await act(async () => result.current.changeEnabled(true))
    const process = {
      pid: 13,
      parentPid: 1,
      startTime: 123,
      name: "test",
      category: "service" as const,
      ownerLabel: null,
      launchDirectory: "/work/beecode",
      cpuPercent: 0,
      memoryBytes: 0,
      status: "sleeping",
      uptimeSeconds: 1,
      canStop: true,
      canKill: true,
      canRestart: false,
      actionUnavailableReason: null,
    }
    call.mockImplementation(async (command: string) => {
      if (command === "resource_monitor_process_action")
        throw new Error("操作被拒绝")
      return sample(Date.now())
    })
    await act(async () => result.current.executeAction(process, "stop"))
    await act(async () => vi.advanceTimersByTimeAsync(6000))
    expect(result.current.error).toBe("操作被拒绝")
    expect(
      call.mock.calls.filter(
        ([cmd]) => cmd === "resource_monitor_process_action"
      )
    ).toHaveLength(1)
  })

  it("进程操作用启动标识提交，拒绝重复和不支持的动作", async () => {
    let finish!: () => void
    const { result } = renderHook(useResourceMonitor)
    await settle()
    await act(async () => result.current.changeEnabled(true))
    const process = {
      pid: 12,
      parentPid: 1,
      startTime: 123,
      name: "test",
      category: "process" as const,
      ownerLabel: null,
      launchDirectory: "/work/beecode",
      cpuPercent: 0,
      memoryBytes: 0,
      status: "sleeping",
      uptimeSeconds: 1,
      canStop: true,
      canKill: true,
      canRestart: false,
      actionUnavailableReason: null,
    }
    call.mockImplementation(async (command: string) => {
      if (command === "resource_monitor_process_action") {
        return new Promise<void>((resolve) => {
          finish = resolve
        })
      }
      return sample()
    })
    act(() => {
      void result.current.executeAction(process, "kill")
    })
    expect(result.current.actionBusy).toBe(true)
    await act(async () => result.current.executeAction(process, "kill"))
    await act(async () => result.current.executeAction(process, "restart"))
    expect(
      call.mock.calls.filter(
        ([cmd]) => cmd === "resource_monitor_process_action"
      )
    ).toEqual([
      [
        "resource_monitor_process_action",
        { pid: 12, startTime: 123, action: "kill" },
      ],
    ])
    await act(async () => finish())
    expect(result.current.actionBusy).toBe(false)
  })
})

const optimizeResult = {
  clearedCacheEntries: 3,
  reclaimedMemoryBytes: 2048,
  reclaimedDiskBytes: 0,
  warnings: ["磁盘缓存未清理"],
}

describe("一键优化", () => {
  it("监控关闭时也能调用，结果独立展示且不发起采样", async () => {
    call.mockImplementation(async (command: string) => {
      if (command === "get_resource_monitor_settings") return { enabled: false }
      if (command === "resource_monitor_optimize") return optimizeResult
      return sample()
    })
    const { result } = renderHook(useResourceMonitor)
    await settle()
    expect(result.current.enabled).toBe(false)
    await act(async () => result.current.optimize())
    expect(result.current.optimizeResult).toEqual(optimizeResult)
    expect(result.current.optimizeError).toBeNull()
    expect(result.current.optimizeBusy).toBe(false)
    expect(
      call.mock.calls.filter(([cmd]) => cmd === "get_resource_monitor_snapshot")
    ).toHaveLength(0)
  })

  it("监控开启时优化成功后立即刷新一次样本", async () => {
    call.mockImplementation(
      async (command: string, args?: { enabled: boolean }) => {
        if (command === "get_resource_monitor_settings")
          return { enabled: false }
        if (command === "set_resource_monitor_enabled") return args
        if (command === "resource_monitor_optimize") return optimizeResult
        return sample()
      }
    )
    const { result } = renderHook(useResourceMonitor)
    await settle()
    await act(async () => result.current.changeEnabled(true))
    const before = call.mock.calls.filter(
      ([cmd]) => cmd === "get_resource_monitor_snapshot"
    ).length
    await act(async () => result.current.optimize())
    expect(
      call.mock.calls.filter(([cmd]) => cmd === "get_resource_monitor_snapshot")
        .length
    ).toBe(before + 1)
  })

  it("忙碌中忽略重复触发，卸载后不再更新状态", async () => {
    let finish!: (value: typeof optimizeResult) => void
    call.mockImplementation((command: string) => {
      if (command === "get_resource_monitor_settings")
        return Promise.resolve({ enabled: false })
      if (command === "resource_monitor_optimize")
        return new Promise((resolve) => {
          finish = resolve
        })
      return Promise.resolve(sample())
    })
    const { result, unmount } = renderHook(useResourceMonitor)
    await settle()
    act(() => {
      void result.current.optimize()
    })
    expect(result.current.optimizeBusy).toBe(true)
    await act(async () => result.current.optimize())
    expect(
      call.mock.calls.filter(([cmd]) => cmd === "resource_monitor_optimize")
    ).toHaveLength(1)
    unmount()
    await act(async () => finish(optimizeResult))
  })

  it("失败时说明原因、清空旧结果，且不混入监控错误", async () => {
    call.mockImplementation(async (command: string) => {
      if (command === "get_resource_monitor_settings") return { enabled: false }
      if (command === "resource_monitor_optimize") throw new Error("回收失败")
      return sample()
    })
    const { result } = renderHook(useResourceMonitor)
    await settle()
    await act(async () => result.current.optimize())
    expect(result.current.optimizeError).toBe("回收失败")
    expect(result.current.optimizeResult).toBeNull()
    expect(result.current.optimizeBusy).toBe(false)
    expect(result.current.error).toBeNull()
  })
})
