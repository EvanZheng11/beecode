import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import zhCNMessages from "@/i18n/messages/zh-CN.json"
import type { GenerativeUiSkillInfo } from "@/lib/api"
import type { AcpAgentInfo, AgentSkillItem } from "@/lib/types"

const generativeUiSkillInfo = vi.fn<() => Promise<GenerativeUiSkillInfo>>()
const customImportDirectory = vi.fn()
const customImportRemote = vi.fn()

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
  customList: async () => [],
  customListAllInstallStatuses: async () => [],
  customApplyLinks: async () => [],
  customReadSkill: async () => "",
  customCreateSkill: vi.fn(),
  customDeleteSkills: vi.fn(),
  customDuplicateSkill: vi.fn(),
  customImportFromAgent: vi.fn(),
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
  await screen.findByText("my-notes", { selector: "span" })
}

beforeEach(() => {
  generativeUiSkillInfo.mockReset()
  customImportDirectory.mockReset()
  customImportRemote.mockReset()
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
  it("逐项展示成功、重复跳过和失败", async () => {
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
    await screen.findByText("技能甲 · 已导入")
    expect(screen.getByText("技能乙 · 已存在，跳过")).toBeInTheDocument()
    expect(screen.getByText("frontmatter 无效")).toBeInTheDocument()
    expect(customImportDirectory).toHaveBeenCalledWith("/skills")
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
    resolve([])
    expect(await screen.findByText(/未发现有效技能包/)).toBeInTheDocument()
  })
})
