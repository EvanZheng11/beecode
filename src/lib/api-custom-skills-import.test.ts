import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call: mocks.call }),
}))

import {
  customImportDirectory,
  customImportFromAgent,
  customImportRemote,
} from "./api"

describe("技能导入覆盖授权", () => {
  beforeEach(() => mocks.call.mockReset().mockResolvedValue([]))

  it("未确认时不授权任何覆盖", async () => {
    await customImportDirectory("/skills")
    expect(mocks.call).toHaveBeenLastCalledWith(
      "custom_import_directory",
      { sourcePath: "/skills", overwriteIds: [] },
      { timeoutMs: 300_000 }
    )
    await customImportRemote("https://example.test/skills.zip")
    expect(mocks.call).toHaveBeenLastCalledWith(
      "custom_import_remote",
      { url: "https://example.test/skills.zip", overwriteIds: [] },
      { timeoutMs: 90_000 }
    )
    await customImportFromAgent({ agentType: "claude_code", ids: ["notes"] })
    expect(mocks.call).toHaveBeenLastCalledWith("custom_import_from_agent", {
      agentType: "claude_code",
      ids: ["notes"],
      overwriteIds: [],
    })
  })

  it("三个入口均只透传明确确认的技能ID", async () => {
    await customImportDirectory("/skills", ["notes"])
    expect(mocks.call).toHaveBeenLastCalledWith(
      "custom_import_directory",
      { sourcePath: "/skills", overwriteIds: ["notes"] },
      { timeoutMs: 300_000 }
    )
    await customImportRemote("https://example.test/skills.zip", ["notes"])
    expect(mocks.call).toHaveBeenLastCalledWith(
      "custom_import_remote",
      { url: "https://example.test/skills.zip", overwriteIds: ["notes"] },
      { timeoutMs: 90_000 }
    )
    await customImportFromAgent({
      agentType: "claude_code",
      ids: ["notes"],
      overwriteIds: ["notes"],
    })
    expect(mocks.call).toHaveBeenLastCalledWith("custom_import_from_agent", {
      agentType: "claude_code",
      ids: ["notes"],
      overwriteIds: ["notes"],
    })
  })
})
