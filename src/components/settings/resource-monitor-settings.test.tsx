import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ResourceMonitorSettings } from "./resource-monitor-settings"

const { executeAction, process } = vi.hoisted(() => ({
  executeAction: vi.fn(),
  process: {
    pid: 12,
    parentPid: 1,
    startTime: 123,
    name: "test-service",
    category: "service",
    ownerLabel: null,
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
    changeEnabled: vi.fn(),
    retry: vi.fn(),
    executeAction,
  }),
}))
vi.mock("./resource-monitor-view", () => ({
  ResourceMonitorView: ({
    onRequestAction,
  }: {
    onRequestAction: (process: unknown, action: string) => void
  }) => (
    <button onClick={() => onRequestAction(process, "kill")}>
      kill-service
    </button>
  ),
}))

beforeEach(() => executeAction.mockReset())

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
})
