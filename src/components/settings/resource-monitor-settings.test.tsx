import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ResourceMonitorSettings } from "./resource-monitor-settings"

const { executeAction, optimize, process } = vi.hoisted(() => ({
  executeAction: vi.fn(),
  optimize: vi.fn(),
  process: {
    pid: 12,
    parentPid: 1,
    startTime: 123,
    name: "test-service",
    category: "service",
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
  },
}))

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
vi.mock("@/hooks/use-resource-monitor", () => ({
  useResourceMonitor: () => ({
    enabled: true,
    loading: false,
    saving: false,
    paused: false,
    snapshot: null,
    history: [],
    error: null,
    actionBusy: false,
    optimizeBusy: false,
    optimizeResult: null,
    optimizeError: null,
    changeEnabled: vi.fn(),
    retry: vi.fn(),
    executeAction,
    optimize,
  }),
}))
vi.mock("./resource-monitor-view", () => ({
  ResourceMonitorView: ({
    onRequestAction,
    onOptimize,
  }: {
    onRequestAction: (process: unknown, action: string) => void
    onOptimize: () => void
  }) => (
    <>
      <button onClick={() => onRequestAction(process, "kill")}>
        kill-service
      </button>
      <button onClick={onOptimize}>optimize-now</button>
    </>
  ),
}))

beforeEach(() => {
  executeAction.mockReset()
  optimize.mockReset()
})

describe("监控危险操作确认", () => {
  it("只有二次确认后才调用后端", () => {
    render(<ResourceMonitorSettings />)
    fireEvent.click(screen.getByRole("button", { name: "kill-service" }))
    expect(screen.getByRole("alertdialog")).toBeInTheDocument()
    expect(executeAction).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "confirm" }))
    expect(executeAction).toHaveBeenCalledExactlyOnceWith(process, "kill")
  })

  it("取消不发送进程操作", () => {
    render(<ResourceMonitorSettings />)
    fireEvent.click(screen.getByRole("button", { name: "kill-service" }))
    fireEvent.click(screen.getByRole("button", { name: "cancel" }))
    expect(executeAction).not.toHaveBeenCalled()
  })

  it("一键优化直接走 hook，不需要二次确认", () => {
    render(<ResourceMonitorSettings />)
    fireEvent.click(screen.getByRole("button", { name: "optimize-now" }))
    expect(optimize).toHaveBeenCalledTimes(1)
    expect(executeAction).not.toHaveBeenCalled()
    expect(screen.queryByRole("alertdialog")).toBeNull()
  })
})
