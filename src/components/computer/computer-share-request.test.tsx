import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import {
  COMPUTER_SHARE_REQUEST_CLOSED_EVENT,
  COMPUTER_SHARE_REQUEST_EVENT,
  type ShareRequestPayload,
} from "@/lib/computer/types"

const mocks = vi.hoisted(() => ({
  decide: vi.fn(() => Promise.resolve(true)),
  current: vi.fn<(requestId: string) => Promise<ShareRequestPayload | null>>(),
  desktop: true,
  handlers: new Map<string, (payload: unknown) => void>(),
}))
vi.mock("@/lib/computer/computer-api", () => ({
  computerShareRequestCurrent: mocks.current,
  computerShareRequestDecide: mocks.decide,
}))
vi.mock("@/lib/transport", () => ({
  isDesktop: () => mocks.desktop,
  getShellTransport: () => ({
    subscribe: (event: string, handler: (payload: unknown) => void) => {
      mocks.handlers.set(event, handler)
      return Promise.resolve(() => mocks.handlers.delete(event))
    },
  }),
}))

import { ComputerShareRequestConfirm } from "./computer-share-request"

function request(over: Partial<ShareRequestPayload> = {}): ShareRequestPayload {
  return {
    requestId: "r1",
    requestedLevel: "control",
    windows: [
      {
        targetId: "w1",
        appName: "Numbers",
        title: "Q3.numbers",
        level: "none",
      },
      {
        targetId: "w2",
        appName: "Safari",
        title: "Docs",
        level: "read",
      },
      { targetId: "w3", appName: "Notes", title: "todo", level: "none" },
    ],
    expiresAt: Date.now() + 120_000,
    ...over,
  }
}

async function ask(payload: ShareRequestPayload) {
  mocks.current.mockResolvedValueOnce(payload)
  await act(async () => {
    mocks.handlers.get(COMPUTER_SHARE_REQUEST_EVENT)?.({
      requestId: payload.requestId,
    })
  })
}

async function close(requestId: string) {
  await act(async () => {
    mocks.handlers.get(COMPUTER_SHARE_REQUEST_CLOSED_EVENT)?.({ requestId })
  })
}

function renderConfirm() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ComputerShareRequestConfirm />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.handlers.clear()
  mocks.desktop = true
  mocks.current.mockReset().mockResolvedValue(null)
  mocks.decide.mockResolvedValue(true)
})

afterEach(() => {
  vi.useRealTimers()
})

