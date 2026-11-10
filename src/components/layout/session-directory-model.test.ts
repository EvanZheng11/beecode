import { describe, expect, it } from "vitest"
import type {
  DbConversationSummary,
  FolderDetail,
  FolderGroupDetail,
} from "@/lib/types"
import {
  applyLayoutMove,
  buildSidebarLayout,
} from "@/components/conversations/sidebar-conversation-grouping"
import {
  buildDirectoryRows,
  directoryLayoutEntries,
} from "./session-directory-model"

const folder = (
  id: number,
  extra: Partial<FolderDetail> = {}
): FolderDetail => ({
  id,
  name: `项目${id}`,
  path: `/project/${id}`,
  git_branch: null,
  default_agent_type: null,
  last_opened_at: "",
  sort_order: id,
  color: "inherit",
  parent_id: null,
  kind: "regular",
  alias: null,
  group_id: null,
  ...extra,
})
const groups: FolderGroupDetail[] = [
  { id: 10, name: "产品开发", sort_order: 1, color: "inherit" },
]
const folders = [
  folder(1, { group_id: 10 }),
  folder(2),
  folder(3, { parent_id: 1 }),
]
function rows(extra: Partial<Parameters<typeof buildDirectoryRows>[0]> = {}) {
  return buildDirectoryRows({
    layout: buildSidebarLayout({
      folders: folders.filter((f) => f.parent_id === null),
      groups,
    }),
    folders,
    groups,
    openIds: new Set([1, 2, 3]),
    archivedPaths: [],
    query: "",
    status: "all",
    collapsed: new Set(),
    ...extra,
  })
}

