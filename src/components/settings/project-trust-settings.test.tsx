import { fireEvent, render, screen, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, expect, it, vi } from "vitest"
import messages from "@/i18n/messages/en.json"
import { ProjectTrustSettings } from "./project-trust-settings"

const mock = vi.hoisted(() => ({
  agents: vi.fn(),
  inspect: vi.fn(),
  grant: vi.fn(),
  list: vi.fn(),
}))
vi.mock("@/lib/project-trust", () => ({
  projectTrustAgents: mock.agents,
  inspectProjectTrust: mock.inspect,
  grantProjectTrust: mock.grant,
}))
vi.mock("@/lib/api", () => ({
  getHomeDirectory: async () => "/",
  listDirectoryEntries: mock.list,
  createDirectory: vi.fn(),
}))
beforeEach(() => {
  mock.agents
    .mockReset()
    .mockResolvedValue([
      { agentType: "pi", displayName: "Pi", description: "" },
    ])
  mock.list
    .mockReset()
    .mockImplementation(async (path: string) =>
      path === "/"
        ? [{ name: "parent", path: "/parent", hasChildren: true }]
        : [{ name: "child", path: "/parent/child", hasChildren: false }]
    )
  mock.inspect
    .mockReset()
    .mockImplementation(async (_agent: string, paths: string[]) =>
      paths.map((workspace) => ({
        agentType: "pi",
        workspace,
        warning: "risk",
        resources: [],
      }))
    )
  mock.grant.mockReset().mockResolvedValue([
    { workspace: "/parent", success: true },
    { workspace: "/parent/child", success: false, error: "denied" },
  ])
})
const renderSettings = () =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ProjectTrustSettings />
    </NextIntlClientProvider>
  )

it("逐层选择并预览，一次提交明确选择的目录", async () => {
  renderSettings()
  fireEvent.click(screen.getByRole("button", { name: "批量信任项目" }))
  const parent = await screen.findByRole("button", { name: "parent" })
  fireEvent.click(within(parent).getByRole("button"))
  fireEvent.click(parent)
  fireEvent.click(await screen.findByRole("button", { name: "child" }))
  fireEvent.click(screen.getByRole("button", { name: "查看风险" }))
  expect(await screen.findByText("pi: /parent/child")).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "全部允许" }))
  expect(mock.grant).toHaveBeenCalledOnce()
  expect(mock.grant).toHaveBeenCalledWith("pi", ["/parent", "/parent/child"])
  expect(
    await screen.findByText("/parent/child: 授权失败: denied")
  ).toBeInTheDocument()
})

it("取消不写入，检查失败显示错误", async () => {
  mock.inspect.mockRejectedValue(new Error("inspection failed"))
  renderSettings()
  fireEvent.click(screen.getByRole("button", { name: "批量信任项目" }))
  fireEvent.click(await screen.findByRole("button", { name: "parent" }))
  fireEvent.click(screen.getByRole("button", { name: "查看风险" }))
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "inspection failed"
  )
  fireEvent.click(screen.getByRole("button", { name: "取消" }))
  expect(mock.grant).not.toHaveBeenCalled()
})

it("风险检查结果不完整时不允许批量授权", async () => {
  mock.inspect.mockResolvedValue([])
  renderSettings()
  fireEvent.click(screen.getByRole("button", { name: "批量信任项目" }))
  fireEvent.click(await screen.findByRole("button", { name: "parent" }))
  fireEvent.click(screen.getByRole("button", { name: "查看风险" }))
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "未覆盖全部已选目录"
  )
  expect(mock.grant).not.toHaveBeenCalled()
})
