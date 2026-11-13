// 只有监控采用 REST 路由，其他既有命令仍走原有 POST 协议。
const MONITOR_ROUTES: Record<string, { path: string; method: string }> = {
  get_resource_monitor_settings: {
    path: "resource-monitor/settings",
    method: "GET",
  },
  set_resource_monitor_enabled: {
    path: "resource-monitor/settings",
    method: "PUT",
  },
  get_resource_monitor_snapshot: {
    path: "resource-monitor/snapshot",
    method: "GET",
  },
  resource_monitor_process_action: {
    path: "resource-monitor/action",
    method: "POST",
  },
  // 一键优化与监控开关无关，无参数，POST 空对象。
  resource_monitor_optimize: {
    path: "resource-monitor/optimize",
    method: "POST",
  },
}

export function commandRoute(command: string) {
  return MONITOR_ROUTES[command] ?? { path: command, method: "POST" }
}
