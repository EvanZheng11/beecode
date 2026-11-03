import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { MessageTurn } from "@/lib/types"
import {
  searchTranscript,
  SearchExcerpt,
  TranscriptSearchBar,
  useTranscriptSearch,
} from "./transcript-search"

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

const turns: MessageTurn[][] = [
  [
    {
      id: "1",
      role: "assistant",
      timestamp: "",
      blocks: [
        { type: "text", text: "Needle needle [x]" },
        { type: "thinking", text: "NEEDLE" },
        {
          type: "tool_use",
          tool_use_id: "a",
          tool_name: "test",
          input_preview:
            '{"needleKey":"needle value","nested":{"name":"Needle"}}',
        },
        {
          type: "tool_result",
          tool_use_id: "a",
          output_preview: "result needle",
          is_error: false,
        },
      ],
    },
  ],
]

function Harness({
  scope,
  loadAll,
}: {
  scope: number
  loadAll: () => Promise<boolean>
}) {
  const search = useTranscriptSearch({
    scope,
    rows: turns,
    hasOlder: true,
    loadAll,
  })
  return (
    <>
      <TranscriptSearchBar search={search} />
      {search.hit && <SearchExcerpt hit={search.hit} />}
    </>
  )
}

describe("transcript search", () => {
  it("counts literal occurrences in meaningful values, not JSON keys", () => {
    expect(searchTranscript(turns, "needle")).toHaveLength(6)
    expect(searchTranscript(turns, "needleKey")).toHaveLength(0)
    expect(searchTranscript(turns, "[x]")).toHaveLength(1)
    const truncated: MessageTurn[][] = [
      [
        {
          id: "2",
          role: "assistant",
          timestamp: "",
          blocks: [
            {
              type: "tool_use",
              tool_use_id: null,
              tool_name: "test",
              input_preview: '{"protocolKey":"value needle',
            },
          ],
        },
      ],
    ]
    expect(searchTranscript(truncated, "protocolKey")).toHaveLength(0)
    expect(searchTranscript(truncated, "needle")).toHaveLength(1)
  })

  it("retries incomplete history, navigates matches and resets on scope change", async () => {
    const loadAll = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const view = render(<Harness scope={1} loadAll={loadAll} />)
    fireEvent.click(screen.getByLabelText("searchOpen"))
    fireEvent.change(screen.getByLabelText("searchPlaceholder"), {
      target: { value: "needle" },
    })
    await screen.findByText("searchIncomplete")
    expect(screen.queryByText("1 / 6")).toBeNull()
    fireEvent.click(screen.getByLabelText("searchRetry"))
    await screen.findByText("1 / 6")
    expect(
      screen.getByLabelText("searchExcerpt").querySelector("mark")?.textContent
    ).toBe("Needle")
    fireEvent.keyDown(screen.getByLabelText("searchPlaceholder"), {
      key: "Enter",
    })
    expect(screen.getByText("2 / 6")).toBeTruthy()
    fireEvent.keyDown(screen.getByLabelText("searchPlaceholder"), {
      key: "Enter",
      shiftKey: true,
    })
    expect(screen.getByText("1 / 6")).toBeTruthy()
    view.rerender(<Harness scope={2} loadAll={loadAll} />)
    expect(screen.queryByLabelText("searchPlaceholder")).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByLabelText("searchOpen"))
    })
    await waitFor(() =>
      expect(screen.getByLabelText("searchPlaceholder")).toHaveProperty(
        "value",
        ""
      )
    )
    fireEvent.keyDown(screen.getByLabelText("searchPlaceholder"), {
      key: "Escape",
    })
    expect(screen.queryByLabelText("searchPlaceholder")).toBeNull()
  })
})
