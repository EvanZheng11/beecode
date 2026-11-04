import type {
  SidebarEntry,
  SidebarLayout,
} from "@/components/conversations/sidebar-conversation-grouping"

export type DropPos = "before" | "after" | "into"
export interface DropTarget {
  /** 传给 applyLayoutMove 的目标容器与最终索引。 */
  groupId: number | null
  index: number
  /** 可视落点：行 key（或 "root"）与位置。 */
  rowKey: string
  pos: DropPos
}
export type Locations = ReadonlyMap<
  string,
  { groupId: number | null; index: number }
>
export interface HitRow {
  key: string
  kind: "folder" | "group" | "conversation" | "chat"
  id: number
  /** 只有顶层目录/分组/组成员可作为落点；worktree 子目录和会话不可。 */
  movable: boolean
}

/** 插入位置（按原列表索引）→ applyLayoutMove 的最终索引（先移除再插入）。 */
export function finalIndex(
  locations: Locations,
  dragged: SidebarEntry,
  groupId: number | null,
  insertAt: number
) {
  const from = locations.get(`${dragged.kind}:${dragged.id}`)
  return from && from.groupId === groupId && from.index < insertAt
    ? insertAt - 1
    : insertAt
}

/** 由指针所在行及其纵向比例（0 顶 ~ 1 底）计算落点，无效返回 null。 */
export function resolveDrop(
  layout: SidebarLayout,
  locations: Locations,
  dragged: SidebarEntry,
  row: HitRow,
  ratio: number
): DropTarget | null {
  if (!row.movable) return null
  const rowLoc = locations.get(`${row.kind}:${row.id}`)
  if (!rowLoc) return null
  const make = (
    groupId: number | null,
    insertAt: number,
    pos: DropPos
  ): DropTarget => ({
    groupId,
    index: finalIndex(locations, dragged, groupId, insertAt),
    rowKey: row.key,
    pos,
  })
  if (dragged.kind === "folder") {
    if (row.kind === "group") {
      return ratio < 0.3
        ? make(null, rowLoc.index, "before")
        : make(row.id, 0, "into")
    }
    if (row.kind === "folder" && row.id === dragged.id) return null
    const after = ratio >= 0.5
    return make(
      rowLoc.groupId,
      rowLoc.index + (after ? 1 : 0),
      after ? "after" : "before"
    )
  }
  // 分组只能在顶层排序；落在成员行时按其所属分组的位置处理。
  const top =
    rowLoc.groupId != null ? locations.get(`group:${rowLoc.groupId}`) : rowLoc
  const targetGroup = row.kind === "group" ? row.id : rowLoc.groupId
  if (!top || targetGroup === dragged.id) return null
  // 落点统一画在“下一个顶层条目之前”，最后一项则落在底部区域。
  const insertAt = top.index + (ratio >= 0.5 ? 1 : 0)
  const next = layout.top[insertAt]
  return {
    groupId: null,
    index: finalIndex(locations, dragged, null, insertAt),
    rowKey: next ? `${next.kind}:${next.id}` : "root",
    pos: next ? "before" : "into",
  }
}

export function sameTarget(a: DropTarget | null, b: DropTarget | null) {
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.groupId === b.groupId &&
      a.index === b.index &&
      a.rowKey === b.rowKey &&
      a.pos === b.pos)
  )
}
