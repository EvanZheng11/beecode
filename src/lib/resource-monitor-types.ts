export type ResourceMonitorAction = "stop" | "kill" | "restart"

export interface ResourceMonitorSettings {
  enabled: boolean
}

export interface ResourceMonitorProcess {
  pid: number
  parentPid: number | null
  startTime: number
  name: string
  category:
    | "application"
    | "frontend"
    | "backend"
    | "plugin"
    | "computer-helper"
    | "session"
    | "terminal"
    | "service"
    | "process"
  ownerLabel: string | null
  /**
   * 启动该进程时的工作目录（完整绝对路径）；后端无法确定时为 null，
   * 界面按“未知目录”单独分组，不推测也不补默认值。
   */
  launchDirectory: string | null
  cpuPercent: number
  memoryBytes: number
  status: string
  uptimeSeconds: number
  canStop: boolean
  canKill: boolean
  canRestart: boolean
  actionUnavailableReason: string | null
}

export interface ResourceMonitorSnapshot {
  enabled: boolean
  sampledAt: number
  sampleIntervalMs: number
  collectionDurationMs: number
  totalCpuPercent: number
  totalMemoryBytes: number
  activeProcessCount: number
  processes: ResourceMonitorProcess[]
  warnings: string[]
}

export interface ResourceMonitorHistoryPoint {
  sampledAt: number
  cpuPercent: number
  memoryBytes: number
}

/**
 * 一键优化的结果。只统计 BeeCode 自己可重建的缓存：
 * 0 回收是正常结果，系统 RSS 不保证因此下降。
 */
export interface ResourceMonitorOptimizeResult {
  clearedCacheEntries: number
  reclaimedMemoryBytes: number
  /** 平台不支持清理磁盘时后端如实返回 0，并在 warnings 里说明。 */
  reclaimedDiskBytes: number
  warnings: string[]
}
