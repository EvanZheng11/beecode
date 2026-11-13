import { describe, expect, it } from "vitest"

import type { ResourceMonitorProcess } from "./resource-monitor-types"
import {
  DEFAULT_RESOURCE_MONITOR_SORT,
  ariaSortFor,
  groupProcessesByDirectory,
  normalizeDirectory,
  sortProcesses,
  toggleSort,
  type ResourceMonitorSortState,
} from "./resource-monitor-table"

const proc = (
  o: Partial<ResourceMonitorProcess> = {}
): ResourceMonitorProcess => ({
  pid: 100,
  parentPid: 1,
  startTime: 1,
  name: "alpha",
  category: "plugin",
  ownerLabel: null,
  launchDirectory: "/work/alpha",
  cpuPercent: 1,
  memoryBytes: 1024,
  status: "running",
  uptimeSeconds: 10,
  canStop: true,
  canKill: true,
  canRestart: true,
  actionUnavailableReason: null,
  ...o,
})

const sort = (
  key: ResourceMonitorSortState["key"],
  direction: ResourceMonitorSortState["direction"] = "asc"
): ResourceMonitorSortState => ({ key, direction })

const pids = (list: readonly ResourceMonitorProcess[]) => list.map((p) => p.pid)

describe("监控表格排序状态", () => {
  it("默认按内存降序", () => {
    expect(DEFAULT_RESOURCE_MONITOR_SORT).toEqual({
      key: "memory",
      direction: "desc",
    })
  })

  it("同列切换方向，换列时数值列先降序、文本列先升序", () => {
    expect(toggleSort(sort("memory", "desc"), "memory")).toEqual(
      sort("memory", "asc")
    )
    expect(toggleSort(sort("memory", "desc"), "cpu")).toEqual(
      sort("cpu", "desc")
    )
    expect(toggleSort(sort("memory", "desc"), "name")).toEqual(
      sort("name", "asc")
    )
    expect(toggleSort(sort("pid", "desc"), "pid")).toEqual(sort("pid", "asc"))
  })

  it("aria-sort 只标记当前排序列", () => {
    expect(ariaSortFor(sort("cpu", "asc"), "cpu")).toBe("ascending")
    expect(ariaSortFor(sort("cpu", "desc"), "cpu")).toBe("descending")
    expect(ariaSortFor(sort("cpu", "asc"), "memory")).toBe("none")
  })
})

describe("sortProcesses", () => {
  const list = [
    proc({ pid: 3, name: "charlie", cpuPercent: 5, memoryBytes: 300 }),
    proc({ pid: 1, name: "Alpha", cpuPercent: 50, memoryBytes: 100 }),
    proc({ pid: 2, name: "bravo", cpuPercent: 5, memoryBytes: 200 }),
  ]

  it("CPU / 内存 / PID 双向排序", () => {
    expect(pids(sortProcesses(list, sort("cpu", "desc")))).toEqual([1, 2, 3])
    expect(pids(sortProcesses(list, sort("cpu", "asc")))).toEqual([2, 3, 1])
    expect(pids(sortProcesses(list, sort("memory", "desc")))).toEqual([3, 2, 1])
    expect(pids(sortProcesses(list, sort("memory", "asc")))).toEqual([1, 2, 3])
    expect(pids(sortProcesses(list, sort("pid", "desc")))).toEqual([3, 2, 1])
  })

  it("名称大小写不敏感且双向", () => {
    expect(pids(sortProcesses(list, sort("name", "asc")))).toEqual([1, 2, 3])
    expect(pids(sortProcesses(list, sort("name", "desc")))).toEqual([3, 2, 1])
  })

  it("并列时以 PID、启动时间升序稳定排序，且不修改入参", () => {
    const tied = [
      proc({ pid: 9, startTime: 5, cpuPercent: 5 }),
      proc({ pid: 7, startTime: 9, cpuPercent: 5 }),
      proc({ pid: 7, startTime: 3, cpuPercent: 5 }),
    ]
    const asc = sortProcesses(tied, sort("cpu", "asc"))
    expect(asc.map((p) => `${p.pid}-${p.startTime}`)).toEqual([
      "7-3",
      "7-9",
      "9-5",
    ])
    // 降序只翻转主键，并列次序保持不变。
    const desc = sortProcesses(tied, sort("cpu", "desc"))
    expect(desc.map((p) => `${p.pid}-${p.startTime}`)).toEqual([
      "7-3",
      "7-9",
      "9-5",
    ])
    expect(pids(tied)).toEqual([9, 7, 7])
  })

  it("按目录排序时未知目录始终排在最后", () => {
    const mixed = [
      proc({ pid: 1, launchDirectory: null }),
      proc({ pid: 2, launchDirectory: "/work/b" }),
      proc({ pid: 3, launchDirectory: "/work/a" }),
      proc({ pid: 4, launchDirectory: "   " }),
    ]
    expect(pids(sortProcesses(mixed, sort("directory", "asc")))).toEqual([
      3, 2, 1, 4,
    ])
    expect(pids(sortProcesses(mixed, sort("directory", "desc")))).toEqual([
      2, 3, 1, 4,
    ])
  })

  it("后端暂未返回 launchDirectory 时按未知目录处理，不抛错", () => {
    const legacy = { ...proc({ pid: 5 }), launchDirectory: undefined }
    const sorted = sortProcesses(
      [legacy as unknown as ResourceMonitorProcess, proc({ pid: 6 })],
      sort("directory", "asc")
    )
    expect(pids(sorted)).toEqual([6, 5])
  })

  it("脏数据（NaN）不破坏排序", () => {
    const dirty = [
      proc({ pid: 1, cpuPercent: Number.NaN }),
      proc({ pid: 2, cpuPercent: 10 }),
    ]
    expect(pids(sortProcesses(dirty, sort("cpu", "asc")))).toEqual([1, 2])
  })
})