describe("会话目录树模型", () => {
  it("显示分组、文件夹及worktree层级", () => {
    expect(rows().map((r) => [r.key, r.depth])).toEqual([
      ["group:10", 0],
      ["folder:1", 1],
      ["folder:3", 2],
      ["folder:2", 0],
    ])
  })
  it("名称或路径命中时保留祖先", () => {
    expect(rows({ query: "/project/3" }).map((r) => r.key)).toEqual([
      "group:10",
      "folder:1",
      "folder:3",
    ])
  })
  it("分组名命中时显示成员", () => {
    expect(rows({ query: "产品开发" }).map((r) => r.key)).toEqual([
      "group:10",
      "folder:1",
      "folder:3",
    ])
  })
  it("状态过滤保留归档节点祖先", () => {
    expect(
      rows({ status: "archived", archivedPaths: ["/project/3"] }).map(
        (r) => r.key
      )
    ).toEqual(["group:10", "folder:1", "folder:3"])
  })
  it("折叠组仍保留批量选择范围", () => {
    const result = rows({ collapsed: new Set(["group:10"]) })
    expect(result.map((r) => r.key)).toEqual(["group:10", "folder:2"])
    expect(result[0].selectable).toEqual(["folder:1", "folder:3"])
  })
  it("全部状态不显示已移出目录，批量选择也不包含已移出项", () => {
    const result = rows({ openIds: new Set([1, 3]) })
    expect(result.map((r) => r.key)).toEqual([
      "group:10",
      "folder:1",
      "folder:3",
    ])
    expect(result.flatMap((r) => r.selectable)).not.toContain("folder:2")
  })
  it("分组搜索和归档筛选不会带出已移出目录", () => {
    expect(
      rows({ query: "产品开发", openIds: new Set([2, 3]) }).map((r) => r.key)
    ).toEqual(["group:10", "folder:3"])
    expect(
      rows({
        status: "archived",
        openIds: new Set([1, 3]),
        archivedPaths: ["/project/2"],
      })
    ).toEqual([])
  })
  it("父目录移出后仍显示工作区中的子目录，搜索不匹配已移出父目录", () => {
    expect(
      rows({ openIds: new Set([2, 3]) }).map((r) => [r.key, r.depth])
    ).toEqual([
      ["group:10", 0],
      ["folder:3", 1],
      ["folder:2", 0],
    ])
    expect(rows({ query: "/project/1", openIds: new Set([2, 3]) })).toEqual([])
  })
  it("排序草稿支持移入移出组，只有保存才生成契约", () => {
    const initial = buildSidebarLayout({
      folders: folders.filter((f) => f.parent_id === null),
      groups,
    })
    const moved = applyLayoutMove(initial, { kind: "folder", id: 2 }, 10, 0)
    expect(directoryLayoutEntries(moved)).toContainEqual({
      kind: "folder",
      id: 2,
      groupId: 10,
    })
    expect(directoryLayoutEntries(initial)).toContainEqual({
      kind: "folder",
      id: 2,
      groupId: null,
    })
    expect(
      directoryLayoutEntries(
        applyLayoutMove(moved, { kind: "folder", id: 1 }, null, 0)
      )[0]
    ).toEqual({ kind: "folder", id: 1, groupId: null })
  })
  it("大目录列表不分页且行键唯一", () => {
    const large = Array.from({ length: 10000 }, (_, i) => folder(i + 1))
    const result = rows({
      folders: large,
      openIds: new Set(large.map((f) => f.id)),
      groups: [],
      layout: buildSidebarLayout({ folders: large, groups: [] }),
    })
    expect(result).toHaveLength(10000)
    expect(new Set(result.map((r) => r.key)).size).toBe(10000)
  })
  it("祖先仅因状态过滤保留时不可被批量选中", () => {
    const result = rows({ status: "archived", archivedPaths: ["/project/3"] })
    expect(result.find((r) => r.key === "folder:1")?.selectable).toEqual([])
    expect(result.find((r) => r.key === "group:10")?.selectable).toEqual([
      "folder:3",
    ])
  })
  const conv = (
    id: number,
    folder_id: number,
    extra: Partial<DbConversationSummary> = {}
  ) =>
    ({
      id,
      folder_id,
      title: `会话${id}`,
      status: "completed",
      updated_at: "2026-01-01T00:00:00Z",
      pinned_at: null,
      parent_id: null,
      ...extra,
    }) as DbConversationSummary
  it("普通浏览按工作区中→已归档排序；排序模式保持原序且隐藏已移出目录", () => {
    const flat = [folder(1), folder(2), folder(3), folder(4)]
    const input = {
      folders: flat,
      groups: [],
      layout: buildSidebarLayout({ folders: flat, groups: [] }),
      openIds: new Set([1, 3]),
      archivedPaths: ["/project/1"],
    }
    expect(rows({ ...input, rank: true }).map((r) => r.key)).toEqual([
      "folder:3",
      "folder:1",
    ])
    expect(rows({ ...input, rank: false }).map((r) => r.key)).toEqual([
      "folder:1",
      "folder:3",
    ])
  })
  it("worktree 兄弟与组成员同样按状态排序", () => {
    const fs = [
      folder(1, { group_id: 10 }),
      folder(2, { parent_id: 1, sort_order: 1 }),
      folder(3, { parent_id: 1, sort_order: 2 }),
      folder(4, { group_id: 10, sort_order: 0 }),
    ]
    const result = rows({
      folders: fs,
      layout: buildSidebarLayout({
        folders: fs.filter((f) => f.parent_id === null),
        groups,
      }),
      openIds: new Set([1, 3]),
      archivedPaths: ["/project/1"],
      rank: true,
    })
    // 已移出的组成员 4 和子目录 2 均不显示。
    expect(result.map((r) => r.key)).toEqual([
      "group:10",
      "folder:1",
      "folder:3",
    ])
  })
  it("会话默认折叠，展开后作为目录子行，归档目录的会话显示为随目录归档", () => {
    const base = {
      conversations: [conv(7, 2), conv(8, 2), conv(9, 1)],
      archivedPaths: ["/project/2"],
    }
    expect(rows(base).some((r) => r.kind === "conversation")).toBe(false)
    const open = rows({ ...base, expandedSessions: new Set(["folder:2"]) })
    const sessions = open.filter((r) => r.kind === "conversation")
    expect(sessions.map((r) => r.key)).toEqual(["conv:7", "conv:8"].sort())
    expect(sessions.every((r) => r.depth === 1 && r.reason === "folder")).toBe(
      true
    )
    expect(sessions[0].selectable).toEqual(["conv:7"])
    expect(open.find((r) => r.key === "folder:2")?.sessionCount).toBe(2)
  })
  it("已归档状态过滤直接列出归档会话（含手动归档）并保留祖先", () => {
    const result = rows({
      status: "archived",
      conversations: [conv(7, 2), conv(9, 1)],
      conversationReason: (c) => (c.id === 9 ? "manual" : null),
    })
    expect(result.map((r) => r.key)).toEqual(["group:10", "folder:1", "conv:9"])
    expect(result.find((r) => r.key === "folder:1")?.selectable).toEqual([])
  })
  it("会话标题搜索只命中会话并带出所在目录", () => {
    const result = rows({
      query: "会话9",
      conversations: [conv(7, 2), conv(9, 1)],
    })
    expect(result.map((r) => r.key)).toEqual(["group:10", "folder:1", "conv:9"])
  })
  it.each(["", "/project/2", "会话7"])(
    "已移出目录及其会话不会因搜索或展开而显示：%s",
    (query) => {
      const result = rows({
        query,
        openIds: new Set([1, 3]),
        conversations: [conv(7, 2)],
        expandedSessions: new Set(["folder:2"]),
      })
      expect(result.map((r) => r.key)).not.toContain("folder:2")
      expect(result.map((r) => r.key)).not.toContain("conv:7")
    }
  )
  it("聊天会话归入虚拟段：默认折叠，归档筛选自动展开，隐藏 chat 目录", () => {
    const chat = folder(99, { kind: "chat" })
    const conv = (id: number) =>
      ({
        id,
        folder_id: 99,
        title: `聊天${id}`,
        updated_at: "2026-01-01T00:00:00Z",
        parent_id: null,
      }) as DbConversationSummary
    const extra = {
      folders,
      conversations: [conv(1), conv(2), { ...conv(3), parent_id: 1 }],
      chatFolderIds: new Set([99]),
      conversationReason: (c: DbConversationSummary) =>
        c.id === 2 ? ("manual" as const) : null,
    }
    const all = rows(extra)
    const section = all.find((r) => r.key === "chat:section")
    expect(section?.sessionCount).toBe(2)
    expect(all.some((r) => r.kind === "conversation")).toBe(false)
    expect(all.some((r) => r.id === chat.id && r.kind === "folder")).toBe(false)
    const arch = rows({ ...extra, status: "archived" }).filter(
      (r) => r.kind === "conversation"
    )
    expect(arch.map((r) => r.key)).toEqual(["conv:2"])
  })
})
