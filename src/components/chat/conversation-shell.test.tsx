import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { ComponentProps } from "react"
import { act, render, screen, fireEvent } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"

// 保留真实 Shell → ChatInput → MessageQueueDisplay，仅替换编辑器及无关子组件。
vi.mock("@/components/chat/message-input", () => ({
  MessageInput: () => <div data-testid="composer" />,
}))
vi.mock("@/components/chat/chat-width-handles", () => ({
  ChatWidthHandles: () => <div data-testid="width-handles" />,
}))
vi.mock("@/components/chat/composer-status-strips", () => ({
  ComposerStatusStrips: () => null,
}))
vi.mock("@/components/chat/async-task-strip", () => ({
  AsyncTaskStrip: () => null,
}))
vi.mock("@/components/chat/permission-dialog", () => ({
  PermissionDialog: () => null,
}))
vi.mock("@/components/chat/question-dialog", () => ({
  QuestionDialog: () => null,
}))
vi.mock("@/components/chat/ask-question-card", () => ({
  AskQuestionCard: () => null,
}))
vi.mock("@/components/chat/plan-approval-card", () => ({
  PlanApprovalCard: () => null,
}))

import { ConversationShell } from "./conversation-shell"

type ShellProps = ComponentProps<typeof ConversationShell>

const appendMessages = {
  ...enMessages,
  Folder: {
    ...enMessages.Folder,
    chat: {
      ...enMessages.Folder.chat,
      messageList: {
        ...enMessages.Folder.chat.messageList,
        appendAsFeedback: "追加为实时反馈",
      },
    },
  },
}

function renderShell(extra: Partial<ShellProps> = {}) {
  const noop = () => {}
  const props = {
    status: null,
    promptCapabilities: {},
    claudeApiRetry: null,
    pendingPermission: null,
    pendingQuestion: null,
    pendingAskQuestion: null,
    pendingPlanApproval: null,
    onFocus: noop,
    onSend: noop,
    onCancel: noop,
    onRespondPermission: noop,
    onAnswerQuestion: noop,
    onAnswerAskQuestion: noop,
    onAnswerPlanApproval: noop,
    ...extra,
  } as unknown as ShellProps
  return render(
    <NextIntlClientProvider locale="en" messages={appendMessages}>
      <ConversationShell {...props}>
        <div data-testid="transcript" />
      </ConversationShell>
    </NextIntlClientProvider>
  )
}

/** The shell's root: the transcript's host is its child. */
const shellRoot = () =>
  screen.getByTestId("transcript").parentElement!.parentElement!

describe("ConversationShell chat-width handles", () => {
  it("has neither handles nor a gutter by default (canvas cards)", () => {
    renderShell()
    expect(screen.queryByTestId("width-handles")).toBeNull()
    expect(shellRoot().style.getPropertyValue("--chat-gutter")).toBe("")
  })

  it("adds the handles and the window-edge gutter when resizable", () => {
    renderShell({ resizableWidth: true })
    expect(screen.getByTestId("width-handles")).toBeInTheDocument()
    // Mounted beside the transcript, in a positioned host spanning it.
    const host = screen.getByTestId("transcript").parentElement!
    expect(host).toContainElement(screen.getByTestId("width-handles"))
    expect(host).toHaveClass("relative")
    expect(shellRoot().style.getPropertyValue("--chat-gutter")).toBe("12px")
  })
})

describe("ConversationShell 队列追加接线", () => {
  const queueProps = {
    queue: [
      {
        id: "真实队列-id",
        draft: {
          displayText: "排队消息",
          blocks: [{ type: "text" as const, text: "排队消息" }],
        },
        modeId: null,
      },
    ],
    onQueueReorder: vi.fn(),
    onQueueEdit: vi.fn(),
    onQueueDelete: vi.fn(),
  }

  it("经真实 ChatInput 把队列 id 传给宿主回调", async () => {
    const onQueueSteer = vi.fn(async () => {})
    renderShell({ ...queueProps, onQueueSteer })

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "追加为实时反馈" }))
    })
    expect(onQueueSteer).toHaveBeenCalledTimes(1)
    expect(onQueueSteer).toHaveBeenCalledWith("真实队列-id")
  })

  it("把宿主追加状态透传给所有队列控件", () => {
    renderShell({
      ...queueProps,
      onQueueSteer: vi.fn(async () => {}),
      appendingQueuedMessageId: "另一队列-id",
    })

    expect(screen.getAllByRole("button")).toHaveLength(4)
    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled()
    }
  })
})

describe("who turns the handles on", () => {
  const read = (path: string) =>
    readFileSync(resolve(process.cwd(), path), "utf8")

  it("is the conversation tab, not the zoomable canvas card", () => {
    // Canvas cards render the shell under the board's scale transform, where
    // the handles' pointer maths would be off by the zoom factor.
    // Boolean shorthand only: `resizableWidth={false}` must not pass.
    expect(
      read("src/components/conversations/conversation-detail-panel.tsx")
    ).toMatch(/<ConversationShell\s+resizableWidth\s/)
    expect(
      read("src/components/canvas/canvas-conversation-surface.tsx")
    ).not.toContain("resizableWidth")
  })
})
