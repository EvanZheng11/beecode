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
}

export function commandRoute(command: string) {
  return MONITOR_ROUTES[command] ?? { path: command, method: "POST" }
}
