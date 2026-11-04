"use client"

import { useMemo, useState } from "react"
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  Folder,
  FolderMinus,
  FolderPlus,
  GripVertical,
  Layers,
  Plus,
  Search,
  Settings2,
} from "lucide-react"
import { Virtualizer } from "virtua"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import {
  setFoldersArchived,
  useArchivedFolderPaths,
} from "@/lib/folder-archive"
import { toErrorMessage } from "@/lib/app-error"
import { cn } from "@/lib/utils"
import {
  applyLayoutMove,
  buildSidebarLayout,
  locateEntry,
  reconcileLayout,
  type SidebarEntry,
  type SidebarLayout,
} from "@/components/conversations/sidebar-conversation-grouping"
import {
  buildDirectoryRows,
  directoryLayoutEntries,
  type DirectoryRow,
  type DirectoryStatus,
} from "./session-directory-model"
import { WorkspaceFolderDialog } from "./workspace-folder-dialog"

const COLUMNS =
  "grid grid-cols-[32px_minmax(180px,1.4fr)_100px_minmax(150px,1fr)_130px] items-center gap-3"
const SELECT_CLASS =
  "h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"

export function SessionDirectoryButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0 text-muted-foreground"
        title="会话目录设置"
        aria-label="会话目录设置"
        onClick={() => setOpen(true)}
      >
        <Settings2 className="h-3.5 w-3.5" />
      </Button>
      {open && <SessionDirectoryDialog open={open} onOpenChange={setOpen} />}
    </>
  )
}

