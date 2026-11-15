import { act, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import zhCNMessages from "@/i18n/messages/zh-CN.json"
import type { GenerativeUiSkillInfo } from "@/lib/api"
import type { AcpAgentInfo, AgentSkillItem } from "@/lib/types"

const generativeUiSkillInfo = vi.fn<() => Promise<GenerativeUiSkillInfo>>()
const customImportDirectory = vi.fn()
const customImportRemote = vi.fn()
const customImportFromAgent = vi.fn()
const customList = vi.fn()
const customApplyLinks = vi.fn()

function skill(id: string): AgentSkillItem {
  return {
    id,
    name: id,
    scope: "global",
    layout: "skill_directory",
    path: `/home/me/.claude/skills/${id}`,
    description: null,
    read_only: false,
  } as AgentSkillItem
}

vi.mock("@/lib/api", () => ({
  customList: () => customList(),
  customListAllInstallStatuses: async () => [],
  customApplyLinks: (...args: unknown[]) => customApplyLinks(...args),
  customReadSkill: async () => "",
  customCreateSkill: vi.fn(),
  customDeleteSkills: vi.fn(),
  customDuplicateSkill: vi.fn(),
  customImportFromAgent: (...args: unknown[]) => customImportFromAgent(...args),
  customImportSkill: vi.fn(),
  customImportDirectory: (...args: unknown[]) => customImportDirectory(...args),
  customImportRemote: (...args: unknown[]) => customImportRemote(...args),
  customSaveSkill: vi.fn(),
  acpListAgents: async () =>
    [
      {
        agent_type: "claude_code",
        name: "Claude Code",
        skills_capable: true,
        env: {},
      },
    ] as unknown as AcpAgentInfo[],
  // What Claude's skill folder holds: Codeg's own `ui-render` and an expert
  // (both linked in from the central store), and one skill of the user's.
  acpListAgentSkills: async () => ({
    supported: true,
    message: null,
    locations: [],
    skills: [skill("ui-render"), skill("brainstorming"), skill("my-notes")],
  }),
  expertsList: async () => [{ metadata: { id: "brainstorming" } }],
  scienceList: async () => [],
  officecliListSkills: async () => [],
  generativeUiSkillInfo: () => generativeUiSkillInfo(),
}))
vi.mock("@/lib/platform", () => ({ isLocalDesktop: () => false }))
vi.mock("@/components/shared/directory-browser-dialog", () => ({
  DirectoryBrowserDialog: ({
    open,
    onSelect,
  }: {
    open: boolean
    onSelect: (path: string) => void
  }) =>
    open ? (
      <button onClick={() => onSelect("/skills")}>选择测试目录</button>
    ) : null,
}))
vi.mock("@/hooks/use-agent-skills", () => ({
  invalidateAgentSkillsCache: vi.fn(),
}))
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}))

const t = enMessages.CustomSkillsSettings

/** A fresh copy of the module each time: it caches the reserved ids for the
 *  rest of the session. next-intl comes fresh with it, so the provider and the
 *  component share one context. */
async function openImportFromAgent() {
  vi.resetModules()
  const [{ CustomSkillsBody }, { NextIntlClientProvider }] = await Promise.all([
    import("./custom-skills-settings"),
    import("next-intl"),
  ])
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <CustomSkillsBody />
    </NextIntlClientProvider>
  )
  const button = await screen.findByRole("button", {
    name: t.actions.importFromAgent,
  })
  await vi.waitFor(() => expect(button).toBeEnabled())
  await userEvent.click(button)
  await within(screen.getByRole("dialog")).findByText("my-notes", {
    selector: "span",
  })
}

beforeEach(() => {
  generativeUiSkillInfo.mockReset()
  customImportDirectory.mockReset()
  customImportRemote.mockReset()
  customImportFromAgent.mockReset()
  customList.mockReset().mockResolvedValue([])
  customApplyLinks.mockReset().mockResolvedValue([])
})

describe("importing skills from an agent", () => {
  it("leaves out Codeg's own ui-render, like the other packs' skills", async () => {
    generativeUiSkillInfo.mockResolvedValue({
      id: "ui-render",
      conflict: false,
    })
    await openImportFromAgent()

    expect(screen.queryByText("ui-render", { selector: "span" })).toBeNull()
    expect(screen.queryByText("brainstorming", { selector: "span" })).toBeNull()
  })

  it("still leaves out the other packs' skills when ui-render cannot be asked about", async () => {
    generativeUiSkillInfo.mockRejectedValue(new Error("offline"))
    await openImportFromAgent()

    expect(screen.queryByText("brainstorming", { selector: "span" })).toBeNull()
  })
})

