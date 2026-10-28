import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  desktop: true,
  remoteDesktop: false,
}))

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call: mocks.call }),
  getShellTransport: () => ({ call: mocks.call }),
  isDesktop: () => mocks.desktop,
  isRemoteDesktopMode: () => mocks.remoteDesktop,
  getActiveRemoteConnectionId: () => null,
  notifyRemoteDesktopUnauthorized: vi.fn(),
}))

import { acpExtendQuestion } from "@/lib/api"

describe("acpExtendQuestion", () => {
  beforeEach(() => {
    mocks.call.mockReset()
    mocks.desktop = true
    mocks.remoteDesktop = false
  })

  it("本地桌面走 Tauri 命令并透传 camelCase 参数", async () => {
    mocks.call.mockResolvedValue("2026-01-01T00:15:00Z")

    await expect(acpExtendQuestion("q-1")).resolves.toBe("2026-01-01T00:15:00Z")
    expect(mocks.call).toHaveBeenCalledWith("acp_extend_question", {
      questionId: "q-1",
    })
  })

  it("Web 模式走固定 HTTP 端点并使用后端约定的 body", async () => {
    mocks.desktop = false
    mocks.call.mockResolvedValue("2026-01-01T00:15:00Z")

    await acpExtendQuestion("q-2")
    expect(mocks.call).toHaveBeenCalledWith("acp/question/extend", {
      question_id: "q-2",
    })
  })

  it("远程桌面窗口也走远端 HTTP 端点，不调用本地命令", async () => {
    mocks.remoteDesktop = true
    mocks.call.mockResolvedValue("2026-01-01T00:15:00Z")

    await acpExtendQuestion("q-3")
    expect(mocks.call).toHaveBeenCalledWith("acp/question/extend", {
      question_id: "q-3",
    })
  })
})
