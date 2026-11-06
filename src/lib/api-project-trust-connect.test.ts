import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call: mocks.call }),
  getShellTransport: () => ({ call: mocks.call }),
  isDesktop: () => false,
  isRemoteDesktopMode: () => false,
  getActiveRemoteConnectionId: () => null,
  notifyRemoteDesktopUnauthorized: vi.fn(),
}))

import { acpConnect } from "@/lib/api"

describe("启动前目录信任等待", () => {
  it("连接保留人工确认时间并透传原任务参数", async () => {
    mocks.call.mockResolvedValue("connection-1")
    await expect(
      acpConnect("pi", "/worktrees/child", "original-session", "safe", {
        model: "selected-model",
      })
    ).resolves.toBe("connection-1")
    expect(mocks.call).toHaveBeenCalledWith(
      "acp_connect",
      {
        agentType: "pi",
        workingDir: "/worktrees/child",
        sessionId: "original-session",
        preferredModeId: "safe",
        preferredConfigValues: { model: "selected-model" },
      },
      { timeoutMs: 720_000 }
    )
  })
})
