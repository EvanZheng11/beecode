import { createRef } from "react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { RemoteNavigator, type RemoteNavigatorHandle } from "./remote-navigator"

const api = vi.hoisted(() => ({
  connections: vi.fn(),
  probe: vi.fn(),
  folders: vi.fn(),
  files: vi.fn(),
  sessions: vi.fn(),
  assistants: vi.fn(),
  agents: vi.fn(),
}))
vi.mock("@/lib/remote-workspace", () => ({
  listRemoteWorkspaceConnections: api.connections,
}))
vi.mock("@/lib/remote-mention", async (original) => ({
  ...(await original<typeof import("@/lib/remote-mention")>()),
  probeRemoteMention: api.probe,
  listRemoteMentionFolders: api.folders,
  listRemoteMentionFiles: api.files,
  listRemoteMentionSessions: api.sessions,
  listRemoteMentionAssistants: api.assistants,
  listRemoteMentionAgents: api.agents,
}))
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
vi.mock("../badges/reference-badge", () => ({ ReferenceIcon: () => null }))
vi.mock("sonner", () => ({ toast: { warning: vi.fn() } }))

function mount() {
  const ref = createRef<RemoteNavigatorHandle>()
  const onSelect = vi.fn()
  render(
    <RemoteNavigator
      ref={ref}
      query=""
      onSelect={onSelect}
      onClose={vi.fn()}
      range={{ from: 1, to: 2 }}
      listboxId="remote-list"
      listboxLabel="远程资源"
    />
  )
  const key = (key: string) =>
    act(() => {
      ref.current?.onKeyDown(new KeyboardEvent("keydown", { key }))
    })
  return { key, onSelect }
}

beforeEach(() => {
  vi.clearAllMocks()
  api.connections.mockResolvedValue([
    { id: 1, name: "机器A", base_url: "https://remote.test" },
  ])
  api.probe.mockResolvedValue({
    runtime: "server",
    version: "x",
    apiVersion: 1,
    capabilities: ["run"],
  })
  api.folders.mockResolvedValue([
    { id: 2, name: "项目A", path: "/remote/a", alias: null },
  ])
  api.files.mockResolvedValue({
    entries: [
      { name: "a.ts", path: "src/a.ts", kind: "file" },
      { name: "src", path: "src", kind: "dir" },
    ],
    truncated: false,
  })
})

describe("远程导航", () => {
  it("键盘逐层进入并插入文件，不将目录当文件", async () => {
    const { key, onSelect } = mount()
    await screen.findByText("机器A")
    await waitFor(() =>
      expect(screen.queryByText("probing")).not.toBeInTheDocument()
    )
    key("Enter")
    await screen.findByRole("option", { name: /项目A/ })
    key("ArrowRight")
    await screen.findByRole("option", { name: "kindFile" })
    key("Enter")
    await screen.findByRole("option", { name: /机器A:src\/a.ts/ })
    expect(screen.getAllByRole("option")).toHaveLength(1)
    key("Enter")
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        refType: "remote",
        uri: "codeg://remote/1/file/2/src/a.ts",
      }),
      { from: 1, to: 2 }
    )
  })

  it("空查询返回上层，缺run能力时禁用执行目标", async () => {
    api.probe.mockResolvedValue({ capabilities: [] })
    const { key } = mount()
    await screen.findByText("机器A")
    await waitFor(() =>
      expect(screen.queryByText("probing")).not.toBeInTheDocument()
    )
    key("Enter")
    fireEvent.mouseDown(await screen.findByRole("option", { name: /项目A/ }))
    expect(
      await screen.findByRole("option", { name: /kindAssistant/ })
    ).toBeDisabled()
    expect(screen.getByRole("option", { name: /kindAgent/ })).toBeDisabled()
    key("Backspace")
    expect(
      await screen.findByRole("option", { name: /项目A/ })
    ).toBeInTheDocument()
    key("ArrowLeft")
    expect(
      await screen.findByRole("option", { name: /机器A/ })
    ).toBeInTheDocument()
  })

  it("离线连接禁用且无法进入", async () => {
    api.probe.mockRejectedValue(new Error("network_error"))
    const { key } = mount()
    expect(await screen.findByText("offline")).toBeInTheDocument()
    expect(screen.getByRole("option")).toBeDisabled()
    key("Enter")
    expect(api.folders).not.toHaveBeenCalled()
  })
})