async function renderImportSettings() {
  vi.resetModules()
  generativeUiSkillInfo.mockResolvedValue({ id: "ui-render", conflict: false })
  const [{ CustomSkillsBody }, { NextIntlClientProvider }] = await Promise.all([
    import("./custom-skills-settings"),
    import("next-intl"),
  ])
  render(
    <NextIntlClientProvider locale="zh-CN" messages={zhCNMessages}>
      <CustomSkillsBody />
    </NextIntlClientProvider>
  )
  await screen.findByRole("button", { name: "批量导入目录" })
}

describe("目录和远程批量导入", () => {
  it("重复技能先询问，选择不覆盖后展示原有结果", async () => {
    customImportDirectory.mockResolvedValue([
      { id: "one", name: "技能甲", ok: true, skipped: false, error: null },
      { id: "two", name: "技能乙", ok: false, skipped: true, error: null },
      {
        id: "bad",
        name: "技能丙",
        ok: false,
        skipped: false,
        error: "frontmatter 无效",
      },
    ])
    await renderImportSettings()
    await userEvent.click(screen.getByRole("button", { name: "批量导入目录" }))
    await userEvent.click(screen.getByRole("button", { name: "选择测试目录" }))
    const prompt = await screen.findByRole("alertdialog")
    expect(prompt).toHaveTextContent("技能乙")
    expect(prompt).toHaveTextContent("智能体的启用配置保持不变")
    expect(customImportDirectory).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByRole("button", { name: "不覆盖" }))
    await screen.findByText("技能甲 · 已导入")
    expect(screen.getByText("技能乙 · 已存在，跳过")).toBeInTheDocument()
    expect(screen.getByText("frontmatter 无效")).toBeInTheDocument()
    expect(customImportDirectory).toHaveBeenCalledWith("/skills")
  })

  it("确认后仅授权覆盖重复技能，保留首轮成功和失败结果", async () => {
    customImportDirectory.mockResolvedValueOnce([
      { id: "one", name: "技能甲", ok: true, skipped: false, error: null },
      { id: "two", name: "技能乙", ok: false, skipped: true, error: null },
      { id: "bad", name: "技能丙", ok: false, skipped: false, error: "无效包" },
    ])
    customImportDirectory.mockResolvedValueOnce([
      { id: "one", name: "技能甲", ok: false, skipped: true, error: null },
      { id: "two", name: "技能乙", ok: true, skipped: false, error: null },
    ])
    await renderImportSettings()
    await userEvent.click(screen.getByRole("button", { name: "批量导入目录" }))
    await userEvent.click(screen.getByRole("button", { name: "选择测试目录" }))
    await userEvent.click(await screen.findByRole("button", { name: "覆盖" }))
    expect(customImportDirectory).toHaveBeenLastCalledWith("/skills", ["two"])
    expect(await screen.findByText("技能乙 · 已导入")).toBeInTheDocument()
    expect(screen.getByText("技能甲 · 已导入")).toBeInTheDocument()
    expect(screen.getByText("无效包")).toBeInTheDocument()
  })

  it("远程重复技能需要确认且携带覆盖ID", async () => {
    customImportRemote.mockResolvedValueOnce([
      { id: "two", name: "技能乙", ok: false, skipped: true, error: null },
    ])
    customImportRemote.mockResolvedValueOnce([
      { id: "two", name: "技能乙", ok: true, skipped: false, error: null },
    ])
    await renderImportSettings()
    await userEvent.click(
      screen.getByRole("button", { name: "从远程地址导入" })
    )
    await userEvent.type(
      screen.getByLabelText("远程技能地址"),
      "https://example.test/skills.zip"
    )
    await userEvent.click(screen.getByRole("button", { name: "导入" }))
    await userEvent.click(await screen.findByRole("button", { name: "覆盖" }))
    expect(customImportRemote).toHaveBeenLastCalledWith(
      "https://example.test/skills.zip",
      ["two"]
    )
    expect(await screen.findByText("技能乙 · 已导入")).toBeInTheDocument()
  })

  it("智能体中已在库的技能仍可选择，确认后覆盖而不修改启用矩阵", async () => {
    generativeUiSkillInfo.mockResolvedValue({
      id: "ui-render",
      conflict: false,
    })
    customList.mockResolvedValue([
      { id: "my-notes", name: "my-notes", description: null },
    ])
    customImportFromAgent.mockResolvedValueOnce([
      {
        id: "my-notes",
        name: "my-notes",
        ok: false,
        skipped: true,
        error: null,
      },
    ])
    customImportFromAgent.mockResolvedValueOnce([
      {
        id: "my-notes",
        name: "my-notes",
        ok: true,
        skipped: false,
        error: null,
      },
    ])
    await openImportFromAgent()
    const row = within(screen.getByRole("dialog"))
      .getByText("my-notes", { selector: "span" })
      .closest("label")!
    const checkbox = row.querySelector("button")!
    expect(checkbox).toBeEnabled()
    if (checkbox.getAttribute("aria-checked") !== "true")
      await userEvent.click(checkbox)
    await userEvent.click(
      screen.getByRole("button", {
        name: t.importFromAgent.confirm.replace("{count}", "1"),
      })
    )
    await userEvent.click(
      await screen.findByRole("button", { name: "Overwrite" })
    )
    expect(customImportFromAgent).toHaveBeenLastCalledWith({
      agentType: "claude_code",
      ids: ["my-notes"],
      overwriteIds: ["my-notes"],
    })
    expect(await screen.findByText("my-notes · Imported")).toBeInTheDocument()
    expect(customApplyLinks).not.toHaveBeenCalled()
  })

  it("覆盖期间禁止重复提交，失败后仍可重试", async () => {
    const duplicate = {
      id: "two",
      name: "技能乙",
      ok: false,
      skipped: true,
      error: null,
    }
    customImportDirectory.mockResolvedValueOnce([duplicate])
    let reject!: (error: Error) => void
    customImportDirectory.mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail
        })
    )
    customImportDirectory.mockResolvedValueOnce([
      { ...duplicate, ok: true, skipped: false },
    ])
    await renderImportSettings()
    await userEvent.click(screen.getByRole("button", { name: "批量导入目录" }))
    await userEvent.click(screen.getByRole("button", { name: "选择测试目录" }))
    const confirm = await screen.findByRole("button", { name: "覆盖" })
    await userEvent.click(confirm)
    expect(confirm).toBeDisabled()
    expect(screen.getByRole("button", { name: "不覆盖" })).toBeDisabled()
    expect(customImportDirectory).toHaveBeenCalledTimes(2)
    await act(async () => reject(new Error("offline")))
    await vi.waitFor(() => expect(confirm).toBeEnabled())
    await userEvent.click(confirm)
    expect(await screen.findByText("技能乙 · 已导入")).toBeInTheDocument()
    expect(customImportDirectory).toHaveBeenCalledTimes(3)
    expect(customApplyLinks).not.toHaveBeenCalled()
  })

  it("无有效包时展示明确提示", async () => {
    customImportDirectory.mockResolvedValue([])
    await renderImportSettings()
    await userEvent.click(screen.getByRole("button", { name: "批量导入目录" }))
    await userEvent.click(screen.getByRole("button", { name: "选择测试目录" }))
    expect(await screen.findByText(/未发现有效技能包/)).toBeInTheDocument()
  })

  it("远程地址经 transport 导入，等待时禁用重复提交", async () => {
    let resolve!: (results: unknown[]) => void
    customImportRemote.mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )
    await renderImportSettings()
    await userEvent.click(
      screen.getByRole("button", { name: "从远程地址导入" })
    )
    const confirm = screen.getByRole("button", { name: "导入" })
    expect(confirm).toBeDisabled()
    await userEvent.type(
      screen.getByLabelText("远程技能地址"),
      "https://example.test/skills.zip"
    )
    await userEvent.click(confirm)
    expect(customImportRemote).toHaveBeenCalledWith(
      "https://example.test/skills.zip"
    )
    expect(confirm).toBeDisabled()
    await act(async () => resolve([]))
    expect(await screen.findByText(/未发现有效技能包/)).toBeInTheDocument()
  })
})
