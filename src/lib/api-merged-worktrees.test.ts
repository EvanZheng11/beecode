import { afterEach, describe, expect, it, vi } from "vitest"
import { gitListMergedWorktrees } from "./api"
import { getTransport } from "./transport"
import { TauriTransport } from "./transport/tauri-transport"
import { WebTransport } from "./transport/web-transport"
import { invoke } from "@tauri-apps/api/core"

vi.mock("./transport", () => ({ getTransport: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }))

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe("已合并 worktree 查询传输", () => {
  it("桌面调用已注册的命令并返回路径", async () => {
    vi.mocked(getTransport).mockReturnValue(new TauriTransport())
    vi.mocked(invoke).mockResolvedValue(["/merged"])
    await expect(gitListMergedWorktrees("/repo")).resolves.toEqual(["/merged"])
    expect(invoke).toHaveBeenCalledWith("git_list_merged_worktrees", {
      path: "/repo",
    })
  })

  it("Web 向对应端点发送相同参数并返回路径", async () => {
    vi.mocked(getTransport).mockReturnValue(
      new WebTransport("http://localhost")
    )
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(["/merged"]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    )
    vi.stubGlobal("fetch", fetcher)
    await expect(gitListMergedWorktrees("/repo")).resolves.toEqual(["/merged"])
    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost/api/git_list_merged_worktrees",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ path: "/repo" }),
      })
    )
  })
})
