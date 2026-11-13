/**
 * 资源监控表格的纯排序与分组逻辑。
 *
 * 不依赖 React、i18n 和 DOM，便于单测；界面只负责渲染。
 * 所有排序都是稳定的：并列时先按 PID、再按启动时间升序，
 * 因此采样刷新（同样数据）不会让行跳动。
 */

import type { ResourceMonitorProcess } from "./resource-monitor-types"

export type ResourceMonitorSortKey =
  | "name"
  | "pid"
  | "directory"
  | "cpu"
  | "memory"
  | "uptime"

export type ResourceMonitorSortDirection = "asc" | "desc"

export interface ResourceMonitorSortState {
  key: ResourceMonitorSortKey
  direction: ResourceMonitorSortDirection
}

/** 默认按内存降序，与活动监视器打开时的默认视图一致。 */
export const DEFAULT_RESOURCE_MONITOR_SORT: ResourceMonitorSortState = {
  key: "memory",
  direction: "desc",
}

/** 数值列首次点击先看“最大的”，文本列首次点击按字典序。 */
const DESCENDING_FIRST: ReadonlySet<ResourceMonitorSortKey> = new Set([
  "cpu",
  "memory",
])

export function toggleSort(
  current: ResourceMonitorSortState,
  key: ResourceMonitorSortKey
): ResourceMonitorSortState {
  if (current.key === key) {
    return { key, direction: current.direction === "asc" ? "desc" : "asc" }
  }
  return { key, direction: DESCENDING_FIRST.has(key) ? "desc" : "asc" }
}

export function ariaSortFor(
  current: ResourceMonitorSortState,
  key: ResourceMonitorSortKey
): "ascending" | "descending" | "none" {
  if (current.key !== key) return "none"
  return current.direction === "asc" ? "ascending" : "descending"
}

/**
 * 归一化启动目录：去空白、去掉末尾的分隔符（根目录除外）。
 * 空串、纯空白和缺失值都视为“未知”，不伪造任何路径。
 */
export function normalizeDirectory(
  value: string | null | undefined
): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  // 盘符根目录的分隔符有语义：C: 是相对路径，不能替代 C:\。
  if (/^[a-z]:[\\/]$/i.test(trimmed)) return trimmed
  const stripped = trimmed.length > 1 ? trimmed.replace(/[\\/]+$/, "") : trimmed
  return stripped || "/"
}

/** 后端可能先于前端更新，未返回该字段时按未知处理。 */
function directoryOf(process: ResourceMonitorProcess): string | null {
  return normalizeDirectory(process.launchDirectory)
}

function safeNumber(value: number): number {
  return Number.isFinite(value) ? value : 0
}

function compareNumbers(a: number, b: number): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/**
 * 与区域设置无关的文本比较：先比小写，再比原串，保证结果在 CI 与
 * 不同语言的机器上完全一致。
 */
function compareText(a: string, b: string): number {
  const la = a.toLowerCase()
  const lb = b.toLowerCase()
  if (la !== lb) return la < lb ? -1 : 1
  if (a === b) return 0
  return a < b ? -1 : 1
}

/** 未知目录永远排在已知目录之后，不随升降序翻转。 */
function compareDirectories(a: string | null, b: string | null): number {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  return compareText(a, b)
}

function tieBreak(
  a: ResourceMonitorProcess,
  b: ResourceMonitorProcess
): number {
  if (a.pid !== b.pid) return compareNumbers(a.pid, b.pid)
  return compareNumbers(safeNumber(a.startTime), safeNumber(b.startTime))
}

function compareByKey(
  a: ResourceMonitorProcess,
  b: ResourceMonitorProcess,
  key: ResourceMonitorSortKey
): number {
  switch (key) {
    case "name":
      return compareText(a.name, b.name)
    case "pid":
      return compareNumbers(a.pid, b.pid)
    case "cpu":
      return compareNumbers(safeNumber(a.cpuPercent), safeNumber(b.cpuPercent))
    case "memory":
      return compareNumbers(
        safeNumber(a.memoryBytes),
        safeNumber(b.memoryBytes)
      )
    case "uptime":
      return compareNumbers(
        safeNumber(a.uptimeSeconds),
        safeNumber(b.uptimeSeconds)
      )
    case "directory":
      return compareDirectories(directoryOf(a), directoryOf(b))
  }
}

