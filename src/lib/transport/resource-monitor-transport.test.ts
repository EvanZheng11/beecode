import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { WebTransport } from "./web-transport"

beforeEach(() => {
  vi.stubGlobal("localStorage", window.localStorage)
  localStorage.setItem("codeg_token", "monitor-test")
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200 }))
  )
})

afterEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe("监控 Web transport", () => {
  it.each([
    ["get_resource_monitor_settings", "settings", "GET", undefined],
    ["set_resource_monitor_enabled", "settings", "PUT", { enabled: true }],
    ["get_resource_monitor_snapshot", "snapshot", "GET", undefined],
    [
      "resource_monitor_process_action",
      "action",
      "POST",
      { pid: 1, startTime: 2, action: "stop" },
    ],
  ])("%s 保留授权并使用对应 REST 路由", async (command, path, method, args) => {
    const transport = new WebTransport("https://example.test/beecode")
    await transport.call(command, args)
    expect(fetch).toHaveBeenCalledWith(
      `https://example.test/beecode/api/resource-monitor/${path}`,
      expect.objectContaining({
        method,
        body: method === "GET" ? undefined : JSON.stringify(args),
        headers: expect.objectContaining({
          Authorization: "Bearer monitor-test",
        }),
      })
    )
  })

  it("成功操作的 JSON null 响应不会被误报失败", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("null", { status: 200 })
    )
    const response = await new WebTransport("https://example.test").call(
      "resource_monitor_process_action",
      { pid: 12, startTime: 123, action: "stop" }
    )
    expect(response).toBeNull()
  })

  it("其他命令仍走既有 POST 协议", async () => {
    await new WebTransport("https://example.test").call("existing_command", {
      id: 5,
    })
    expect(fetch).toHaveBeenCalledWith(
      "https://example.test/api/existing_command",
      expect.objectContaining({ method: "POST", body: '{"id":5}' })
    )
  })
})
