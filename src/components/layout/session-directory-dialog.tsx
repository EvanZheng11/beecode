"use client"

import { useMemo, useState, type CSSProperties } from "react"
import { useTranslations } from "next-intl"
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
  "grid grid-cols-[28px_minmax(0,1fr)_92px] items-center gap-2 md:grid-cols-[32px_minmax(180px,1.4fr)_100px_minmax(150px,1fr)_130px] md:gap-3"
const SELECT_CLASS =
  "h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"

export function SessionDirectoryButton() {
  const t = useTranslations("Folder.sessionDirectory")
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0 text-muted-foreground"
        title={t("open")}
        aria-label={t("open")}
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
  const t = useTranslations("Folder.sessionDirectory")
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
  // 一次性建立位置表，避免逐行 locateEntry 造成 O(n²)
  const locations = useMemo(() => {
    const map = new Map<string, { groupId: number | null; index: number }>()
    layout.top.forEach((e, index) =>
      map.set(`${e.kind}:${e.id}`, { groupId: null, index })
    )
    layout.membersByGroup.forEach((ids, groupId) =>
      ids.forEach((id, index) => map.set(`folder:${id}`, { groupId, index }))
    )
    return map
  }, [layout])
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
      toast.error(t("actionFailed"), { description: toErrorMessage(err) })
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
      toast.success(value ? t("archivedToast") : t("restoredToast"))
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
    if (!value && draft && !window.confirm(t("discardConfirm"))) return
    setDraft(null)
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
              {t("title")}
            </DialogTitle>
            <DialogDescription className="hidden sm:block">
              {t("description")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap items-center gap-2 px-6 pt-4 pb-3">
            <div className="relative min-w-48 flex-1">
              <Search className="absolute top-2.5 left-3 size-4 text-muted-foreground" />
              <Input
                aria-label={t("searchLabel")}
                placeholder={t("searchPlaceholder")}
                className="h-9 pl-9"
                value={query}
                disabled={sorting}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <select
              aria-label={t("statusLabel")}
              className={SELECT_CLASS}
              value={status}
              disabled={sorting}
              onChange={(e) => setStatus(e.target.value as DirectoryStatus)}
            >
              <option value="all">{t("statusAll")}</option>
              <option value="active">{t("statusActive")}</option>
              <option value="archived">{t("statusArchived")}</option>
              <option value="removed">{t("statusRemoved")}</option>
            </select>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || sorting}
              onClick={() => setNewGroup(true)}
            >
              <Plus className="size-4" />
              {t("newGroup")}
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
              {t("addFolder")}
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
                {t("sort")}
              </Button>
            )}
          </div>
          <div className="flex min-h-10 flex-wrap items-center gap-2 px-6 pb-3 text-xs text-muted-foreground">
            {sorting ? (
              <>
                <span className="text-primary">{t("sortHint")}</span>
                <span className="ml-auto">{t("sortSaveHint")}</span>
              </>
            ) : (
              <>
                <span>
                  {t("selectedCount", { count: selectedFolders.length })}
                </span>
                <span className="text-muted-foreground/80">
                  {t("archiveNote")}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || !selectedFolders.length}
                  onClick={() => archive(true)}
                >
                  <Archive className="size-3.5" />
                  {t("archiveBatch")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || !selectedFolders.length}
                  onClick={() => archive(false)}
                >
                  <ArchiveRestore className="size-3.5" />
                  {t("restore")}
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
                  {t("removeFromWorkspace")}
                </Button>
              </>
            )}
          </div>
          <div
            role="treegrid"
            aria-label={t("gridLabel")}
            aria-rowcount={rows.length + 1}
            aria-colcount={5}
            className="mx-6 flex min-h-0 flex-1 flex-col overflow-x-auto rounded-xl border"
          >
            <div
              role="row"
              className={cn(
                COLUMNS,
                "md:min-w-[740px] shrink-0 border-b bg-muted/50 px-3 py-2.5 text-xs text-muted-foreground"
              )}
            >
              <div role="columnheader">
                <Checkbox
                  aria-label={t("selectAll")}
                  disabled={busy || sorting || !visibleIds.length}
                  checked={
                    allChecked ? true : someChecked ? "indeterminate" : false
                  }
                  onCheckedChange={(value) =>
                    toggle(visibleIds, value === true)
                  }
                />
              </div>
              <div role="columnheader">{t("colName")}</div>
              <div role="columnheader" className="hidden md:block">
                {t("colStatus")}
              </div>
              <div role="columnheader" className="hidden md:block">
                {t("colPath")}
              </div>
              <div role="columnheader" className="pl-2.5">
                {t("colActions")}
              </div>
            </div>
            <div
              className="min-h-0 md:min-w-[740px] flex-1 overflow-y-auto"
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
                  {t("empty")}
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
                    const location = locations.get(`${entry.kind}:${entry.id}`)
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
                              aria-label={t("select", { name: name ?? "" })}
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
                          className="flex min-w-0 items-center gap-2 pl-[calc(var(--depth)*12px)] md:pl-[calc(var(--depth)*20px)]"
                          style={{ "--depth": row.depth } as CSSProperties}
                        >
                          {hasChildren ? (
                            <button
                              type="button"
                              aria-label={t(
                                collapsed.has(row.key) ? "expand" : "collapse",
                                {
                                  name: name ?? "",
                                }
                              )}
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
                          {folder && (isArchived || !inWorkspace) && (
                            <span className="shrink-0 rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground md:hidden">
                              {isArchived
                                ? t("badgeArchived")
                                : t("badgeRemoved")}
                            </span>
                          )}
                          {row.kind === "group" && (
                            <span className="rounded bg-muted px-1.5 text-xs text-muted-foreground">
                              {row.selectableIds.length}
                            </span>
                          )}
                        </div>
                        <div role="gridcell" className="hidden md:block">
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
                                ? t("badgeArchived")
                                : inWorkspace
                                  ? t("statusInWorkspace")
                                  : t("badgeRemoved")}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              {t("groupKind")}
                            </span>
                          )}
                        </div>
                        <div
                          role="gridcell"
                          className="hidden truncate text-xs text-muted-foreground md:block"
                          title={folder?.path}
                        >
                          {folder?.path ?? t("groupPath")}
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
                                  aria-label={t("moveUp", { name: name ?? "" })}
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
                                  aria-label={t("moveDown", {
                                    name: name ?? "",
                                  })}
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
                              {t("addFolderToGroup")}
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
                                ? t("rejoin")
                                : isArchived
                                  ? t("restore")
                                  : t("archive")}
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
                  "md:min-w-[740px] shrink-0 border-t border-dashed py-3 text-center text-xs",
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
                {t("dropRoot")}
              </div>
            )}
          </div>
          <DialogFooter className="flex-row items-center justify-end px-6 py-4">
            <span className="mr-auto hidden text-xs text-muted-foreground sm:inline">
              {t("footerSummary", {
                folders: folders.length,
                groups: groups.length,
              })}
            </span>
            {sorting ? (
              <>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => setDraft(null)}
                >
                  {t("cancelSort")}
                </Button>
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await applyLayout(directoryLayoutEntries(layout))
                      setDraft(null)
                      toast.success(t("sortSaved"))
                    })
                  }
                >
                  <Check className="size-4" />
                  {t("saveSort")}
                </Button>
              </>
            ) : (
              <Button variant="outline" onClick={() => close(false)}>
                {t("done")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={newGroup} onOpenChange={setNewGroup}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("newGroupTitle")}</DialogTitle>
            <DialogDescription>{t("newGroupDescription")}</DialogDescription>
          </DialogHeader>
          <Input
            aria-label={t("groupNameLabel")}
            placeholder={t("groupNamePlaceholder")}
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
              {t("cancel")}
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
              {t("createGroup")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("removeTitle")}</DialogTitle>
            <DialogDescription>
              {t("removeDescription", {
                count: selectedFolders.filter((f) => openIds.has(f.id)).length,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setConfirmRemove(false)}
            >
              {t("cancel")}
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
                    toast.error(
                      t("removeFailed", { names: failures.join(", ") })
                    )
                  else toast.success(t("removed"))
                })
              }
            >
              {t("confirmRemove")}
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
