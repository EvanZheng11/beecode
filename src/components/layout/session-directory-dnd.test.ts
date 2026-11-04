import { describe, expect, it } from "vitest"
import { applyLayoutMove } from "@/components/conversations/sidebar-conversation-grouping"
import { resolveDrop, type Locations } from "./session-directory-dnd"

// top: folder1, group10[folder2, folder3], folder4
const layout = {
  top: [
    { kind: "folder" as const, id: 1 },
    { kind: "group" as const, id: 10 },
    { kind: "folder" as const, id: 4 },
  ],
  membersByGroup: new Map([[10, [2, 3]]]),
}
const locations: Locations = new Map([
  ["folder:1", { groupId: null, index: 0 }],
  ["group:10", { groupId: null, index: 1 }],
  ["folder:4", { groupId: null, index: 2 }],
  ["folder:2", { groupId: 10, index: 0 }],
  ["folder:3", { groupId: 10, index: 1 }],
])
const row = (kind: "folder" | "group", id: number, movable = true) => ({
  key: `${kind}:${id}`,
  kind,
  id,
  movable,
})
const apply = (
  dragged: { kind: "folder" | "group"; id: number },
  r: ReturnType<typeof row>,
  ratio: number
) => {
  const t = resolveDrop(layout, locations, dragged, r, ratio)
  return t && applyLayoutMove(layout, dragged, t.groupId, t.index)
}

describe("目录排序落点", () => {
  it("拖到分组行下部移入该组首位，上部放在分组前", () => {
    expect(
      apply(
        { kind: "folder", id: 1 },
        row("group", 10),
        0.6
      )?.membersByGroup.get(10)
    ).toEqual([1, 2, 3])
    expect(
      apply({ kind: "folder", id: 4 }, row("group", 10), 0.1)?.top.map(
        (e) => e.id
      )
    ).toEqual([1, 4, 10])
  })
  it("同容器向后/向前放置的索引已校正", () => {
    expect(
      apply(
        { kind: "folder", id: 2 },
        row("folder", 3),
        0.8
      )?.membersByGroup.get(10)
    ).toEqual([3, 2])
    expect(
      apply({ kind: "folder", id: 1 }, row("folder", 4), 0.8)?.top.map(
        (e) => e.id
      )
    ).toEqual([10, 4, 1])
    expect(
      apply({ kind: "folder", id: 4 }, row("folder", 1), 0.2)?.top.map(
        (e) => e.id
      )
    ).toEqual([4, 1, 10])
  })
  it("跨组：拖到其它容器成员行前后", () => {
    const r = apply({ kind: "folder", id: 1 }, row("folder", 3), 0.2)
    expect(r?.membersByGroup.get(10)).toEqual([2, 1, 3])
    expect(r?.top.map((e) => e.id)).toEqual([10, 4])
  })
  it("分组拖到成员行时按所属分组位置，落点画在下一个顶层条目前", () => {
    const t = resolveDrop(
      layout,
      locations,
      { kind: "group", id: 10 },
      row("folder", 4),
      0.9
    )
    expect(t).toMatchObject({ rowKey: "root", pos: "into" })
    const g = resolveDrop(
      layout,
      locations,
      { kind: "group", id: 10 },
      row("folder", 1),
      0.9
    )
    expect(g?.rowKey).toBe("group:10")
    expect(
      resolveDrop(
        layout,
        locations,
        { kind: "group", id: 10 },
        row("folder", 2),
        0.5
      )
    ).toBeNull()
  })
  it("worktree 子目录等不可移动行不是落点", () => {
    expect(
      resolveDrop(
        layout,
        locations,
        { kind: "folder", id: 1 },
        row("folder", 9, false),
        0.5
      )
    ).toBeNull()
  })
})
