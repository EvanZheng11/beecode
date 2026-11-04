import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type {
  ResourceMonitorProcess,
  ResourceMonitorSnapshot,
} from "@/lib/resource-monitor-types"

import {
  ResourceMonitorView,
  type ResourceMonitorViewProps,
} from "./resource-monitor-view"

const proc = (
  o: Partial<ResourceMonitorProcess> = {}
): ResourceMonitorProcess => ({
  pid: 42,
  parentPid: 1,
  startTime: 1,
  name: "codeg-mcp",
  category: "plugin",
  ownerLabel: "Claude",
  cpuPercent: 12.34,
  memoryBytes: 5 * 1024 * 1024,
  status: "running",
  uptimeSeconds: 3700,
  canStop: true,
  canKill: false,
  canRestart: true,
  actionUnavailableReason: "仅可由应用管理",
  ...o,
})

const snap = (
  o: Partial<ResourceMonitorSnapshot> = {}
): ResourceMonitorSnapshot => ({
  enabled: true,
  sampledAt: 1,
  sampleIntervalMs: 2000,
  collectionDurationMs: 7,
  totalCpuPercent: 150,
  totalMemoryBytes: 2 * 1024 ** 3,
  activeProcessCount: 1,
  processes: [proc()],
  warnings: ["采集不完整 xyz"],
  ...o,
})

function setup(o: Partial<ResourceMonitorViewProps> = {}) {
  const props: ResourceMonitorViewProps = {
    enabled: true,
    loading: false,
    saving: false,
    paused: false,
    snapshot: snap(),
    history: [
      { sampledAt: 1, cpuPercent: 10, memoryBytes: 100 },
      { sampledAt: 2, cpuPercent: 20, memoryBytes: 200 },
    ],
    error: null,
    actionBusy: false,
    onEnabledChange: vi.fn(),
    onRequestAction: vi.fn(),
    onRetry: vi.fn(),
    ...o,
  }
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ResourceMonitorView {...props} />
    </NextIntlClientProvider>
  )
  return props
}

describe("ResourceMonitorView", () => {
  it("关闭时只显示提示，开关触发回调", () => {
    const p = setup({ enabled: false, snapshot: null })
    expect(screen.getByText(/Monitoring is off/)).toBeTruthy()
    fireEvent.click(screen.getByRole("switch"))
    expect(p.onEnabledChange).toHaveBeenCalledWith(true)
  })

  it("展示指标、警告、进程并按 can 禁用动作", () => {
    const p = setup()
    expect(screen.getAllByText("150.0%").length).toBe(2)
    expect(screen.getAllByText("2.0 GB").length).toBe(2)
    expect(screen.getByText("采集不完整 xyz")).toBeTruthy()
    expect(screen.getByText("仅可由应用管理")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Force kill" })).toHaveProperty(
      "disabled",
      true
    )
    fireEvent.click(screen.getByRole("button", { name: "Restart" }))
    expect(p.onRequestAction).toHaveBeenCalledWith(
      p.snapshot!.processes[0],
      "restart"
    )
  })

  it("actionBusy 禁用全部动作；错误可重试；加载态", () => {
    const p = setup({ actionBusy: true, error: "boom" })
    expect(screen.getByRole("button", { name: "Stop" })).toHaveProperty(
      "disabled",
      true
    )
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(p.onRetry).toHaveBeenCalled()
  })

  it("加载中无快照显示加载", () => {
    setup({ loading: true, snapshot: null })
    expect(screen.getByText("Loading…")).toBeTruthy()
  })
})
