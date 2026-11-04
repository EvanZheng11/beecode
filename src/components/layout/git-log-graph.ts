// Lane layout for the git-log commit graph (SourceTree style). Pure so it can
// be unit-tested; the component only turns rows into SVG.
//
// Lanes keep their column for their whole life (no compaction other than
// trailing empties), so a lane passing a row is always a straight vertical
// line and only the node's own edges bend.

export interface GraphCommit {
  full_hash: string
  parents?: string[]
}

export interface GraphEdge {
  /** Lane the edge starts in (row top for incoming, node for outgoing). */
  from: number
  /** Lane the edge ends in (node for incoming, row bottom for outgoing). */
  to: number
  color: number
}

export interface GraphRow {
  lane: number
  color: number
  /** Lanes crossing the whole row untouched. */
  passing: { lane: number; color: number }[]
  /** Edges from the row top into the node (children above). */
  incoming: GraphEdge[]
  /** Edges from the node to the row bottom (parents below). */
  outgoing: GraphEdge[]
}

export interface GraphLayout {
  rows: GraphRow[]
  /** Widest lane count over all rows. */
  laneCount: number
}

export const GRAPH_COLOR_COUNT = 8

export function buildCommitGraph(commits: readonly GraphCommit[]): GraphLayout {
  const lanes: (string | null)[] = []
  const laneColors: number[] = []
  let nextColor = 0
  let laneCount = 0
  const rows: GraphRow[] = []

  const allocate = (hash: string, avoid: number): number => {
    let slot = lanes.findIndex((h, i) => h === null && i !== avoid)
    if (slot === -1) slot = lanes.length
    lanes[slot] = hash
    laneColors[slot] = nextColor++ % GRAPH_COLOR_COUNT
    return slot
  }

  for (const commit of commits) {
    const hash = commit.full_hash
    let lane = lanes.indexOf(hash)
    const hasChildAbove = lane !== -1
    if (!hasChildAbove) lane = allocate(hash, -1)
    const color = laneColors[lane]

    // A hash never occupies two lanes: a child whose parent already has a lane
    // bends into it on its own row, so the only incoming edge is vertical.
    const incoming: GraphEdge[] = hasChildAbove
      ? [{ from: lane, to: lane, color }]
      : []
    const passing: GraphRow["passing"] = []
    lanes.forEach((h, i) => {
      if (h !== null && i !== lane)
        passing.push({ lane: i, color: laneColors[i] })
    })

    const outgoing: GraphEdge[] = []
    const parents = commit.parents ?? []
    lanes[lane] = null
    parents.forEach((parent, index) => {
      const existing = lanes.indexOf(parent)
      if (existing !== -1) {
        outgoing.push({ from: lane, to: existing, color: laneColors[existing] })
        return
      }
      if (index === 0) {
        lanes[lane] = parent
        outgoing.push({ from: lane, to: lane, color })
        return
      }
      const slot = allocate(parent, lane)
      outgoing.push({ from: lane, to: slot, color: laneColors[slot] })
    })

    laneCount = Math.max(laneCount, lanes.length)
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop()
      laneColors.pop()
    }
    rows.push({ lane, color, passing, incoming, outgoing })
  }

  return { rows, laneCount }
}
