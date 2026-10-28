import { useState } from "react"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"

import { AskQuestionCard } from "./ask-question-card"
import enMessages from "@/i18n/messages/en.json"
import type { PendingQuestionState, QuestionAnswer } from "@/lib/types"

function renderCard(
  question: PendingQuestionState,
  onAnswer = vi.fn(),
  onExtend?: (questionId: string) => Promise<string>
) {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AskQuestionCard
        question={question}
        onAnswer={onAnswer}
        onExtend={onExtend}
      />
    </NextIntlClientProvider>
  )
  return onAnswer
}

/** Render with an explicit (typically async) `onAnswer`, returning the render
 *  result so a test can reach into `container` for the spinner. */
function renderWith(
  question: PendingQuestionState,
  onAnswer: (questionId: string, answer: QuestionAnswer) => void | Promise<void>
) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AskQuestionCard question={question} onAnswer={onAnswer} />
    </NextIntlClientProvider>
  )
}

/** A manually-resolvable promise so a test can hold the answer round-trip
 *  "in flight" and assert the card's disabled/spinner state. */
function deferred() {
  let resolve!: () => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const single: PendingQuestionState = {
  question_id: "q-1",
  created_at: "2026-01-01T00:00:00Z",
  questions: [
    {
      id: "qa",
      question: "Which approach?",
      header: "Approach",
      multi_select: false,
      options: [
        { label: "Incremental", description: "smaller diffs" },
        { label: "Rewrite", description: "clean slate" },
      ],
    },
  ],
}

const multi: PendingQuestionState = {
  question_id: "q-2",
  created_at: "2026-01-01T00:00:00Z",
  questions: [
    {
      id: "qb",
      question: "Which modules?",
      header: "Scope",
      multi_select: true,
      options: [
        { label: "auth", description: "" },
        { label: "billing", description: "" },
        { label: "ui", description: "" },
      ],
    },
  ],
}

// Two single-select questions — exercises the tabbed multi-question layout.
const twoSingle: PendingQuestionState = {
  question_id: "q-two",
  created_at: "2026-01-01T00:00:00Z",
  questions: [
    {
      id: "qa",
      question: "First question?",
      header: "First",
      multi_select: false,
      options: [
        { label: "X", description: "" },
        { label: "Y", description: "" },
      ],
    },
    {
      id: "qb",
      question: "Second question?",
      header: "Second",
      multi_select: false,
      options: [
        { label: "P", description: "" },
        { label: "Q", description: "" },
      ],
    },
  ],
}

// First question is multi-select — used to assert it does NOT auto-advance.
const twoMultiFirst: PendingQuestionState = {
  question_id: "q-two-multi",
  created_at: "2026-01-01T00:00:00Z",
  questions: [
    {
      id: "qa",
      question: "First question?",
      header: "First",
      multi_select: true,
      options: [
        { label: "X", description: "" },
        { label: "Y", description: "" },
      ],
    },
    {
      id: "qb",
      question: "Second question?",
      header: "Second",
      multi_select: false,
      options: [
        { label: "P", description: "" },
        { label: "Q", description: "" },
      ],
    },
  ],
}

describe("AskQuestionCard", () => {
  it("submits a single-select choice keyed by question id", () => {
    const onAnswer = renderCard(single)
    fireEvent.click(screen.getByRole("radio", { name: /Incremental/ }))
    fireEvent.click(screen.getByRole("button", { name: "Submit" }))
    expect(onAnswer).toHaveBeenCalledWith("q-1", {
      answers: [{ questionId: "qa", labels: ["Incremental"] }],
      declined: false,
    })
  })

  it("disables Submit until something is selected", () => {
    renderCard(single)
    const submit = screen.getByRole("button", { name: "Submit" })
    expect(submit).toBeDisabled()
    fireEvent.click(screen.getByRole("radio", { name: /Rewrite/ }))
    expect(submit).not.toBeDisabled()
  })

  it("clears a single-select choice when the chosen option is clicked again", () => {
    renderCard(single)
    const submit = screen.getByRole("button", { name: "Submit" })
    fireEvent.click(screen.getByRole("radio", { name: /Incremental/ }))
    expect(submit).not.toBeDisabled()
    // Re-clicking the already-selected option deselects it (radix won't fire
    // onValueChange for the same value, so the card handles this via onClick).
    fireEvent.click(screen.getByRole("radio", { name: /Incremental/ }))
    expect(submit).toBeDisabled()
  })

  it("collects multiple labels in multi-select", () => {
    const onAnswer = renderCard(multi)
    fireEvent.click(screen.getByRole("checkbox", { name: "auth" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "billing" }))
    fireEvent.click(screen.getByRole("button", { name: "Submit" }))
    expect(onAnswer).toHaveBeenCalledWith("q-2", {
      answers: [{ questionId: "qb", labels: ["auth", "billing"] }],
      declined: false,
    })
  })

  it("renders radio controls for single-select and checkboxes for multi-select", () => {
    const { unmount } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AskQuestionCard question={single} onAnswer={vi.fn()} />
      </NextIntlClientProvider>
    )
    // Two real options + the host-injected "Other" row, all radios.
    expect(screen.getAllByRole("radio")).toHaveLength(3)
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument()
    unmount()

    renderCard(multi)
    // Three real options + "Other", all checkboxes.
    expect(screen.getAllByRole("checkbox")).toHaveLength(4)
    expect(screen.queryByRole("radio")).not.toBeInTheDocument()
  })

  it("submits the typed Other text as the answer label", () => {
    const onAnswer = renderCard(single)
    fireEvent.click(screen.getByRole("radio", { name: "Other" }))
    fireEvent.change(screen.getByPlaceholderText("Type your answer…"), {
      target: { value: "a third way" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Submit" }))
    expect(onAnswer).toHaveBeenCalledWith("q-1", {
      answers: [{ questionId: "qa", labels: ["a third way"] }],
      declined: false,
    })
  })

  it("single-select Other replaces a prior option choice", () => {
    const onAnswer = renderCard(single)
    fireEvent.click(screen.getByRole("radio", { name: /Incremental/ }))
    fireEvent.click(screen.getByRole("radio", { name: "Other" }))
    fireEvent.change(screen.getByPlaceholderText("Type your answer…"), {
      target: { value: "custom" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Submit" }))
    expect(onAnswer).toHaveBeenCalledWith("q-1", {
      answers: [{ questionId: "qa", labels: ["custom"] }],
      declined: false,
    })
  })

  it("renders a free-text question (no options) as a bare input and submits it", () => {
    // Codex elicitation / MCP-server forms ask open questions with 0 options:
    // the input is the answer field — no "Other" toggle to click through.
    const freeText: PendingQuestionState = {
      question_id: "q-free",
      created_at: "2026-01-01T00:00:00Z",
      questions: [
        {
          id: "qf",
          question: "What is the base URL?",
          header: "URL",
          multi_select: false,
          options: [],
        },
      ],
    }
    const onAnswer = renderCard(freeText)
    expect(screen.queryByRole("radio")).toBeNull()
    const input = screen.getByPlaceholderText("Type your answer…")
    const submit = screen.getByRole("button", { name: "Submit" })
    expect(submit).toBeDisabled()
    fireEvent.change(input, { target: { value: "https://api.example.com" } })
    expect(submit).toBeEnabled()
    fireEvent.click(submit)
    expect(onAnswer).toHaveBeenCalledWith("q-free", {
      answers: [{ questionId: "qf", labels: ["https://api.example.com"] }],
      declined: false,
    })
  })

  it("masks the input for a secret question", () => {
    const secret: PendingQuestionState = {
      question_id: "q-secret",
      created_at: "2026-01-01T00:00:00Z",
      questions: [
        {
          id: "qs",
          question: "Paste your API key",
          header: "Key",
          multi_select: false,
          options: [],
          is_secret: true,
        },
      ],
    }
    renderCard(secret)
    const input = screen.getByPlaceholderText("Type your answer…")
    expect(input).toHaveAttribute("type", "password")
  })

  it("skips with a declined answer", () => {
    const onAnswer = renderCard(single)
    fireEvent.click(screen.getByRole("button", { name: "Skip" }))
    expect(onAnswer).toHaveBeenCalledWith("q-1", {
      answers: [],
      declined: true,
    })
  })

  it("disables controls and shows a spinner while answering is in flight", () => {
    const d = deferred()
    const onAnswer = vi.fn(() => d.promise)
    const { container } = renderWith(single, onAnswer)
    fireEvent.click(screen.getByRole("radio", { name: /Incremental/ }))
    fireEvent.click(screen.getByRole("button", { name: "Submit" }))
    expect(onAnswer).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Skip" })).toBeDisabled()
    expect(screen.getByRole("radio", { name: /Incremental/ })).toBeDisabled()
    expect(container.querySelector(".animate-spin")).not.toBeNull()
    d.resolve()
  })

  it("ignores a second submit while one is already in flight", () => {
    const d = deferred()
    const onAnswer = vi.fn(() => d.promise)
    renderWith(single, onAnswer)
    fireEvent.click(screen.getByRole("radio", { name: /Incremental/ }))
    const submit = screen.getByRole("button", { name: "Submit" })
    fireEvent.click(submit)
    fireEvent.click(submit)
    expect(onAnswer).toHaveBeenCalledTimes(1)
    d.resolve()
  })

  it("surfaces a retryable error and re-enables controls when answering fails", async () => {
    // A rejecting onAnswer stands in for both a backend failure and the
    // "no connection" path (the context now throws there instead of silently
    // resolving, which would otherwise strand the card in its in-flight state).
    const onAnswer = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined)
    renderWith(single, onAnswer)
    fireEvent.click(screen.getByRole("radio", { name: /Rewrite/ }))
    fireEvent.click(screen.getByRole("button", { name: "Submit" }))
    // The failure surfaces inline and every control re-enables for a retry.
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("Couldn't submit. Please try again.")
    const submit = screen.getByRole("button", { name: "Submit" })
    expect(submit).not.toBeDisabled()
    expect(screen.getByRole("button", { name: "Skip" })).not.toBeDisabled()
    fireEvent.click(submit)
    expect(onAnswer).toHaveBeenCalledTimes(2)
  })

  it('renders a bare "(Recommended)" label literally instead of going empty', () => {
    const onlyRecommended: PendingQuestionState = {
      question_id: "q-3",
      created_at: "2026-01-01T00:00:00Z",
      questions: [
        {
          id: "qc",
          question: "Pick one",
          header: "Pick",
          multi_select: false,
          options: [
            { label: "(Recommended)", description: "" },
            { label: "Other path", description: "" },
          ],
        },
      ],
    }
    const onAnswer = renderCard(onlyRecommended)
    // The literal label is shown (not stripped to empty); selecting it submits
    // the verbatim label.
    fireEvent.click(screen.getByRole("radio", { name: "(Recommended)" }))
    fireEvent.click(screen.getByRole("button", { name: "Submit" }))
    expect(onAnswer).toHaveBeenCalledWith("q-3", {
      answers: [{ questionId: "qc", labels: ["(Recommended)"] }],
      declined: false,
    })
  })

  it("treats a real option labeled like the Other sentinel as a normal choice", () => {
    // The single-select RadioGroup uses index-based values, so an option whose
    // label happens to equal the internal "Other" sentinel still selects as a
    // real choice (no free-text input) and submits verbatim.
    const sentinel: PendingQuestionState = {
      question_id: "q-sentinel",
      created_at: "2026-01-01T00:00:00Z",
      questions: [
        {
          id: "qs",
          question: "Pick one",
          header: "Pick",
          multi_select: false,
          options: [
            { label: "__other__", description: "a real option" },
            { label: "Normal", description: "" },
          ],
        },
      ],
    }
    const onAnswer = renderCard(sentinel)
    fireEvent.click(screen.getByRole("radio", { name: /__other__/ }))
    // The free-text path is NOT engaged: no Other input appears.
    expect(
      screen.queryByPlaceholderText("Type your answer…")
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Submit" }))
    expect(onAnswer).toHaveBeenCalledWith("q-sentinel", {
      answers: [{ questionId: "qs", labels: ["__other__"] }],
      declined: false,
    })
  })

  it("clears the in-flight guard so a reused instance can answer the next question", async () => {
    // After a successful submit the card normally unmounts; but if the same
    // instance is reused in place for a new question_id, the re-entrancy guard
    // must not stay latched (otherwise the next Submit silently no-ops).
    const dA = deferred()
    const onAnswer = vi
      .fn()
      .mockReturnValueOnce(dA.promise)
      .mockResolvedValue(undefined)
    const { rerender } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AskQuestionCard question={single} onAnswer={onAnswer} />
      </NextIntlClientProvider>
    )
    fireEvent.click(screen.getByRole("radio", { name: /Incremental/ }))
    fireEvent.click(screen.getByRole("button", { name: "Submit" }))
    expect(onAnswer).toHaveBeenCalledTimes(1)
    // Resolve A; `run` clears the guard on the success path.
    dA.resolve()
    await dA.promise
    // The same instance is reused for a different question set (new question_id).
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AskQuestionCard question={multi} onAnswer={onAnswer} />
      </NextIntlClientProvider>
    )
    fireEvent.click(screen.getByRole("checkbox", { name: "auth" }))
    fireEvent.click(screen.getByRole("button", { name: "Submit" }))
    expect(onAnswer).toHaveBeenCalledTimes(2)
    expect(onAnswer).toHaveBeenLastCalledWith("q-2", {
      answers: [{ questionId: "qb", labels: ["auth"] }],
      declined: false,
    })
  })

  it("renders one tab per question when there are multiple", () => {
    renderCard(twoSingle)
    expect(screen.getAllByRole("tab")).toHaveLength(2)
  })

  it("auto-advances to the next tab after a single-select pick", () => {
    renderCard(twoSingle)
    expect(screen.getAllByRole("tab")[0]).toHaveAttribute(
      "aria-selected",
      "true"
    )
    // Picking an option on the first tab moves to the second.
    fireEvent.click(screen.getByRole("radio", { name: "X" }))
    const tabs = screen.getAllByRole("tab")
    expect(tabs[1]).toHaveAttribute("aria-selected", "true")
    expect(tabs[0]).toHaveAttribute("aria-selected", "false")
    // The second tab's options are now the visible ones.
    expect(screen.getByText("P")).toBeInTheDocument()
  })

  it("does not auto-advance on a multi-select pick", () => {
    renderCard(twoMultiFirst)
    fireEvent.click(screen.getByRole("checkbox", { name: "X" }))
    // Still on the first tab so further options can be picked.
    expect(screen.getAllByRole("tab")[0]).toHaveAttribute(
      "aria-selected",
      "true"
    )
    expect(screen.getByText("Y")).toBeInTheDocument()
  })

  it("marks a tab as confirmed once it is answered", () => {
    renderCard(twoSingle)
    expect(screen.getAllByRole("tab")[0]).toHaveAttribute(
      "data-answered",
      "false"
    )
    fireEvent.click(screen.getByRole("radio", { name: "X" }))
    expect(screen.getAllByRole("tab")[0]).toHaveAttribute(
      "data-answered",
      "true"
    )
  })

  it("advances the active tab with the Next button", () => {
    renderCard(twoSingle)
    expect(screen.getAllByRole("tab")[0]).toHaveAttribute(
      "aria-selected",
      "true"
    )
    fireEvent.click(screen.getByRole("button", { name: /Next/ }))
    const tabs = screen.getAllByRole("tab")
    expect(tabs[1]).toHaveAttribute("aria-selected", "true")
    // The last tab has no further tab, so Next is gone.
    expect(
      screen.queryByRole("button", { name: /Next/ })
    ).not.toBeInTheDocument()
  })

  it("shows a progress counter that advances as questions are answered", () => {
    renderCard(twoSingle)
    expect(screen.getByText("0/2")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("radio", { name: "X" })) // auto-advances
    expect(screen.getByText("1/2")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("radio", { name: "P" }))
    expect(screen.getByText("2/2")).toBeInTheDocument()
  })

  it("enables Submit only after every tab is answered, then submits all", () => {
    const onAnswer = renderCard(twoSingle)
    const submit = screen.getByRole("button", { name: /Submit/ })
    expect(submit).toBeDisabled()
    // Answer tab 1 (auto-advances to tab 2), then answer tab 2.
    fireEvent.click(screen.getByRole("radio", { name: "X" }))
    expect(screen.getByRole("button", { name: /Submit/ })).toBeDisabled()
    fireEvent.click(screen.getByRole("radio", { name: "P" }))
    const enabled = screen.getByRole("button", { name: /Submit/ })
    expect(enabled).not.toBeDisabled()
    fireEvent.click(enabled)
    expect(onAnswer).toHaveBeenCalledWith("q-two", {
      answers: [
        { questionId: "qa", labels: ["X"] },
        { questionId: "qb", labels: ["P"] },
      ],
      declined: false,
    })
  })

  it("resets selections when the question set is replaced in place", () => {
    // The shell renders the card without a per-question React key, so the card
    // must reset its own state when the question set changes underneath it.
    const onAnswer = vi.fn()
    const { rerender } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AskQuestionCard question={single} onAnswer={onAnswer} />
      </NextIntlClientProvider>
    )
    fireEvent.click(screen.getByRole("radio", { name: /Incremental/ }))
    expect(screen.getByRole("button", { name: "Submit" })).not.toBeDisabled()
    // Swap in a different question set (new question_id) at the same position.
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AskQuestionCard question={twoSingle} onAnswer={onAnswer} />
      </NextIntlClientProvider>
    )
    // No stale selection carries over: the new set renders fresh and ungated.
    expect(screen.queryByText("Incremental")).not.toBeInTheDocument()
    expect(screen.getAllByRole("tab")).toHaveLength(2)
    expect(screen.getByRole("button", { name: /Submit/ })).toBeDisabled()
  })

  it("renders nothing for an empty question set", () => {
    // Defensive guard: an empty set must not render a 0/0 card whose enabled
    // Submit would post an empty affirmative answer instead of a decline.
    const { container } = renderWith({ ...single, questions: [] }, vi.fn())
    expect(container).toBeEmptyDOMElement()
  })
})

describe("AskQuestionCard 截止时间", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const withDeadline = (
    expiresAt: string,
    base: PendingQuestionState = single
  ): PendingQuestionState => ({ ...base, expires_at: expiresAt })

  it("按 expires_at 每秒更新，最后一分钟标红，到期后禁止延长", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"))
    const onExtend = vi.fn().mockResolvedValue("2026-01-01T00:10:00.000Z")
    renderCard(withDeadline("2026-01-01T00:01:05.000Z"), vi.fn(), onExtend)

    expect(screen.getByText("01:05")).toBeInTheDocument()
    // 倒计时不是 live region：读屏器不该每秒打断用户。
    expect(document.querySelector("[aria-live]")).toBeNull()

    act(() => {
      vi.advanceTimersByTime(6_000)
    })
    const urgent = screen.getByText("00:59")
    expect(urgent).toBeInTheDocument()
    expect(urgent.parentElement).toHaveClass("text-destructive")

    act(() => {
      vi.advanceTimersByTime(59_000)
    })
    expect(screen.getByText("00:00")).toBeInTheDocument()
    const extend = screen.getByRole("button", { name: "Extend" })
    expect(extend).toBeDisabled()
    fireEvent.click(extend)
    expect(onExtend).not.toHaveBeenCalled()
  })

  it("失败时显示可重试错误，成功后用返回期限刷新倒计时", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"))
    let rejectOnce = true

    function Harness() {
      const [question, setQuestion] = useState(
        withDeadline("2026-01-01T00:05:00.000Z")
      )
      return (
        <AskQuestionCard
          question={question}
          onAnswer={vi.fn()}
          onExtend={async (questionId) => {
            if (rejectOnce) {
              rejectOnce = false
              throw new Error("boom")
            }
            const next = "2026-01-01T00:15:00.000Z"
            setQuestion((prev) => ({
              ...prev,
              question_id: questionId,
              expires_at: next,
            }))
            return next
          }}
        />
      )
    }

    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <Harness />
      </NextIntlClientProvider>
    )
    expect(screen.getByText("05:00")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Extend" }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't extend. Please try again."
    )
    expect(screen.getByRole("button", { name: "Extend" })).not.toBeDisabled()

    fireEvent.click(screen.getByRole("button", { name: "Extend" }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.getByText("15:00")).toBeInTheDocument()
  })

  it("延长成功后由父层回传的 expires_at 刷新倒计时", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"))
    const onExtend = vi.fn().mockResolvedValue("2026-01-01T00:15:00.000Z")
    const { rerender } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AskQuestionCard
          question={withDeadline("2026-01-01T00:05:00.000Z")}
          onAnswer={vi.fn()}
          onExtend={onExtend}
        />
      </NextIntlClientProvider>
    )

    expect(screen.getByText("05:00")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Extend" }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(onExtend).toHaveBeenCalledWith("q-1")
    // 卡片不缓存命令返回值；新期限只从父层（store 已用返回值刷新）回传。
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AskQuestionCard
          question={withDeadline("2026-01-01T00:15:00.000Z")}
          onAnswer={vi.fn()}
          onExtend={onExtend}
        />
      </NextIntlClientProvider>
    )
    expect(screen.getByText("15:00")).toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("延长请求进行中时禁用按钮，重复点击只发一次请求", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"))
    let finish!: (value: string) => void

    function Harness() {
      const [question, setQuestion] = useState(
        withDeadline("2026-01-01T00:05:00.000Z")
      )
      return (
        <AskQuestionCard
          question={question}
          onAnswer={vi.fn()}
          onExtend={() =>
            new Promise<string>((resolve) => {
              finish = (value) => {
                setQuestion((prev) => ({ ...prev, expires_at: value }))
                resolve(value)
              }
            })
          }
        />
      )
    }

    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <Harness />
      </NextIntlClientProvider>
    )

    const extend = screen.getByRole("button", { name: "Extend" })
    fireEvent.click(extend)
    expect(extend).toBeDisabled()
    expect(extend).toHaveAttribute("aria-busy", "true")
    fireEvent.click(extend)
    expect(screen.getByRole("button", { name: "Extend" })).toBeDisabled()

    await act(async () => {
      finish("2026-01-01T00:15:00.000Z")
      await Promise.resolve()
    })
    expect(screen.getByRole("button", { name: "Extend" })).not.toBeDisabled()
    expect(screen.getByText("15:00")).toBeInTheDocument()
  })

  it("A 延长过程中换成无期限的 B：A 成功不污染 B", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"))
    let finish!: (value: string) => void
    const onExtend = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve
        })
    )
    const { rerender } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AskQuestionCard
          question={withDeadline("2026-01-01T00:05:00.000Z")}
          onAnswer={vi.fn()}
          onExtend={onExtend}
        />
      </NextIntlClientProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: "Extend" }))
    expect(onExtend).toHaveBeenCalledWith("q-1")

    // 旧请求尚未结束时换题：B 没有 expires_at。
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AskQuestionCard
          question={twoSingle}
          onAnswer={vi.fn()}
          onExtend={onExtend}
        />
      </NextIntlClientProvider>
    )

    await act(async () => {
      finish("2026-01-01T00:15:00.000Z")
      await Promise.resolve()
    })
    // A 的返回值不能落到 B：B 仍无期限、无延长入口。
    expect(screen.queryByText("15:00")).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Extend" })
    ).not.toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("A 延长过程中换成无期限的 B：A 失败不污染 B", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"))
    let fail!: (reason: unknown) => void
    const onExtend = vi.fn(
      () =>
        new Promise<string>((_resolve, reject) => {
          fail = reject
        })
    )
    const { rerender } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AskQuestionCard
          question={withDeadline("2026-01-01T00:05:00.000Z")}
          onAnswer={vi.fn()}
          onExtend={onExtend}
        />
      </NextIntlClientProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: "Extend" }))

    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AskQuestionCard
          question={twoSingle}
          onAnswer={vi.fn()}
          onExtend={onExtend}
        />
      </NextIntlClientProvider>
    )

    await act(async () => {
      fail(new Error("boom"))
      await Promise.resolve()
    })
    // A 的失败不能把可重试错误画到 B 上。
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Extend" })
    ).not.toBeInTheDocument()
  })

  it("A 的 finally 不会解开 B 正在进行的延长请求", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"))
    const resolvers: Array<(value: string) => void> = []
    const onExtend = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve)
        })
    )
    const { rerender } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AskQuestionCard
          question={withDeadline("2026-01-01T00:05:00.000Z")}
          onAnswer={vi.fn()}
          onExtend={onExtend}
        />
      </NextIntlClientProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: "Extend" }))

    // B 也有期限，可以在 A 的请求尚未结束时开始自己的延长。
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AskQuestionCard
          question={withDeadline("2026-01-01T00:20:00.000Z", twoSingle)}
          onAnswer={vi.fn()}
          onExtend={onExtend}
        />
      </NextIntlClientProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: "Extend" }))
    expect(resolvers).toHaveLength(2)
    expect(screen.getByRole("button", { name: "Extend" })).toBeDisabled()

    await act(async () => {
      resolvers[0]!("2026-01-01T00:15:00.000Z")
      await Promise.resolve()
    })
    // B 的请求仍在进行：按钮保持 busy，不被 A 的 finally 解锁。
    const extendB = screen.getByRole("button", { name: "Extend" })
    expect(extendB).toBeDisabled()
    expect(extendB).toHaveAttribute("aria-busy", "true")

    await act(async () => {
      resolvers[1]!("2026-01-01T00:30:00.000Z")
      await Promise.resolve()
    })
    expect(screen.getByRole("button", { name: "Extend" })).not.toBeDisabled()
  })

  it("多题共用一张卡时只显示一个期限和一个延长按钮", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"))
    renderCard(
      withDeadline("2026-01-01T00:05:00.000Z", twoSingle),
      vi.fn(),
      vi.fn().mockResolvedValue("2026-01-01T00:15:00.000Z")
    )
    expect(screen.getAllByText("05:00")).toHaveLength(1)
    expect(screen.getAllByRole("button", { name: "Extend" })).toHaveLength(1)
  })

  it("只读历史卡片不显示倒计时或延长入口", () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AskQuestionCard
          readOnly
          question={withDeadline("2026-01-01T00:05:00.000Z")}
          onAnswer={vi.fn()}
          onExtend={vi.fn()}
        />
      </NextIntlClientProvider>
    )
    expect(screen.queryByText("05:00")).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Extend" })
    ).not.toBeInTheDocument()
  })

  it("没有 expires_at 的原生提问不显示倒计时或延长入口", () => {
    renderCard(single, vi.fn(), vi.fn())
    expect(
      screen.queryByRole("button", { name: "Extend" })
    ).not.toBeInTheDocument()
  })
})

