import type {
  DbConversationSummary,
  FolderDetail,
  FolderGroupDetail,
} from "@/lib/types"
import type { ConversationArchiveReason } from "@/lib/conversation-archive"
import {
  layoutToEntries,
  type SidebarLayout,
} from "@/components/conversations/sidebar-conversation-grouping"

export type DirectoryStatus = "all" | "active" | "archived" | "removed"
/** 同层级排序：工作区中 < 已归档 < 已移出。 */
export type DirectoryRank = "active" | "archived" | "removed"
const RANK: Record<DirectoryRank, number> = {
  active: 0,
  archived: 1,
  removed: 2,
}
export interface DirectoryRow {
  key: string
  kind: "folder" | "group" | "conversation"
  id: number
  depth: number
  groupId: number | null
  folder?: FolderDetail
  group?: FolderGroupDetail
  conversation?: DbConversationSummary
  /** 展示状态（目录/会话）。分组行无。 */
  rank?: DirectoryRank
  /** 会话归档原因；folder 表示随所在目录归档。 */
  reason?: ConversationArchiveReason | "folder"
  /** 目录行：所属会话数（用于展开按钮）。 */
  sessionCount?: number
  /** 可勾选项：`folder:<id>` / `conv:<id>`。 */
  selectable: string[]
}

