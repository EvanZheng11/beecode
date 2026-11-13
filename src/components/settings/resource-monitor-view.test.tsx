import { fireEvent, render, screen, within } from "@testing-library/react"
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
  launchDirectory: "/work/beecode",
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
    optimizeBusy: false,
    optimizeResult: null,
    optimizeError: null,
    onEnabledChange: vi.fn(),
    onRequestAction: vi.fn(),
    onOptimize: vi.fn(),
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

/** 表格数据行（跳过表头和多组表头行）的名称列文本，按渲染顺序。 */
function rowNames() {
  return screen
    .getAllByRole("row")
    .filter((row) => within(row).queryAllByRole("cell").length > 0)
    .map(
      (row) =>
        within(row).getAllByRole("cell")[0].querySelector("span")
          ?.textContent ?? ""
    )
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

  it("进程用语义表格展示，含 PID、启动目录和完整路径提示", () => {
    setup()
    expect(screen.getByRole("table")).toBeTruthy()
    expect(
      screen.getByRole("columnheader", { name: "Launched from" })
    ).toBeTruthy()
    expect(screen.getByText("42")).toBeTruthy()
    const directory = screen.getByText("/work/beecode")
    expect(directory.getAttribute("title")).toBe("/work/beecode")
    // 危险动作仍是每行的三个按钮，权限来自后端。
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Force kill" })).toBeTruthy()
  })

  it("未知目录如实标注，不伪造路径", () => {
    setup({
      snapshot: snap({ processes: [proc({ launchDirectory: null })] }),
    })
    expect(screen.getByText("Unknown directory")).toBeTruthy()
  })

  it("默认内存降序，点表头双向排序并同步 aria-sort", () => {
    const processes = [
      proc({ pid: 1, name: "small", memoryBytes: 1024, cpuPercent: 50 }),
      proc({ pid: 2, name: "large", memoryBytes: 8192, cpuPercent: 5 }),
      proc({ pid: 3, name: "middle", memoryBytes: 4096, cpuPercent: 20 }),
    ]
    setup({ snapshot: snap({ processes }) })
    expect(rowNames()).toEqual(["large", "middle", "small"])
    const memoryHeader = screen.getByRole("columnheader", { name: "Memory" })
    expect(memoryHeader.getAttribute("aria-sort")).toBe("descending")
    fireEvent.click(screen.getByRole("button", { name: "Memory" }))
    expect(rowNames()).toEqual(["small", "middle", "large"])
    expect(
      screen
        .getByRole("columnheader", { name: "Memory" })
        .getAttribute("aria-sort")
    ).toBe("ascending")
    // 换了列：CPU 首次点击降序，其余列 aria-sort 归零
    fireEvent.click(screen.getByRole("button", { name: "CPU" }))
    expect(rowNames()).toEqual(["small", "middle", "large"])
    expect(
      screen
        .getByRole("columnheader", { name: "Memory" })
        .getAttribute("aria-sort")
    ).toBe("none")
    fireEvent.click(screen.getByRole("button", { name: "CPU" }))
    expect(rowNames()).toEqual(["large", "middle", "small"])
  })

  it("按 PID 和名称排序可用", () => {
    setup({
      snapshot: snap({
        processes: [
          proc({ pid: 30, name: "bravo" }),
          proc({ pid: 10, name: "Alpha" }),
          proc({ pid: 20, name: "charlie" }),
        ],
      }),
    })
    fireEvent.click(screen.getByRole("button", { name: "PID" }))
    expect(rowNames()).toEqual(["Alpha", "charlie", "bravo"])
    fireEvent.click(screen.getByRole("button", { name: "Name" }))
    expect(rowNames()).toEqual(["Alpha", "bravo", "charlie"])
  })

  it("按目录分组显示组汇总，未知目录单独成组", () => {
    setup({
      snapshot: snap({
        processes: [
          proc({
            pid: 1,
            name: "a1",
            launchDirectory: "/work/a",
            cpuPercent: 10,
            memoryBytes: 100,
          }),
          proc({
            pid: 2,
            name: "a2",
            launchDirectory: "/work/a",
            cpuPercent: 5,
            memoryBytes: 200,
          }),
          proc({
            pid: 3,
            name: "b1",
            launchDirectory: "/work/b",
            cpuPercent: 1,
            memoryBytes: 50,
          }),
          proc({
            pid: 4,
            name: "x1",
            launchDirectory: null,
            cpuPercent: 1,
            memoryBytes: 10,
          }),
        ],
      }),
    })
    const toggle = screen.getByRole("button", { name: "Group by directory" })
    expect(toggle.getAttribute("aria-pressed")).toBe("false")
    fireEvent.click(toggle)
    expect(toggle.getAttribute("aria-pressed")).toBe("true")
    const groupHeaders = screen.getAllByRole("rowgroup")
    expect(groupHeaders.length).toBeGreaterThanOrEqual(3)
    // 组头包含目录、进程数、CPU 与内存汇总；内存降序（默认）时 /work/a 在最前
    const firstGroup = screen.getAllByRole("rowheader")[0]
    expect(within(firstGroup).getByText("/work/a")).toBeTruthy()
    expect(within(firstGroup).getByText("2 processes")).toBeTruthy()
    expect(within(firstGroup).getByText(/15\.0%/)).toBeTruthy()
    // 组头和单元格各出现一次“未知目录”
    expect(screen.getAllByText("Unknown directory").length).toBe(2)
    // 组内仍按同一规则排序（内存降序：a2 在 a1 之前）
    expect(rowNames()).toEqual(["a2", "a1", "b1", "x1"])
  })

  it("一键优化按钮在表格外，忙时禁用、结果与失败可见", () => {
    const p = setup({
      optimizeResult: {
        clearedCacheEntries: 12,
        reclaimedMemoryBytes: 3 * 1024 * 1024,
        reclaimedDiskBytes: 0,
        warnings: ["磁盘缓存未清理 xyz"],
      },
    })
    const button = screen.getByRole("button", { name: "Optimize now" })
    // 不在表格内：表格外可点，表格内没有它
    expect(screen.getByRole("table").contains(button as Node)).toBe(false)
    fireEvent.click(button)
    expect(p.onOptimize).toHaveBeenCalledTimes(1)
    expect(screen.getByText("12")).toBeTruthy()
    expect(screen.getByText("3.0 MB")).toBeTruthy()
    expect(screen.getByText("磁盘缓存未清理 xyz")).toBeTruthy()
  })

  it("优化忙碌时按钮禁用并提示，0 回收给出如实说明", () => {
    setup({
      optimizeBusy: true,
      optimizeResult: {
        clearedCacheEntries: 0,
        reclaimedMemoryBytes: 0,
        reclaimedDiskBytes: 0,
        warnings: [],
      },
    })
    const busy = screen.getByRole("button", { name: "Optimizing…" })
    expect(busy).toHaveProperty("disabled", true)
    expect(screen.getByText(/Nothing could be reclaimed/)).toBeTruthy()
  })

  it("优化失败显示错误；关闭监控时按钮仍可用", () => {
    setup({
      enabled: false,
      snapshot: null,
      optimizeError: "回收失败 xyz",
    })
    expect(screen.getByText("回收失败 xyz")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Optimize now" })).toHaveProperty(
      "disabled",
      false
    )
    expect(screen.queryByRole("table")).toBeNull()
  })
})