describe("normalizeDirectory", () => {
  it("去空白与末尾分隔符，空值视为未知", () => {
    expect(normalizeDirectory(" /work/a/ ")).toBe("/work/a")
    expect(normalizeDirectory("/work/a///")).toBe("/work/a")
    expect(normalizeDirectory("/")).toBe("/")
    expect(normalizeDirectory("C:\\work\\a\\")).toBe("C:\\work\\a")
    expect(normalizeDirectory("")).toBeNull()
    expect(normalizeDirectory("   ")).toBeNull()
    expect(normalizeDirectory(null)).toBeNull()
    expect(normalizeDirectory(undefined)).toBeNull()
  })
})

describe("groupProcessesByDirectory", () => {
  const list = [
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
      launchDirectory: "/work/a/",
      cpuPercent: 5,
      memoryBytes: 200,
    }),
    proc({
      pid: 3,
      name: "b1",
      launchDirectory: "/work/b",
      cpuPercent: 20,
      memoryBytes: 50,
    }),
    proc({
      pid: 4,
      name: "x1",
      launchDirectory: null,
      cpuPercent: 1,
      memoryBytes: 10,
    }),
  ]

  it("同一目录（含末尾分隔符）合并，未知目录单独成组并带汇总", () => {
    const groups = groupProcessesByDirectory(list, sort("cpu", "desc"))
    expect(groups.map((g) => g.directory)).toEqual(["/work/b", "/work/a", null])
    const a = groups[1]
    expect(a.processCount).toBe(2)
    expect(a.totalCpuPercent).toBe(15)
    expect(a.totalMemoryBytes).toBe(300)
    expect(pids(a.processes)).toEqual([1, 2])
    expect(groups[2].processCount).toBe(1)
  })

  it("组汇总按 CPU / 内存双向排序，组内同规则", () => {
    const byCpuAsc = groupProcessesByDirectory(list, sort("cpu", "asc"))
    expect(byCpuAsc.map((g) => g.directory)).toEqual([
      null,
      "/work/a",
      "/work/b",
    ])
    expect(pids(byCpuAsc[2].processes)).toEqual([3])

    const byMemoryDesc = groupProcessesByDirectory(list, sort("memory", "desc"))
    expect(byMemoryDesc.map((g) => g.directory)).toEqual([
      "/work/a",
      "/work/b",
      null,
    ])
    // 组内按内存降序：a2(200) 在 a1(100) 之前
    expect(pids(byMemoryDesc[0].processes)).toEqual([2, 1])
  })

  it("按目录列排序时目录名双向，未知目录仍最后", () => {
    expect(
      groupProcessesByDirectory(list, sort("directory", "asc")).map(
        (g) => g.directory
      )
    ).toEqual(["/work/a", "/work/b", null])
    expect(
      groupProcessesByDirectory(list, sort("directory", "desc")).map(
        (g) => g.directory
      )
    ).toEqual(["/work/b", "/work/a", null])
  })

  it("汇总行没有可比的名称/PID/时间时回落到内存总量降序", () => {
    const byName = groupProcessesByDirectory(list, sort("name", "asc"))
    expect(byName.map((g) => g.directory)).toEqual(["/work/a", "/work/b", null])
    // 组内仍按名称升序
    expect(byName[0].processes.map((p) => p.name)).toEqual(["a1", "a2"])
  })

  it("空列表返回空数组", () => {
    expect(groupProcessesByDirectory([], sort("memory", "desc"))).toEqual([])
  })
})