/** 先对整棵树过滤，再展开可见行；组命中保留其成员，成员命中保留祖先。 */
export function buildDirectoryRows({
  layout,
  folders,
  groups,
  openIds,
  archivedPaths,
  query,
  status,
  collapsed,
  conversations = [],
  conversationReason = () => null,
  expandedSessions = new Set<string>(),
  rank = false,
}: {
  layout: SidebarLayout
  folders: readonly FolderDetail[]
  groups: readonly FolderGroupDetail[]
  openIds: ReadonlySet<number>
  archivedPaths: readonly string[]
  query: string
  status: DirectoryStatus
  collapsed: ReadonlySet<string>
  /** 会话（store.conversations 的顶层会话）；排序模式传空。 */
  conversations?: readonly DbConversationSummary[]
  conversationReason?: (c: DbConversationSummary) => ConversationArchiveReason
  /** 展开会话的目录 key（默认折叠，筛选状态/命中标题时自动显示）。 */
  expandedSessions?: ReadonlySet<string>
  /** 普通浏览：同层级按状态 rank 再 sort_order；排序模式保持原顺序。 */
  rank?: boolean
}): DirectoryRow[] {
  const folderMap = new Map(folders.map((f) => [f.id, f]))
  const groupMap = new Map(groups.map((g) => [g.id, g]))
  const archived = new Set(archivedPaths)
  const byFolder = new Map<number, DbConversationSummary[]>()
  for (const c of conversations) {
    if (c.parent_id != null) continue
    const list = byFolder.get(c.folder_id) ?? []
    list.push(c)
    byFolder.set(c.folder_id, list)
  }
  const folderRank = (f: FolderDetail): DirectoryRank =>
    archived.has(f.path) ? "archived" : openIds.has(f.id) ? "active" : "removed"
  const archivedIds = new Set(
    folders.filter((f) => archived.has(f.path)).map((f) => f.id)
  )
  const children = new Map<number, FolderDetail[]>()
  for (const folder of folders) {
    if (folder.parent_id == null || !folderMap.has(folder.parent_id)) continue
    const list = children.get(folder.parent_id) ?? []
    list.push(folder)
    children.set(folder.parent_id, list)
  }
  for (const list of children.values()) {
    list.sort(
      (a, b) =>
        (rank ? RANK[folderRank(a)] - RANK[folderRank(b)] : 0) ||
        a.sort_order - b.sort_order ||
        a.id - b.id
    )
  }
  const needle = query.trim().toLocaleLowerCase()
  const matchesName = (name: string) =>
    name.toLocaleLowerCase().includes(needle)
  const matchesStatus = (f: FolderDetail) => {
    const isArchived = archived.has(f.path)
    if (status === "active") return openIds.has(f.id) && !isArchived
    if (status === "archived") return isArchived
    if (status === "removed") return !openIds.has(f.id)
    return true
  }
  const rows: DirectoryRow[] = []
  const folderRows = (
    id: number,
    groupId: number | null,
    depth: number,
    inheritedMatch: boolean
  ): DirectoryRow[] => {
    const folder = folderMap.get(id)
    if (!folder) return []
    const match =
      inheritedMatch ||
      matchesName(`${folder.alias ?? ""} ${folder.name} ${folder.path}`)
    const childFolderRows = (children.get(id) ?? []).flatMap((f) =>
      folderRows(f.id, groupId, depth + 1, match)
    )
    const key = `folder:${id}`
    const own = byFolder.get(id) ?? []
    const folderArchived =
      archivedIds.has(id) ||
      (folder.parent_id != null && archivedIds.has(folder.parent_id))
    const removed = !openIds.has(id)
    const filtering = !!needle || status !== "all"
    const expanded = expandedSessions.has(key)
    const sessionRows: DirectoryRow[] = []
    for (const c of own) {
      const reason = conversationReason(c) ?? (folderArchived ? "folder" : null)
      const convRank: DirectoryRank = removed
        ? "removed"
        : reason
          ? "archived"
          : "active"
      const titleMatch = !!needle && matchesName(c.title ?? "")
      const nameOk = !needle || titleMatch || (match && expanded)
      const statusOk =
        status === "all" ||
        (status === "active" && !removed && !reason) ||
        (status === "archived" && !!reason) ||
        (status === "removed" && removed)
      const show = expanded || status !== "all" || titleMatch
      if (!show || !nameOk || !statusOk) continue
      sessionRows.push({
        key: `conv:${c.id}`,
        kind: "conversation",
        id: c.id,
        depth: depth + 1,
        groupId,
        conversation: c,
        rank: convRank,
        reason,
        selectable: [`conv:${c.id}`],
      })
    }
    if (rank)
      sessionRows.sort(
        (a, b) =>
          RANK[a.rank ?? "active"] - RANK[b.rank ?? "active"] ||
          Date.parse(b.conversation?.updated_at ?? "") -
            Date.parse(a.conversation?.updated_at ?? "") ||
          a.id - b.id
      )
    const childRows = [...childFolderRows, ...sessionRows]
    const ownMatch = match && matchesStatus(folder)
    if (!ownMatch && !childRows.length) return []
    return [
      {
        key,
        kind: "folder",
        id,
        depth,
        groupId,
        folder,
        rank: folderRank(folder),
        sessionCount: own.length,
        selectable: ownMatch ? [`folder:${id}`] : [],
      },
      ...(!collapsed.has(key) || filtering ? childRows : []),
    ]
  }
  const topEntries = rank
    ? // 稳定排序：分组视为工作区中，已归档/已移出目录排到其后
      layout.top
        .map((e, i) => ({
          e,
          i,
          r:
            e.kind === "folder" && folderMap.has(e.id)
              ? RANK[folderRank(folderMap.get(e.id)!)]
              : 0,
        }))
        .sort((a, b) => a.r - b.r || a.i - b.i)
        .map((x) => x.e)
    : layout.top
  for (const entry of topEntries) {
    if (entry.kind === "folder") {
      rows.push(...folderRows(entry.id, null, 0, false))
      continue
    }
    const group = groupMap.get(entry.id)
    if (!group) continue
    const memberIds = layout.membersByGroup.get(group.id) ?? []
    const orderedIds = rank
      ? memberIds
          .map((id, i) => ({
            id,
            i,
            r: folderMap.has(id) ? RANK[folderRank(folderMap.get(id)!)] : 0,
          }))
          .sort((a, b) => a.r - b.r || a.i - b.i)
          .map((x) => x.id)
      : memberIds
    const members = orderedIds.flatMap((id) =>
      folderRows(id, group.id, 1, !!needle && matchesName(group.name))
    )
    if (
      !members.length &&
      (needle || status !== "all") &&
      !matchesName(group.name)
    )
      continue
    if (!members.length && status !== "all") continue
    const key = `group:${group.id}`
    rows.push({
      key,
      kind: "group",
      id: group.id,
      groupId: null,
      depth: 0,
      group,
      selectable: members.flatMap((r) => r.selectable),
    })
    if (!collapsed.has(key) || needle || status !== "all") rows.push(...members)
  }
  return rows
}

export function directoryLayoutEntries(layout: SidebarLayout) {
  return layoutToEntries(layout)
}
