import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, expect, it, vi } from "vitest"
import messages from "@/i18n/messages/en.json"
import { ProjectTrustDialog } from "./project-trust-dialog"

const mock = vi.hoisted(() => ({
  handlers: {} as Record<string, (value: never) => void>,
  ready: () => {},
  pending: vi.fn(),
  resolve: vi.fn(),
}))
vi.mock("@/lib/platform", () => ({
  subscribe: async (event: string, handler: (value: never) => void) => {
    mock.handlers[event] = handler
    return () => {}
  },
  onTransportReady: (handler: () => void) => {
    mock.ready = handler
    return () => {}
  },
}))
vi.mock("@/lib/project-trust", () => ({
  pendingProjectTrust: mock.pending,
  resolveProjectTrust: mock.resolve,
}))

const request = (requestId: string) => ({
  requestId,
  createdAt: "now",
  targets: [
    {
      agentType: "pi",
      workspace: `/${requestId}`,
      resources: [],
      warning: "risk",
    },
  ],
})
beforeEach(() => {
  mock.handlers = {}
  mock.pending.mockReset().mockResolvedValue([])
  mock.resolve.mockReset().mockResolvedValue(undefined)
})

it("合并补拉与事件，去重排队，拒绝后继续下一项", async () => {
  mock.pending.mockResolvedValue([request("a")])
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ProjectTrustDialog />
    </NextIntlClientProvider>
  )
  expect(await screen.findByText("pi: /a")).toBeInTheDocument()
  act(() => {
    mock.handlers["project-trust-requested"](request("a") as never)
    mock.handlers["project-trust-requested"](request("b") as never)
  })
  fireEvent.click(screen.getByRole("button", { name: "拒绝" }))
  expect(await screen.findByText("pi: /b")).toBeInTheDocument()
  expect(mock.resolve).toHaveBeenCalledWith("a", false)
  mock.pending.mockResolvedValue([request("b"), request("c")])
  act(() => mock.ready())
  fireEvent.click(screen.getByRole("button", { name: "允许" }))
  expect(await screen.findByText("pi: /c")).toBeInTheDocument()
})

it("批准失败保留请求并允许重试", async () => {
  mock.pending.mockResolvedValue([request("a")])
  mock.resolve.mockRejectedValueOnce(new Error("failed"))
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ProjectTrustDialog />
    </NextIntlClientProvider>
  )
  await screen.findByText("pi: /a")
  fireEvent.click(screen.getByRole("button", { name: "允许" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("failed")
  expect(screen.getByText("pi: /a")).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "允许" }))
  await waitFor(() =>
    expect(screen.queryByText("pi: /a")).not.toBeInTheDocument()
  )
})

it("补拉期间到达的事件不会被旧快照移除", async () => {
  let finish: (requests: ReturnType<typeof request>[]) => void = () => {}
  mock.pending.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ProjectTrustDialog />
    </NextIntlClientProvider>
  )
  await waitFor(() => expect(mock.pending).toHaveBeenCalled())
  act(() => mock.handlers["project-trust-requested"](request("new") as never))
  expect(await screen.findByText("pi: /new")).toBeInTheDocument()
  await act(async () => finish([]))
  expect(screen.getByText("pi: /new")).toBeInTheDocument()
})