export function SessionDirectoryDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const allFolders = useAppWorkspaceStore((s) => s.allFolders)
  const openFolders = useAppWorkspaceStore((s) => s.folders)
  const groups = useAppWorkspaceStore((s) => s.folderGroups)
  const applyLayout = useAppWorkspaceStore((s) => s.applySidebarLayout)
  const createGroup = useAppWorkspaceStore((s) => s.createFolderGroup)
  const removeFolder = useAppWorkspaceStore((s) => s.removeFolderFromWorkspace)
  const reopenFolder = useAppWorkspaceStore((s) => s.addFolderToWorkspaceById)
  const fetchFolders = useAppWorkspaceStore((s) => s.fetchFolders)
  const archivedPaths = useArchivedFolderPaths()
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState<DirectoryStatus>("all")
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [draft, setDraft] = useState<SidebarLayout | null>(null)
  const [dragged, setDragged] = useState<SidebarEntry | null>(null)
  const [dropKey, setDropKey] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [newGroup, setNewGroup] = useState(false)
  const [groupName, setGroupName] = useState("")
  const [folderOpen, setFolderOpen] = useState(false)
  const [defaultGroupId, setDefaultGroupId] = useState<number | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)

  const folders = useMemo(
    () => allFolders.filter((f) => f.kind !== "chat"),
    [allFolders]
  )
  const folderMap = useMemo(
    () => new Map(folders.map((f) => [f.id, f])),
    [folders]
  )
  const roots = useMemo(
    () =>
      folders.filter((f) => f.parent_id == null || !folderMap.has(f.parent_id)),
    [folders, folderMap]
  )
  const rootIds = useMemo(() => new Set(roots.map((f) => f.id)), [roots])
  const parentIds = useMemo(
    () => new Set(folders.map((f) => f.parent_id)),
    [folders]
  )
  const authoritative = useMemo(
    () => buildSidebarLayout({ folders: roots, groups }),
    [roots, groups]
  )
  const layout = useMemo(
    () => (draft ? reconcileLayout(draft, authoritative) : authoritative),
    [draft, authoritative]
  )
  const openIds = useMemo(
    () => new Set(openFolders.map((f) => f.id)),
    [openFolders]
  )
  const archived = useMemo(() => new Set(archivedPaths), [archivedPaths])
  const rows = useMemo(
    () =>
      buildDirectoryRows({
        layout,
        folders,
        groups,
        openIds,
        archivedPaths,
        query,
        status,
        collapsed,
      }),
    [layout, folders, groups, openIds, archivedPaths, query, status, collapsed]
  )
  const visibleIds = useMemo(
    () => [...new Set(rows.flatMap((r) => r.selectableIds))],
    [rows]
  )
  const selectedFolders = folders.filter((f) => selected.has(f.id))
  const allChecked =
    visibleIds.length > 0 && visibleIds.every((id) => selected.has(id))
  const someChecked = visibleIds.some((id) => selected.has(id))

  function toggle(ids: number[], checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const id of ids) {
        if (checked) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }
  function toggleCollapse(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }
  async function run(action: () => Promise<void>) {
    setBusy(true)
    try {
      await action()
    } catch (err) {
      toast.error("操作失败", { description: toErrorMessage(err) })
    } finally {
      setBusy(false)
    }
  }
  function archive(value: boolean) {
    void run(async () => {
      setFoldersArchived(
        selectedFolders.map((f) => f.path),
        value
      )
      setSelected(new Set())
      toast.success(value ? "已归档所选目录" : "已恢复所选目录")
    })
  }
  function move(entry: SidebarEntry, groupId: number | null, index: number) {
    setDraft(applyLayoutMove(layout, entry, groupId, index))
  }
  function drop(row: DirectoryRow) {
    if (!dragged) return
    if (row.kind === "group" && dragged.kind === "folder")
      move(dragged, row.id, 0)
    else {
      const target =
        dragged.kind === "group" && row.groupId != null
          ? { kind: "group" as const, id: row.groupId }
          : { kind: row.kind, id: row.id }
      const location = locateEntry(layout, target)
      if (location) move(dragged, location.groupId, location.index)
    }
    setDragged(null)
    setDropKey(null)
  }
  const close = (value: boolean) => {
    if (busy) return
    onOpenChange(value)
  }
  const sorting = draft !== null
  return (
    <>
      <Dialog open={open} onOpenChange={close}>
        <DialogContent className="flex h-[min(760px,90dvh)] max-w-[1060px] flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="border-b px-6 py-5">
            <DialogTitle className="flex items-center gap-2">
              <Settings2 className="size-5 text-primary" />
              会话目录设置
            </DialogTitle>
            <DialogDescription>
              集中管理分组和文件夹，整理工作区中的会话目录。
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap items-center gap-2 px-6 pt-4 pb-3">
            <div className="relative min-w-48 flex-1">
              <Search className="absolute top-2.5 left-3 size-4 text-muted-foreground" />
              <Input
                aria-label="过滤目录名称"
                placeholder="搜索名称或路径…"
                className="h-9 pl-9"
                value={query}
                disabled={sorting}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <select
              aria-label="过滤目录状态"
              className={SELECT_CLASS}
              value={status}
              disabled={sorting}
              onChange={(e) => setStatus(e.target.value as DirectoryStatus)}
            >
              <option value="all">全部状态</option>
              <option value="active">工作区中</option>
              <option value="archived">已归档</option>
              <option value="removed">已移出工作区</option>
            </select>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || sorting}
              onClick={() => setNewGroup(true)}
            >
              <Plus className="size-4" />
              新建分组
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || sorting}
              onClick={() => {
                setDefaultGroupId(null)
                setFolderOpen(true)
              }}
            >
              <FolderPlus className="size-4" />
              添加文件夹
            </Button>
            {!sorting && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setQuery("")
                  setStatus("all")
                  setCollapsed(new Set())
                  setSelected(new Set())
                  setDraft(authoritative)
                }}
              >
                <GripVertical className="size-4" />
                排序
              </Button>
            )}
          </div>
          <div className="flex min-h-10 flex-wrap items-center gap-2 px-6 pb-3 text-xs text-muted-foreground">
            {sorting ? (
              <>
                <span className="text-primary">
                  排序模式 · 拖动文件夹调整顺序，拖到分组行即可移入
                </span>
                <span className="ml-auto">保存后才会更新左侧目录</span>
              </>
            ) : (
              <>
                <span>已选择 {selectedFolders.length} 项</span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || !selectedFolders.length}
                  onClick={() => archive(true)}
                >
                  <Archive className="size-3.5" />
                  批量归档
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || !selectedFolders.length}
                  onClick={() => archive(false)}
                >
                  <ArchiveRestore className="size-3.5" />
                  恢复
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  disabled={
                    busy || !selectedFolders.some((f) => openIds.has(f.id))
                  }
                  onClick={() => setConfirmRemove(true)}
                >
                  <FolderMinus className="size-3.5" />
                  移出工作区
                </Button>
              </>
            )}
          </div>
          <div
            role="treegrid"
            aria-label="会话目录"
            aria-rowcount={rows.length + 1}
            aria-colcount={5}
            className="mx-6 flex min-h-0 flex-1 flex-col overflow-x-auto rounded-xl border"
          >
            <div
              role="row"
              className={cn(
                COLUMNS,
                "min-w-[740px] shrink-0 border-b bg-muted/50 px-3 py-2.5 text-xs text-muted-foreground"
              )}
            >
              <div role="columnheader">
                <Checkbox
                  aria-label="选择全部筛选目录"
                  disabled={busy || sorting || !visibleIds.length}
                  checked={
                    allChecked ? true : someChecked ? "indeterminate" : false
                  }
                  onCheckedChange={(value) =>
                    toggle(visibleIds, value === true)
                  }
                />
              </div>
              <div role="columnheader">名称</div>
              <div role="columnheader">状态</div>
              <div role="columnheader">路径 / 分组</div>
              <div role="columnheader">操作</div>
            </div>
            <div
              className="min-h-0 min-w-[740px] flex-1 overflow-y-auto"
              onDragOver={(e) => {
                if (sorting) {
                  e.preventDefault()
                  const box = e.currentTarget.getBoundingClientRect()
                  if (e.clientY < box.top + 45) e.currentTarget.scrollTop -= 18
                  if (e.clientY > box.bottom - 45)
                    e.currentTarget.scrollTop += 18
                }
              }}
            >
              {!rows.length ? (
                <div className="py-16 text-center text-sm text-muted-foreground">
                  没有匹配的目录
                </div>
              ) : (
                <Virtualizer>
                  {rows.map((row, index) => {
                    const folder = row.folder
                    const name =
                      row.group?.name ??
                      (folder?.alias
                        ? `${folder.alias} [ ${folder.name} ]`
                        : folder?.name)
                    const isArchived = !!folder && archived.has(folder.path)
                    const inWorkspace = !!folder && openIds.has(folder.id)
                    const checked =
                      row.selectableIds.length > 0 &&
                      row.selectableIds.every((id) => selected.has(id))
                    const partial = row.selectableIds.some((id) =>
                      selected.has(id)
                    )
                    const canMove =
                      row.kind === "group" ||
                      (!!folder && rootIds.has(folder.id))
                    const entry: SidebarEntry = { kind: row.kind, id: row.id }
                    const location = locateEntry(layout, entry)
                    const hasChildren =
                      row.kind === "group" || parentIds.has(row.id)
                    return (
                      <div
                        key={row.key}
                        role="row"
                        aria-rowindex={index + 2}
                        aria-level={row.depth + 1}
                        aria-selected={checked}
                        aria-expanded={
                          hasChildren ? !collapsed.has(row.key) : undefined
                        }
                        draggable={sorting && canMove && !busy}
                        onDragStart={(e) => {
                          setDragged(entry)
                          e.dataTransfer.effectAllowed = "move"
                          e.dataTransfer.setData("text/plain", row.key)
                        }}
                        onDragEnd={() => {
                          setDragged(null)
                          setDropKey(null)
                        }}
                        onDragOver={(e) => {
                          if (!sorting || !dragged || !canMove) return
                          e.preventDefault()
                          e.dataTransfer.dropEffect = "move"
                          setDropKey(row.key)
                        }}
                        onDrop={(e) => {
                          e.preventDefault()
                          if (canMove) drop(row)
                        }}
                        className={cn(
                          COLUMNS,
                          "h-14 border-b border-border/60 px-3 text-sm last:border-0 hover:bg-muted/35",
                          row.kind === "group" && "bg-muted/25 font-medium",
                          checked && "bg-primary/5",
                          dropKey === row.key &&
                            "bg-primary/10 ring-1 ring-primary ring-inset",
                          sorting && canMove && "cursor-grab"
                        )}
                      >
                        <div role="gridcell">
                          {sorting ? (
                            canMove && (
                              <GripVertical className="size-4 text-muted-foreground" />
                            )
                          ) : (
                            <Checkbox
                              aria-label={`选择 ${name}`}
                              checked={
                                checked
                                  ? true
                                  : partial
                                    ? "indeterminate"
                                    : false
                              }
                              disabled={busy || !row.selectableIds.length}
                              onCheckedChange={(value) =>
                                toggle(row.selectableIds, value === true)
                              }
                            />
                          )}
                        </div>
                        <div
                          role="gridcell"
                          className="flex min-w-0 items-center gap-2"
                          style={{ paddingLeft: row.depth * 20 }}
                        >
                          {hasChildren ? (
                            <button
                              type="button"
                              aria-label={`${collapsed.has(row.key) ? "展开" : "折叠"} ${name}`}
                              onClick={() => toggleCollapse(row.key)}
                              className="rounded p-0.5 hover:bg-muted"
                            >
                              <ChevronRight
                                className={cn(
                                  "size-3.5 transition-transform",
                                  !collapsed.has(row.key) && "rotate-90"
                                )}
                              />
                            </button>
                          ) : (
                            <span className="w-[18px] shrink-0" />
                          )}
                          {row.kind === "group" ? (
                            <Layers className="size-4 shrink-0 text-primary" />
                          ) : (
                            <Folder className="size-4 shrink-0 text-muted-foreground" />
                          )}
                          <span className="truncate" title={name}>
                            {name}
                          </span>
                          {row.kind === "group" && (
                            <span className="rounded bg-muted px-1.5 text-xs text-muted-foreground">
                              {row.selectableIds.length}
                            </span>
                          )}
                        </div>
                        <div role="gridcell">
                          {folder ? (
                            <span
                              className={cn(
                                "rounded-full px-2 py-0.5 text-xs",
                                isArchived
                                  ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                                  : inWorkspace
                                    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                                    : "bg-muted text-muted-foreground"
                              )}
                            >
                              {isArchived
                                ? "已归档"
                                : inWorkspace
                                  ? "工作区中"
                                  : "已移出"}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              分组
                            </span>
                          )}
                        </div>
                        <div
                          role="gridcell"
                          className="truncate text-xs text-muted-foreground"
                          title={folder?.path}
                        >
                          {folder?.path ?? "文件夹分组"}
                        </div>
                        <div
                          role="gridcell"
                          className="flex items-center gap-1"
                        >
                          {sorting ? (
                            canMove && (
                              <>
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={`上移 ${name}`}
                                  disabled={
                                    busy || !location || location.index === 0
                                  }
                                  onClick={() =>
                                    location &&
                                    move(
                                      entry,
                                      location.groupId,
                                      location.index - 1
                                    )
                                  }
                                >
                                  <ArrowUp className="size-3.5" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={`下移 ${name}`}
                                  disabled={busy || !location}
                                  onClick={() =>
                                    location &&
                                    move(
                                      entry,
                                      location.groupId,
                                      location.index + 1
                                    )
                                  }
                                >
                                  <ArrowDown className="size-3.5" />
                                </Button>
                              </>
                            )
                          ) : row.kind === "group" ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy}
                              onClick={() => {
                                setDefaultGroupId(row.id)
                                setFolderOpen(true)
                              }}
                            >
                              <Plus className="size-3.5" />
                              文件夹
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy}
                              onClick={() =>
                                void run(async () => {
                                  if (!folder) return
                                  if (!inWorkspace) {
                                    await reopenFolder(folder.id)
                                    setFoldersArchived([folder.path], false)
                                  } else {
                                    setFoldersArchived(
                                      [folder.path],
                                      !isArchived
                                    )
                                  }
                                })
                              }
                            >
                              {!inWorkspace
                                ? "重新加入"
                                : isArchived
                                  ? "恢复"
                                  : "归档"}
                            </Button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </Virtualizer>
              )}
            </div>
            {sorting && (
              <div
                className={cn(
                  "min-w-[740px] shrink-0 border-t border-dashed py-3 text-center text-xs",
                  dropKey === "root"
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground"
                )}
                onDragOver={(e) => {
                  if (dragged?.kind === "folder") {
                    e.preventDefault()
                    setDropKey("root")
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  if (dragged?.kind === "folder")
                    move(dragged, null, layout.top.length)
                  setDragged(null)
                  setDropKey(null)
                }}
              >
                拖到此处移出分组，放在顶层末尾
              </div>
            )}
          </div>
          <DialogFooter className="items-center px-6 py-4">
            <span className="mr-auto text-xs text-muted-foreground">
              {folders.length} 个文件夹 · {groups.length} 个分组 ·
              无分页虚拟滚动
            </span>
            {sorting ? (
              <>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => setDraft(null)}
                >
                  取消排序
                </Button>
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await applyLayout(directoryLayoutEntries(layout))
                      setDraft(null)
                      toast.success("目录排序已保存")
                    })
                  }
                >
                  <Check className="size-4" />
                  保存排序
                </Button>
              </>
            ) : (
              <Button variant="outline" onClick={() => close(false)}>
                完成
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={newGroup} onOpenChange={setNewGroup}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建分组</DialogTitle>
            <DialogDescription>将相关项目放在同一分组中。</DialogDescription>
          </DialogHeader>
          <Input
            aria-label="分组名称"
            placeholder="输入分组名称"
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            maxLength={100}
          />
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setNewGroup(false)}
            >
              取消
            </Button>
            <Button
              disabled={busy || !groupName.trim()}
              onClick={() =>
                void run(async () => {
                  await createGroup(groupName.trim())
                  setGroupName("")
                  setNewGroup(false)
                })
              }
            >
              创建分组
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>移出所选目录？</DialogTitle>
            <DialogDescription>
              将 {selectedFolders.filter((f) => openIds.has(f.id)).length}{" "}
              个目录移出工作区。不会删除磁盘文件或会话记录，可在此重新加入。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setConfirmRemove(false)}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const failures: string[] = []
                  for (const folder of selectedFolders) {
                    if (!openIds.has(folder.id)) continue
                    try {
                      await removeFolder(folder.id)
                    } catch {
                      failures.push(folder.name)
                    }
                  }
                  await fetchFolders()
                  setSelected(new Set())
                  setConfirmRemove(false)
                  if (failures.length)
                    toast.error(`部分目录移出失败：${failures.join("、")}`)
                  else toast.success("已移出所选目录")
                })
              }
            >
              确认移出
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <WorkspaceFolderDialog
        open={folderOpen}
        onOpenChange={setFolderOpen}
        defaultGroupId={defaultGroupId}
      />
    </>
  )
}
