import type { FolderDetail, FolderGroupDetail } from "@/lib/types"
import {
  layoutToEntries,
  type SidebarLayout,
} from "@/components/conversations/sidebar-conversation-grouping"

export type DirectoryStatus = "all" | "active" | "archived" | "removed"
export interface DirectoryRow {
  key: string
  kind: "folder" | "group"
  id: number
  depth: number
  groupId: number | null
  folder?: FolderDetail
  group?: FolderGroupDetail
  selectableIds: number[]
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
}: {
  layout: SidebarLayout
  folders: readonly FolderDetail[]
  groups: readonly FolderGroupDetail[]
  openIds: ReadonlySet<number>
  archivedPaths: readonly string[]
  query: string
  status: DirectoryStatus
  collapsed: ReadonlySet<string>
}): DirectoryRow[] {
  const folderMap = new Map(folders.map((f) => [f.id, f]))
  const groupMap = new Map(groups.map((g) => [g.id, g]))
  const archived = new Set(archivedPaths)
  const children = new Map<number, FolderDetail[]>()
  for (const folder of folders) {
    if (folder.parent_id == null || !folderMap.has(folder.parent_id)) continue
    const list = children.get(folder.parent_id) ?? []
    list.push(folder)
    children.set(folder.parent_id, list)
  }
  for (const list of children.values()) {
    list.sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
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
    const childRows = (children.get(id) ?? []).flatMap((f) =>
      folderRows(f.id, groupId, depth + 1, match)
    )
    const ownMatch = match && matchesStatus(folder)
    if (!ownMatch && !childRows.length) return []
    const key = `folder:${id}`
    return [
      {
        key, kind: "folder", id, depth, groupId, folder,
        selectableIds: ownMatch ? [id] : [],
      },
      ...(!collapsed.has(key) || needle || status !== "all" ? childRows : []),
    ]
  }
  for (const entry of layout.top) {
    if (entry.kind === "folder") {
      rows.push(...folderRows(entry.id, null, 0, false))
      continue
    }
    const group = groupMap.get(entry.id)
    if (!group) continue
    const members = (layout.membersByGroup.get(group.id) ?? []).flatMap((id) =>
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
      selectableIds: members.flatMap((r) => r.selectableIds),
    })
    if (!collapsed.has(key) || needle || status !== "all") rows.push(...members)
  }
  return rows
}

export function directoryLayoutEntries(layout: SidebarLayout) {
  return layoutToEntries(layout)
}
