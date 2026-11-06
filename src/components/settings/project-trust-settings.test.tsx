import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, expect, it, vi } from "vitest"
import messages from "@/i18n/messages/en.json"
import type { ProjectTrustDirectory } from "@/lib/project-trust"
import { ProjectTrustSettings } from "./project-trust-settings"

const mock = vi.hoisted(() => ({
  agents: vi.fn(),
  inspect: vi.fn(),
  grant: vi.fn(),
  directories: vi.fn(),
}))
vi.mock("@/lib/project-trust", () => ({
  projectTrustAgents: mock.agents,
  inspectProjectTrust: mock.inspect,
  grantProjectTrust: mock.grant,
  projectTrustDirectories: mock.directories,
}))

const openButton = () => screen.getByRole("button", { name: "批量信任项目" })
const checkbox = (path: string) => screen.getByRole("checkbox", { name: path })
const expand = (path: string) =>
  screen.getByRole("button", { name: `展开 ${path}` })

const tree: Record<string, ProjectTrustDirectory[]> = {
  root: [
    { name: "/", path: "/", hasChildren: true },
    { name: "/Volumes", path: "/Volumes", hasChildren: true },
  ],
  "/": [
    { name: "parent", path: "/parent", hasChildren: true },
    { name: ".hidden", path: "/.hidden", hasChildren: true },
  ],
  "/parent": [{ name: "child", path: "/parent/child", hasChildren: false }],
  "/.hidden": [{ name: "nested", path: "/.hidden/nested", hasChildren: false }],
}

const targetsFor = (paths: string[]) =>
  paths.map((workspace) => ({
    agentType: "pi",
    workspace,
    warning: "risk",
    resources: [],
  }))

beforeEach(() => {
  mock.agents
    .mockReset()
    .mockResolvedValue([
      { agentType: "pi", displayName: "Pi", description: "" },
    ])
  mock.directories
    .mockReset()
    .mockImplementation(
      async (path?: string | null) => tree[path ?? "root"] ?? []
    )
  mock.inspect
    .mockReset()
    .mockImplementation(async (_agent: string, paths: string[]) =>
      targetsFor(paths)
    )
  mock.grant.mockReset().mockResolvedValue([])
})

// 根列表里 Unix 根需要先展开才能看到 /parent。
const openTree = async () => {
  fireEvent.click(openButton())
  fireEvent.click(await screen.findByRole("button", { name: "展开 /" }))
  await screen.findByRole("checkbox", { name: "/parent" })
}

// 展开到 /parent 并明确勾选它。
const openTreeAndSelectParent = async () => {
  await openTree()
  fireEvent.click(checkbox("/parent"))
}

const renderSettings = () =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ProjectTrustSettings />
    </NextIntlClientProvider>
  )

it("逐层展开勾选，一次确认批量提交明确选择的目录", async () => {
  mock.grant.mockReset().mockResolvedValue([
    { workspace: "/parent", success: true },
    { workspace: "/parent/child", success: false, error: "denied" },
  ])
  renderSettings()
  await openTreeAndSelectParent()
  fireEvent.click(expand("/parent"))
  fireEvent.click(
    await screen.findByRole("checkbox", { name: "/parent/child" })
  )

  fireEvent.click(screen.getByRole("button", { name: "查看风险" }))
  // 确认页显示真实完整路径。
  expect(await screen.findByText("pi: /parent/child")).toBeInTheDocument()
  expect(screen.getByText("pi: /parent")).toBeInTheDocument()

  fireEvent.click(screen.getByRole("button", { name: "全部允许" }))
  await waitFor(() => expect(mock.grant).toHaveBeenCalledOnce())
  expect(mock.grant).toHaveBeenCalledWith("pi", ["/parent", "/parent/child"])
  expect(
    await screen.findByText("/parent/child: 授权失败: denied")
  ).toBeInTheDocument()
  expect(screen.getByText("/parent: 已授权")).toBeInTheDocument()
})

it("取消不写入，检查失败显示错误", async () => {
  mock.inspect.mockRejectedValue(new Error("inspection failed"))
  renderSettings()
  await openTreeAndSelectParent()
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
  await openTreeAndSelectParent()
  fireEvent.click(screen.getByRole("button", { name: "查看风险" }))
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "风险检查未覆盖全部已选目录"
  )
  expect(
    screen.queryByRole("button", { name: "全部允许" })
  ).not.toBeInTheDocument()
  expect(mock.grant).not.toHaveBeenCalled()
})

it("检查期间禁用树，审查结果与快照一致，不跟随检查后的勾选变化", async () => {
  let finishInspect: (value: unknown) => void = () => {}
  mock.inspect.mockReturnValue(
    new Promise((resolve) => {
      finishInspect = resolve
    })
  )
  renderSettings()
  await openTreeAndSelectParent()
  fireEvent.click(screen.getByRole("button", { name: "查看风险" }))

  // 检查中：树不可再改，避免授权落在未审查的目录上。
  await waitFor(() =>
    expect(screen.getByRole("checkbox", { name: "/parent" })).toBeDisabled()
  )

  await waitFor(() => expect(mock.inspect).toHaveBeenCalled())
  finishInspect(targetsFor(["/parent"]))
  expect(await screen.findByText("pi: /parent")).toBeInTheDocument()
  // 提交的是检查时的工作区快照。
  fireEvent.click(screen.getByRole("button", { name: "全部允许" }))
  await waitFor(() =>
    expect(mock.grant).toHaveBeenCalledWith("pi", ["/parent"])
  )
})

it("授权以已审快照为准，缺失的批量结果不显示成功", async () => {
  // 后端只回过一条结果：缺失项必须显示失败，不能默认成功。
  mock.grant
    .mockReset()
    .mockResolvedValue([{ workspace: "/parent", success: true }])
  renderSettings()
  await openTreeAndSelectParent()
  fireEvent.click(checkbox("/.hidden"))
  fireEvent.click(screen.getByRole("button", { name: "查看风险" }))
  await screen.findByText("pi: /.hidden")
  fireEvent.click(screen.getByRole("button", { name: "全部允许" }))

  expect(await screen.findByText("/parent: 已授权")).toBeInTheDocument()
  expect(
    screen.getByText("/.hidden: 授权失败: 后端未返回该目录的授权结果")
  ).toBeInTheDocument()
})

it("同一 tick 连点不会重复发起授权", async () => {
  renderSettings()
  await openTreeAndSelectParent()
  fireEvent.click(screen.getByRole("button", { name: "查看风险" }))
  await screen.findByText("pi: /parent")

  const allowAll = screen.getByRole("button", { name: "全部允许" })
  fireEvent.click(allowAll)
  fireEvent.click(allowAll)
  await waitFor(() => expect(mock.grant).toHaveBeenCalledOnce())
})
