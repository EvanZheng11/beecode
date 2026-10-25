import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

import { QuestionDialog } from "./question-dialog"
import enMessages from "@/i18n/messages/en.json"
import type { PendingQuestion } from "@/contexts/acp-connections-context"

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

describe("QuestionDialog", () => {
  it("returns nothing when question is null", () => {
    const { container } = renderWithIntl(
      <QuestionDialog question={null} onAnswer={() => {}} />
    )
    expect(container.firstChild).toBeNull()
  })

  it("超时恢复完整多题表单，保留多选和说明并作为新消息提交", async () => {
    const onAnswer = vi.fn()
    const questions = [
      {
        id: "recovered-0",
        header: "方式",
        question: "如何修复？",
        multi_select: false,
        options: [
          { label: "增量", description: "保留原实现" },
          { label: "重写", description: "重新实现" },
        ],
      },
      {
        id: "recovered-1",
        header: "范围",
        question: "修改哪些模块？",
        multi_select: true,
        options: [
          { label: "前端", description: "表单交互" },
          { label: "后端", description: "计时重提" },
        ],
      },
    ]
    renderWithIntl(
      <QuestionDialog
        question={{
          tool_call_id: "expired-call",
          question: "如何修复？",
          questions,
        }}
        onAnswer={onAnswer}
      />
    )
    expect(
      screen.getByText(enMessages.Folder.chat.questionDialog.recoveredHint)
    ).toBeInTheDocument()
    expect(
      screen.queryByPlaceholderText("Type your answer...")
    ).not.toBeInTheDocument()
    expect(screen.getByText("保留原实现")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("radio", { name: /增量/ }))
    fireEvent.click(screen.getByRole("checkbox", { name: /前端/ }))
    fireEvent.click(screen.getByRole("checkbox", { name: /后端/ }))
    fireEvent.click(screen.getByRole("button", { name: /Submit/ }))
    await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(1))
    const sent = onAnswer.mock.calls[0][0] as string
    const payload = JSON.parse(sent.slice(sent.indexOf("\n") + 1))
    expect(payload).toEqual({
      questions,
      answers: [
        { questionId: "recovered-0", labels: ["增量"] },
        { questionId: "recovered-1", labels: ["前端", "后端"] },
      ],
      declined: false,
    })
  })

  it("renders the en title plus the question text", () => {
    const question: PendingQuestion = {
      tool_call_id: "q-1",
      question: "Which file should I edit?",
    }
    renderWithIntl(<QuestionDialog question={question} onAnswer={() => {}} />)
    expect(screen.getByText("Agent is asking a question")).toBeInTheDocument()
    expect(screen.getByText("Which file should I edit?")).toBeInTheDocument()
  })

  it.each(["未接收", "发送失败", "拒绝回答失败"])(
    "恢复卡%s时保留选择并允许重试",
    async (failure) => {
      const onAnswer = vi.fn()
      if (failure === "未接收") onAnswer.mockResolvedValueOnce(false)
      else onAnswer.mockRejectedValueOnce(new Error("连接断开"))
      onAnswer.mockResolvedValueOnce(true)
      renderWithIntl(
        <QuestionDialog
          question={{
            tool_call_id: "retry-question",
            question: "选择实现",
            questions: [
              {
                id: "recovered-0",
                question: "选择实现",
                header: "实现",
                multi_select: false,
                options: [{ label: "增量", description: "保留已有代码" }],
              },
            ],
          }}
          onAnswer={onAnswer}
        />
      )
      const choice = screen.getByRole("radio", { name: /增量/ })
      fireEvent.click(choice)
      const command = failure === "拒绝回答失败" ? /Skip/ : /Submit/
      fireEvent.click(screen.getByRole("button", { name: command }))
      await waitFor(() =>
        expect(screen.getByRole("button", { name: command })).toBeEnabled()
      )
      expect(choice).toHaveAttribute("aria-checked", "true")
      fireEvent.click(screen.getByRole("button", { name: command }))
      await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(2))
      expect(onAnswer.mock.calls[1][0]).toBe(onAnswer.mock.calls[0][0])
      expect(screen.getByRole("button", { name: command })).toBeDisabled()
    }
  )

  it("恢复卡等待发送 Promise 确认后才保持成功状态", async () => {
    let finish!: (accepted: boolean) => void
    const onAnswer = vi.fn(
      () => new Promise<boolean>((resolve) => (finish = resolve))
    )
    renderWithIntl(
      <QuestionDialog
        question={{
          tool_call_id: "pending-send",
          question: "选择实现",
          questions: [
            {
              id: "recovered-0",
              question: "选择实现",
              header: "实现",
              multi_select: false,
              options: [{ label: "增量", description: "保留已有代码" }],
            },
          ],
        }}
        onAnswer={onAnswer}
      />
    )
    fireEvent.click(screen.getByRole("radio", { name: /增量/ }))
    fireEvent.click(screen.getByRole("button", { name: /Submit/ }))
    expect(screen.getByRole("button", { name: /Submit/ })).toBeDisabled()
    finish(false)
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Submit/ })).toBeEnabled()
    )
  })

  it("disables Send until the answer has non-whitespace content", () => {
    const question: PendingQuestion = {
      tool_call_id: "q-2",
      question: "?",
    }
    renderWithIntl(<QuestionDialog question={question} onAnswer={() => {}} />)
    const sendBtn = screen.getByRole("button", { name: /Send/i })
    expect(sendBtn).toBeDisabled()

    const textarea = screen.getByPlaceholderText("Type your answer...")
    fireEvent.change(textarea, { target: { value: "   " } })
    expect(sendBtn).toBeDisabled()

    fireEvent.change(textarea, { target: { value: "yes" } })
    expect(sendBtn).not.toBeDisabled()
  })

  it("invokes onAnswer with trimmed text when Send is clicked", () => {
    const onAnswer = vi.fn()
    const question: PendingQuestion = {
      tool_call_id: "q-3",
      question: "?",
    }
    renderWithIntl(<QuestionDialog question={question} onAnswer={onAnswer} />)
    const textarea = screen.getByPlaceholderText("Type your answer...")
    fireEvent.change(textarea, { target: { value: "   hello world   " } })
    fireEvent.click(screen.getByRole("button", { name: /Send/i }))
    expect(onAnswer).toHaveBeenCalledTimes(1)
    expect(onAnswer).toHaveBeenCalledWith("hello world")
  })

  it("resets the answer when tool_call_id changes between renders", () => {
    // The component compares the previous tool_call_id in a ref and clears
    // the answer state when a new question arrives. Regression guard: a
    // stale draft must not bleed into the next question's UI.
    const { rerender } = renderWithIntl(
      <QuestionDialog
        question={{ tool_call_id: "q-a", question: "First?" }}
        onAnswer={() => {}}
      />
    )
    const textarea = screen.getByPlaceholderText(
      "Type your answer..."
    ) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: "draft answer" } })
    expect(textarea.value).toBe("draft answer")

    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <QuestionDialog
          question={{ tool_call_id: "q-b", question: "Second?" }}
          onAnswer={() => {}}
        />
      </NextIntlClientProvider>
    )
    const refreshed = screen.getByPlaceholderText(
      "Type your answer..."
    ) as HTMLTextAreaElement
    expect(refreshed.value).toBe("")
  })
})