describe("ComputerShareRequestConfirm", () => {
  it("does not show unverified notification details", async () => {
    renderConfirm()
    await act(async () => {})
    await act(async () => {
      mocks.handlers.get(COMPUTER_SHARE_REQUEST_EVENT)?.(request())
    })
    expect(mocks.current).toHaveBeenCalledWith("r1")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(mocks.decide).not.toHaveBeenCalled()
  })

  it("shows nothing until an agent asks", async () => {
    renderConfirm()
    await act(async () => {})
    expect(screen.queryByTestId("share-request-dialog")).toBeNull()
  })

  /** AC1: the windows asked for, what each is shared for now, and the level
   *  being asked for — with nothing ticked and nothing sendable. */
  it("lists the requested windows with their current level, none ticked", async () => {
    renderConfirm()
    await act(async () => {})
    await ask(request())

    expect(screen.getByTestId("share-request-dialog")).toBeInTheDocument()
    expect(screen.getByText("Q3.numbers")).toBeInTheDocument()
    expect(screen.getByText("todo")).toBeInTheDocument()
    // The level being asked for, and each window's current one.
    expect(screen.getByText(/Can act/, { selector: "p" })).toBeInTheDocument()
    expect(screen.getByText(/Safari · Can read/)).toBeInTheDocument()
    expect(screen.getByText(/Notes · Off/)).toBeInTheDocument()
    // Everything starts unticked, and confirming needs a choice.
    for (const box of screen.getAllByRole("checkbox")) {
      expect(box).not.toBeChecked()
    }
    expect(
      screen.getByRole("button", { name: "Share selected" })
    ).toBeDisabled()
    expect(mocks.decide).not.toHaveBeenCalled()
  })

  /** AC1: only the ticked part of the request is sent. */
  it("sends only the ticked windows", async () => {
    renderConfirm()
    await act(async () => {})
    await ask(request())

    const boxes = screen.getAllByRole("checkbox")
    await act(async () => {
      fireEvent.click(boxes[0])
      fireEvent.click(boxes[2])
    })
    expect(screen.getByText(/Numbers · Off/)).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Share selected" }))
    })
    expect(mocks.decide).toHaveBeenCalledTimes(1)
    expect(mocks.decide).toHaveBeenCalledWith("r1", ["w1", "w3"])
    expect(screen.queryByTestId("share-request-dialog")).toBeNull()
  })

  /** AC2: refusing is a real answer, and it is sent — the agent is waiting. */
  it("refuses with an empty selection", async () => {
    renderConfirm()
    await act(async () => {})
    await ask(request({ requestId: "r2" }))

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Don’t share" }))
    })
    expect(mocks.decide).toHaveBeenCalledWith("r2", [])
    expect(screen.queryByTestId("share-request-dialog")).toBeNull()
  })

  /** AC2: Escape is the same refusal. */
  it("reads a dismissal as a refusal", async () => {
    renderConfirm()
    await act(async () => {})
    await ask(request({ requestId: "r3" }))

    await act(async () => {
      fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" })
    })
    expect(mocks.decide).toHaveBeenCalledWith("r3", [])
  })

  /** AC2: a request closed underneath the dialog — answered elsewhere, the
   *  agent gone — takes it away and makes any later answer stale. */
  it("goes away on share-request-closed and answers it no more", async () => {
    renderConfirm()
    await act(async () => {})
    await ask(request({ requestId: "r4" }))
    await close("r4")

    expect(screen.queryByTestId("share-request-dialog")).toBeNull()
    // Nothing was decided here: the backend already has the answer.
    expect(mocks.decide).not.toHaveBeenCalled()

    // A stale dialog cannot come back, and a late press answers nothing.
    await ask(request({ requestId: "r4" }))
    expect(screen.queryByTestId("share-request-dialog")).toBeNull()
    expect(mocks.decide).not.toHaveBeenCalled()
  })

  /** AC2: running out of time is the backend's refusal, so this side sends
   *  nothing at all — a reply after the deadline is a stale reply. */
  it("stops showing a lapsed request without answering it", async () => {
    vi.useFakeTimers()
    renderConfirm()
    await act(async () => {})
    await ask(request({ requestId: "r5", expiresAt: Date.now() + 2000 }))
    expect(screen.getByTestId("share-request-dialog")).toBeInTheDocument()

    await act(async () => {
      vi.advanceTimersByTime(3000)
    })
    expect(screen.queryByTestId("share-request-dialog")).toBeNull()
    expect(mocks.decide).not.toHaveBeenCalled()
  })

  /** A request whose deadline is already behind us lapses at once rather
   *  than standing there forever. */
  it("drops a request that arrives already expired", async () => {
    vi.useFakeTimers()
    renderConfirm()
    await act(async () => {})
    await ask(request({ requestId: "r6", expiresAt: Date.now() - 1000 }))
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(screen.queryByTestId("share-request-dialog")).toBeNull()
    expect(mocks.decide).not.toHaveBeenCalled()
  })

  /** AC2: one answer per request — a double press is not two decisions. */
  it("answers a request once", async () => {
    renderConfirm()
    await act(async () => {})
    await ask(request({ requestId: "r7" }))

    const boxes = screen.getAllByRole("checkbox")
    await act(async () => {
      fireEvent.click(boxes[0])
    })
    const confirm = screen.getByRole("button", { name: "Share selected" })
    await act(async () => {
      fireEvent.click(confirm)
      fireEvent.click(confirm)
    })
    expect(mocks.decide).toHaveBeenCalledTimes(1)
  })

  /** A newer question replaces the older one, and starts with nothing
   *  ticked: ticks do not carry from one agent's request to the next. */
  it("starts the next request with nothing ticked", async () => {
    renderConfirm()
    await act(async () => {})
    await ask(request({ requestId: "r8" }))
    await act(async () => {
      fireEvent.click(screen.getAllByRole("checkbox")[0])
    })

    await ask(
      request({
        requestId: "r9",
        windows: [
          {
            targetId: "w1",
            appName: "Numbers",
            title: "Q3.numbers",
            level: "none",
          },
        ],
      })
    )
    const [box] = screen.getAllByRole("checkbox")
    expect(box).not.toBeChecked()
    expect(
      screen.getByRole("button", { name: "Share selected" })
    ).toBeDisabled()
  })

  /** Nothing is asked, or answered, in a browser window: there is no local
   *  desktop to share. */
  it("does nothing in web mode", async () => {
    mocks.desktop = false
    renderConfirm()
    await act(async () => {})
    await ask(request({ requestId: "r10" }))
    expect(screen.queryByTestId("share-request-dialog")).toBeNull()
    expect(mocks.decide).not.toHaveBeenCalled()
  })
})
