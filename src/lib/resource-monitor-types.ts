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
