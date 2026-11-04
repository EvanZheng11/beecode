import { describe, expect, it } from "vitest"

import { buildCommitGraph } from "@/components/layout/git-log-graph"

const c = (full_hash: string, ...parents: string[]) => ({ full_hash, parents })

describe("buildCommitGraph", () => {
  it("keeps a linear history in one lane", () => {
    const { rows, laneCount } = buildCommitGraph([
      c("c3", "c2"),
      c("c2", "c1"),
      c("c1"),
    ])
    expect(laneCount).toBe(1)
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0])
    expect(rows[0].incoming).toEqual([])
    expect(rows[1].incoming).toEqual([{ from: 0, to: 0, color: 0 }])
    expect(rows[2].outgoing).toEqual([])
  })

  it("opens a lane for a merge parent and closes it at the fork", () => {
    // m merges f into b; both descend from a.
    const { rows, laneCount } = buildCommitGraph([
      c("m", "b", "f"),
      c("f", "a"),
      c("b", "a"),
      c("a"),
    ])
    expect(laneCount).toBe(2)
    expect(rows[0].outgoing.map((e) => [e.from, e.to])).toEqual([
      [0, 0],
      [0, 1],
    ])
    expect(rows[1].lane).toBe(1)
    expect(rows[1].passing.map((p) => p.lane)).toEqual([0])
    expect(rows[2].lane).toBe(0)
    // f's lane (1) still carries "a" while b sits in lane 0; b's own edge
    // to "a" joins that existing lane.
    expect(rows[2].passing.map((p) => p.lane)).toEqual([1])
    expect(rows[2].outgoing.map((e) => [e.from, e.to])).toEqual([[0, 1]])
    expect(rows[3].lane).toBe(1)
    expect(rows[3].incoming.map((e) => [e.from, e.to])).toEqual([[1, 1]])
  })

  it("converges two branch tips onto their common parent", () => {
    const { rows } = buildCommitGraph([c("x", "a"), c("y", "a"), c("a")])
    // y bends into the lane already carrying "a" and frees its own lane.
    expect(rows[1].lane).toBe(1)
    expect(rows[1].outgoing.map((e) => [e.from, e.to])).toEqual([[1, 0]])
    expect(rows[2].lane).toBe(0)
    expect(rows[2].passing).toEqual([])
    expect(rows[2].incoming.map((e) => [e.from, e.to])).toEqual([[0, 0]])
  })

  it("starts unrelated tips in free lanes and tolerates missing parents", () => {
    const { rows } = buildCommitGraph([
      { full_hash: "a" },
      c("b", "outside-window"),
    ])
    expect(rows[0].outgoing).toEqual([])
    expect(rows[1].lane).toBe(0)
    expect(rows[1].incoming).toEqual([])
  })
})