export function sortProcesses(
  processes: readonly ResourceMonitorProcess[],
  sort: ResourceMonitorSortState
): ResourceMonitorProcess[] {
  const sign = sort.direction === "asc" ? 1 : -1
  return [...processes].sort((a, b) => {
    if (sort.key === "directory") {
      const ad = directoryOf(a)
      const bd = directoryOf(b)
      // 未知目录的“最后”不受升降序影响，单独在这里判定。
      if (ad === null || bd === null) {
        if (ad !== bd) return ad === null ? 1 : -1
        return tieBreak(a, b)
      }
    }
    const base = compareByKey(a, b, sort.key)
    if (base !== 0) return base * sign
    return tieBreak(a, b)
  })
}

export interface ResourceMonitorDirectoryGroup {
  /** 完整启动目录；null 表示未知，界面单独成组。 */
  directory: string | null
  processes: ResourceMonitorProcess[]
  processCount: number
  totalCpuPercent: number
  totalMemoryBytes: number
}

function sumBy(
  processes: readonly ResourceMonitorProcess[],
  pick: (process: ResourceMonitorProcess) => number
): number {
  return processes.reduce(
    (total, process) => total + safeNumber(pick(process)),
    0
  )
}

function compareGroups(
  a: ResourceMonitorDirectoryGroup,
  b: ResourceMonitorDirectoryGroup,
  sort: ResourceMonitorSortState
): number {
  let base = 0
  switch (sort.key) {
    case "cpu":
    case "memory": {
      const pick = (group: ResourceMonitorDirectoryGroup) =>
        sort.key === "cpu" ? group.totalCpuPercent : group.totalMemoryBytes
      base = compareNumbers(pick(a), pick(b))
      if (base !== 0) return sort.direction === "asc" ? base : -base
      break
    }
    case "directory": {
      const known = compareDirectories(a.directory, b.directory)
      // 两侧都已知同一目录才会相等；未知目录的先后在 compareDirectories 里定死。
      if (a.directory === null || b.directory === null) return known
      if (known !== 0) return sort.direction === "asc" ? known : -known
      break
    }
    default:
      // 名称、PID、运行时间在汇总行上没有可比的值：回落到内存总量降序，
      // 与默认视图一致，且不随当前方向翻转。
      base = compareNumbers(b.totalMemoryBytes, a.totalMemoryBytes)
      if (base !== 0) return base
  }
  const byDirectory = compareDirectories(a.directory, b.directory)
  if (byDirectory !== 0) return byDirectory
  return tieBreak(a.processes[0], b.processes[0])
}

/**
 * 按启动目录分组，组内与组间都遵循同一个排序状态：
 * CPU / 内存看组汇总，目录列看目录名，其余列回落到内存总量降序。
 */
export function groupProcessesByDirectory(
  processes: readonly ResourceMonitorProcess[],
  sort: ResourceMonitorSortState
): ResourceMonitorDirectoryGroup[] {
  const buckets = new Map<string | null, ResourceMonitorProcess[]>()
  for (const process of processes) {
    const directory = directoryOf(process)
    const bucket = buckets.get(directory)
    if (bucket) bucket.push(process)
    else buckets.set(directory, [process])
  }
  const groups: ResourceMonitorDirectoryGroup[] = []
  for (const [directory, list] of buckets) {
    groups.push({
      directory,
      processes: sortProcesses(list, sort),
      processCount: list.length,
      totalCpuPercent: sumBy(list, (process) => process.cpuPercent),
      totalMemoryBytes: sumBy(list, (process) => process.memoryBytes),
    })
  }
  return groups.sort((a, b) => compareGroups(a, b, sort))
}
