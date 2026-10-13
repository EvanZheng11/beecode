import {
  act,
  fireEvent,
  render,
  screen,
  cleanup,
  waitFor,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { QueuedMessage } from "@/hooks/use-message-queue"

import { MessageQueueDisplay } from "./message-queue-display"

const appendLabel = "追加为实时反馈"
const appendMessages = {
  ...enMessages,
  Folder: {
    ...enMessages.Folder,
    chat: {
      ...enMessages.Folder.chat,
      messageList: {
        ...enMessages.Folder.chat.messageList,
        appendAsFeedback: appendLabel,
      },
    },
  },
}

function item(id: string, text: string): QueuedMessage {
  return {
    id,
    draft: { blocks: [{ type: "text", text }], displayText: text },
    modeId: null,
  }
}

/** A queued draft that carries an attachment — only the native wire takes it. */
function itemWithAttachment(id: string, text: string): QueuedMessage {
  return {
    id,
    draft: {
      blocks: [
        { type: "text", text },
        {
          type: "resource",
          uri: "clipboard://shot.png-1",
          mime_type: "image/png",
          text: null,
          blob: "QUJD",
        },
      ],
      displayText: text,
    },
    modeId: null,
  }
}

function renderDisplay(
  props: Partial<React.ComponentProps<typeof MessageQueueDisplay>> = {}
) {
  return render(
    <NextIntlClientProvider locale="en" messages={appendMessages}>
      <MessageQueueDisplay
        queue={[item("q1", "use pnpm"), item("q2", "run the tests")]}
        onReorder={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        editingItemId={null}
        {...props}
      />
    </NextIntlClientProvider>
  )
}

afterEach(cleanup)

describe("MessageQueueDisplay click-to-insert", () => {
  it("无回调时隐藏追加入口", () => {
    renderDisplay()
    expect(screen.queryByTitle(appendLabel)).toBeNull()
    expect(screen.queryByLabelText(appendLabel)).toBeNull()
  })

  it("inserts the row the button belongs to, with the native promise", async () => {
    const onSteerItem = vi.fn(async () => {})
    renderDisplay({ onSteerItem, steerChannel: "native" })

    const buttons = screen.getAllByTitle(appendLabel)
    expect(buttons).toHaveLength(2)
    expect(buttons[1]).toHaveAttribute("aria-label", appendLabel)

    await userEvent.click(buttons[1])
    expect(onSteerItem).toHaveBeenCalledTimes(1)
    expect(onSteerItem).toHaveBeenCalledWith("q2")
  })

  it("在 pull 通道使用追加文案并保留留言图标", async () => {
    const onSteerItem = vi.fn(async () => {})
    renderDisplay({ onSteerItem, steerChannel: "pull" })

    const buttons = screen.getAllByRole("button", { name: appendLabel })
    expect(buttons).toHaveLength(2)
    expect(buttons[0].querySelector(".lucide-clock")).not.toBeNull()
    await userEvent.click(buttons[0])
    expect(onSteerItem).toHaveBeenCalledWith("q1")
  })

  it("disables every row while an insert is in flight (single-flight)", async () => {
    let release: () => void = () => {}
    const onSteerItem = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    renderDisplay({ onSteerItem, steerChannel: "native" })

    const buttons = screen.getAllByTitle(appendLabel) as HTMLButtonElement[]
    await userEvent.click(buttons[0])
    await waitFor(() => expect(onSteerItem).toHaveBeenCalledTimes(1))

    expect(screen.getAllByRole("button")).toHaveLength(8)
    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled()
    }
    // 同步锁保护所有行，渲染后的控件状态也必须覆盖拖拽、编辑和删除。
    await userEvent.click(buttons[1])
    expect(onSteerItem).toHaveBeenCalledTimes(1)

    release()
    await waitFor(() => expect(buttons[1].disabled).toBe(false))
  })

  it("React 提交禁用态之前同一行和另一行的快速点击只回调一次", async () => {
    let release!: () => void
    const onSteerItem = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    renderDisplay({ onSteerItem, steerChannel: "native" })
    const buttons = screen.getAllByTitle(appendLabel)
    act(() => {
      buttons[0].click()
      expect(buttons[1]).not.toBeDisabled()
      buttons[0].click()
      buttons[1].click()
    })
    expect(onSteerItem).toHaveBeenCalledTimes(1)
    expect(onSteerItem).toHaveBeenCalledWith("q1")
    await act(async () => {
      release()
    })
  })

  it("宿主追加进行中禁用所有操作并阻止回调", () => {
    const onSteerItem = vi.fn(async () => {})
    const onEdit = vi.fn()
    const onDelete = vi.fn()
    renderDisplay({
      onSteerItem,
      onEdit,
      onDelete,
      steerChannel: "native",
      appendingQueuedMessageId: "q2",
    })

    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled()
      fireEvent.click(button)
    }
    expect(onSteerItem).not.toHaveBeenCalled()
    expect(onEdit).not.toHaveBeenCalled()
    expect(onDelete).not.toHaveBeenCalled()
    expect(screen.getAllByTitle(appendLabel)).toHaveLength(2)
  })
  it("hides the note button on a pull row the channel cannot carry", () => {
    // The pull tool delivers text only, so the backend rejects a draft with
    // attachments there — the click could never insert anything. The row is
    // still sent whole (attachment included) by the queue's own flush.
    renderDisplay({
      queue: [item("q1", "use pnpm"), itemWithAttachment("q2", "look at this")],
      onSteerItem: vi.fn(async () => {}),
      steerChannel: "pull",
    })
    expect(screen.getAllByTitle(appendLabel)).toHaveLength(1)
  })

  it("keeps the attachment row insertable on the native wire", () => {
    renderDisplay({
      queue: [item("q1", "use pnpm"), itemWithAttachment("q2", "look at this")],
      onSteerItem: vi.fn(async () => {}),
      steerChannel: "native",
    })
    expect(screen.getAllByTitle(appendLabel)).toHaveLength(2)
  })

  it("编辑中的队列项隐藏追加按钮，其他行仍传出正确 id", async () => {
    const onSteerItem = vi.fn(async () => {})
    renderDisplay({
      onSteerItem,
      steerChannel: "native",
      editingItemId: "q1",
    })
    const buttons = screen.getAllByRole("button", { name: appendLabel })
    expect(buttons).toHaveLength(1)
    await userEvent.click(buttons[0])
    expect(onSteerItem).toHaveBeenCalledTimes(1)
    expect(onSteerItem).toHaveBeenCalledWith("q2")
  })
})