describe("AskQuestionCard collapse", () => {
  it("collapses to a header-only bar and keeps the selection across the round-trip", () => {
    const onAnswer = renderCard(single)
    fireEvent.click(screen.getByRole("radio", { name: /Incremental/ }))
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }))
    // Header-only: options and the footer are unmounted.
    expect(screen.queryByRole("radio")).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Submit" })
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Expand" }))
    // The pick survived the collapse/expand round-trip.
    expect(screen.getByRole("radio", { name: /Incremental/ })).toBeChecked()
    fireEvent.click(screen.getByRole("button", { name: "Submit" }))
    expect(onAnswer).toHaveBeenCalledWith("q-1", {
      answers: [{ questionId: "qa", labels: ["Incremental"] }],
      declined: false,
    })
  })

  it("keeps the header readable while collapsed", () => {
    renderCard(twoSingle)
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }))
    // The card still says whose turn it is and how far along the set is — a
    // collapsed blocking question must not read as a dismissed one.
    expect(screen.getByText("The agent needs your input")).toBeInTheDocument()
    expect(screen.getByText("0/2")).toBeInTheDocument()
    // The tab strip goes with the body.
    expect(screen.queryByRole("tab")).not.toBeInTheDocument()
  })

  it("reports the collapsed state on the toggle", () => {
    renderCard(single)
    expect(screen.getByRole("button", { name: "Collapse" })).toHaveAttribute(
      "aria-expanded",
      "true"
    )
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }))
    expect(screen.getByRole("button", { name: "Expand" })).toHaveAttribute(
      "aria-expanded",
      "false"
    )
  })

  it("offers no collapse control in the read-only view", () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AskQuestionCard question={single} onAnswer={vi.fn()} readOnly />
      </NextIntlClientProvider>
    )
    // The in-message record has its own expand/collapse capsule; a second
    // chevron here would fight it.
    expect(
      screen.queryByRole("button", { name: "Collapse" })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Expand" })
    ).not.toBeInTheDocument()
  })

  it("re-opens when a different question set renders into the same card", () => {
    const { rerender } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AskQuestionCard question={single} onAnswer={vi.fn()} />
      </NextIntlClientProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }))
    expect(screen.queryByRole("radio")).not.toBeInTheDocument()
    // A replacement set is a NEW blocking request. Left collapsed it renders
    // as the same header row the user already put away, so they would never
    // see it and the agent would sit stalled.
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AskQuestionCard question={multi} onAnswer={vi.fn()} />
      </NextIntlClientProvider>
    )
    expect(screen.getByRole("checkbox", { name: "auth" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Collapse" })).toBeInTheDocument()
  })

  it("re-opens itself when an answer collapsed mid-flight comes back failed", async () => {
    const onAnswer = vi.fn().mockRejectedValueOnce(new Error("boom"))
    renderWith(single, onAnswer)
    fireEvent.click(screen.getByRole("radio", { name: /Rewrite/ }))
    fireEvent.click(screen.getByRole("button", { name: "Submit" }))
    // Collapsing drops the footer — the error line and the retry live there,
    // so a failure while collapsed would leave a blocking question looking
    // answered.
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't submit. Please try again."
    )
    expect(screen.getByRole("button", { name: "Submit" })).not.toBeDisabled()
  })
})
