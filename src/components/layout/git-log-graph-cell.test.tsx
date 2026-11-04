import { cleanup, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { buildCommitGraph } from "./git-log-graph"
import {
  GitLogGraphCell,
  GitLogRefBadges,
  graphColumnWidth,
  isHeadCommit,
} from "./git-log-graph-cell"

afterEach(cleanup)

describe("Git log graph cells", () => {
  it("does not clip nodes when a history needs more than eight lanes", () => {
    const parents = Array.from({ length: 12 }, (_, i) => `p${i}`)
    const graph = buildCommitGraph([
      { full_hash: "merge", parents },
      ...parents.map((full_hash) => ({ full_hash, parents: [] })),
    ])
    expect(graph.laneCount).toBe(12)
    const width = graphColumnWidth(graph.laneCount)
    const { container } = render(
      <GitLogGraphCell
        row={graph.rows[12]}
        width={width}
        nodeY={20}
        isHead={false}
      />
    )
    const circle = container.querySelector("circle")!
    expect(Number(circle.getAttribute("cx")) + 4).toBeLessThan(width)
  })

  it("recognizes both attached and detached HEADs", () => {
    expect(isHeadCommit(undefined)).toBe(false)
    expect(isHeadCommit([{ name: "v1", kind: "tag", is_head: false }])).toBe(
      false
    )
    expect(isHeadCommit([{ name: "main", kind: "local", is_head: true }])).toBe(
      true
    )
    expect(isHeadCommit([{ name: "HEAD", kind: "head", is_head: false }])).toBe(
      true
    )
  })

  it("keeps overflow labels available without expanding the subject line", () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <GitLogRefBadges
          refs={[
            { name: "main", kind: "local", is_head: true },
            { name: "origin/main", kind: "remote", is_head: false },
            { name: "v1", kind: "tag", is_head: false },
            { name: "v2", kind: "tag", is_head: false },
          ]}
        />
      </NextIntlClientProvider>
    )
    expect(screen.getByTitle("Current branch (HEAD): main")).toBeVisible()
    expect(screen.getByTitle("Tag: v2")).toHaveTextContent("+1")
  })
})
