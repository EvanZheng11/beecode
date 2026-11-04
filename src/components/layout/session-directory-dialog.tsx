"use client"

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react"
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
  MessageSquare,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
import {
  conversationArchiveReason,
  setConversationsArchived,
  useConversationArchiveState,
} from "@/lib/conversation-archive"
import { toErrorMessage } from "@/lib/app-error"
import { cn } from "@/lib/utils"
import {
  applyLayoutMove,
  buildSidebarLayout,
  reconcileLayout,
  type SidebarEntry,
  type SidebarLayout,
} from "@/components/conversations/sidebar-conversation-grouping"
import {
  buildDirectoryRows,
  type DirectoryRank,
  directoryLayoutEntries,
  type DirectoryStatus,
} from "./session-directory-model"
import {
  resolveDrop,
  sameTarget,
  finalIndex,
  type DropTarget,
} from "./session-directory-dnd"
import { WorkspaceFolderDialog } from "./workspace-folder-dialog"

const COLUMNS =
  "grid grid-cols-[24px_minmax(0,1fr)_96px] items-center gap-2 md:grid-cols-[28px_minmax(180px,1.4fr)_96px_minmax(150px,1fr)_168px] md:gap-3"
const ROW_BTN = "h-6 gap-1 px-1.5 text-xs [&_svg]:size-3.5"
/** 紧凑行：28px 高，按钮/复选框不撑高。 */
const ROW_H = "h-7"
const AUTOSCROLL_EDGE = 36

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
  const conversations = useAppWorkspaceStore((s) => s.conversations)
  const applyLayout = useAppWorkspaceStore((s) => s.applySidebarLayout)
  const createGroup = useAppWorkspaceStore((s) => s.createFolderGroup)
  const removeFolder = useAppWorkspaceStore((s) => s.removeFolderFromWorkspace)
  const reopenFolder = useAppWorkspaceStore((s) => s.addFolderToWorkspaceById)
  const fetchFolders = useAppWorkspaceStore((s) => s.fetchFolders)
  const archivedPaths = useArchivedFolderPaths()
  const convArchive = useConversationArchiveState()
  const [now] = useState(() => Date.now())
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState<DirectoryStatus>("all")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(
    new Set()
  )
  const [draft, setDraft] = useState<SidebarLayout | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [drop, setDrop] = useState<DropTarget | null>(null)
  const [busy, setBusy] = useState(false)
  const [newGroup, setNewGroup] = useState(false)
  const [groupName, setGroupName] = useState("")
  const [folderOpen, setFolderOpen] = useState(false)
  const [defaultGroupId, setDefaultGroupId] = useState<number | null>(null)
  const [removeIds, setRemoveIds] = useState<number[] | null>(null)
  const [groupTargets, setGroupTargets] = useState<number[] | null>(null)
  const [groupChoice, setGroupChoice] = useState("none")

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
  const sorting = draft !== null
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
        // 排序模式只显示目录/分组，且保持保存顺序（不被状态重排）
        conversations: sorting ? [] : conversations,
        conversationReason: (c) =>
          conversationArchiveReason(c, now, convArchive),
        expandedSessions,
        rank: !sorting,
      }),
    [
      layout,
      folders,
      groups,
      openIds,
      archivedPaths,
      query,
      status,
      collapsed,
      sorting,
      conversations,
      now,
      convArchive,
      expandedSessions,
    ]
  )
  const rowByKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows])
  const visibleKeys = useMemo(
    () => [...new Set(rows.flatMap((r) => r.selectable))],
    [rows]
  )
  const selectedFolders = folders.filter((f) => selected.has(`folder:${f.id}`))
  const selectedConvIds = [...selected]
    .filter((k) => k.startsWith("conv:"))
    .map((k) => Number(k.slice(5)))
  const allChecked =
    visibleKeys.length > 0 && visibleKeys.every((k) => selected.has(k))
  const someChecked = visibleKeys.some((k) => selected.has(k))

  function toggle(keys: string[], checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const key of keys) {
        if (checked) next.add(key)
        else next.delete(key)
      }
      return next
    })
  }
  function toggleIn(setter: typeof setCollapsed, key: string) {
    setter((prev) => {
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
      if (selectedFolders.length)
        setFoldersArchived(
          selectedFolders.map((f) => f.path),
          value
        )
      if (selectedConvIds.length)
        setConversationsArchived(selectedConvIds, value)
      setSelected(new Set())
      toast.success(value ? t("archivedToast") : t("restoredToast"))
    })
  }
  function moveEntry(
    entry: SidebarEntry,
    groupId: number | null,
    index: number
  ) {
    setDraft(applyLayoutMove(layout, entry, groupId, index))
  }

  // ── 分组弹窗：只移动目录，会话跟随所属目录 ──
  const groupableIds = (groupTargets ?? []).filter((id) => rootIds.has(id))
  function openGroupDialog(ids: number[]) {
    const first = ids.length === 1 ? folderMap.get(ids[0]) : undefined
    setGroupChoice(
      first
        ? first.group_id != null
          ? String(first.group_id)
          : "none"
        : groups.length
          ? String(groups[0].id)
          : "none"
    )
    setGroupTargets(ids)
  }
  function confirmGroup() {
    void run(async () => {
      const target = groupChoice === "none" ? null : Number(groupChoice)
      let next = authoritative
      for (const id of groupableIds)
        next = applyLayoutMove(
          next,
          { kind: "folder", id },
          target,
          Number.MAX_SAFE_INTEGER
        )
      await applyLayout(directoryLayoutEntries(next))
      setGroupTargets(null)
      setSelected(new Set())
      toast.success(t("groupSaved"))
    })
  }

  // ── 指针拖动：窗口级 pointer 事件 + 坐标命中，不依赖 HTML5 DnD ──
  // （Tauri/WebKit 下原生 DnD 会被 webview 拦截，旧实现真机无反应。）
  const scrollRef = useRef<HTMLDivElement>(null)
  const ghostRef = useRef<HTMLDivElement>(null)
  const latest = useRef({ layout, locations, rowByKey, rootIds })
  const dragRef = useRef<{ entry: SidebarEntry; label: string } | null>(null)
  const dropRef = useRef<DropTarget | null>(null)
  const pointer = useRef({ x: 0, y: 0 })
  const stopDrag = useRef<(() => void) | null>(null)
  useEffect(() => {
    latest.current = { layout, locations, rowByKey, rootIds }
  })
  useEffect(() => () => stopDrag.current?.(), [])
  useEffect(() => {
    if (!sorting) stopDrag.current?.()
  }, [sorting])

  function hitTest() {
    const d = dragRef.current
    if (!d) return
    const { x, y } = pointer.current
    const el = document.elementFromPoint(x, y)
    const ctx = latest.current
    let next: DropTarget | null = null
    if (el?.closest("[data-drop-root]")) {
      if (d.entry.kind === "folder")
        next = {
          groupId: null,
          index: finalIndex(
            ctx.locations,
            d.entry,
            null,
            ctx.layout.top.length
          ),
          rowKey: "root",
          pos: "into",
        }
    } else {
      const rowEl = el?.closest<HTMLElement>("[data-row-key]")
      const row = rowEl && ctx.rowByKey.get(rowEl.dataset.rowKey ?? "")
      if (rowEl && row) {
        const box = rowEl.getBoundingClientRect()
        next = resolveDrop(
          ctx.layout,
          ctx.locations,
          d.entry,
          {
            key: row.key,
            kind: row.kind,
            id: row.id,
            movable:
              row.kind === "group" ||
              (row.kind === "folder" && ctx.rootIds.has(row.id)),
          },
          box.height ? (y - box.top) / box.height : 0.5
        )
      }
    }
    if (!sameTarget(next, dropRef.current)) {
      dropRef.current = next
      setDrop(next)
    }
  }
  function placeGhost() {
    const g = ghostRef.current
    if (g)
      g.style.transform = `translate(${pointer.current.x + 12}px, ${pointer.current.y + 12}px)`
  }
  function onRowPointerDown(
    e: ReactPointerEvent<HTMLDivElement>,
    entry: SidebarEntry,
    label: string
  ) {
    if (e.button !== 0 || busy || dragRef.current) return
    if ((e.target as HTMLElement).closest("button,input,[role=checkbox]"))
      return
    const startX = e.clientX
    const startY = e.clientY
    let active = false
    let raf = 0
    pointer.current = { x: startX, y: startY }
    const tick = () => {
      const sc = scrollRef.current
      if (sc) {
        const box = sc.getBoundingClientRect()
        const y = pointer.current.y
        const speed = (dist: number) => Math.min(24, 3 + Math.floor(dist / 3))
        let dy = 0
        if (y < box.top + AUTOSCROLL_EDGE)
          dy = -speed(box.top + AUTOSCROLL_EDGE - y)
        else if (y > box.bottom - AUTOSCROLL_EDGE)
          dy = speed(y - (box.bottom - AUTOSCROLL_EDGE))
        if (dy) {
          sc.scrollTop += dy
          hitTest() // 滚动后指针下的行已变化
        }
      }
      raf = requestAnimationFrame(tick)
    }
    const onMove = (ev: PointerEvent) => {
      pointer.current = { x: ev.clientX, y: ev.clientY }
      if (!active) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return
        active = true
        dragRef.current = { entry, label }
        setDragging(`${entry.kind}:${entry.id}`)
        raf = requestAnimationFrame(tick)
      }
      placeGhost()
      hitTest()
    }
    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onCancel)
      window.removeEventListener("keydown", onKey, true)
      window.removeEventListener("blur", onCancel)
      cancelAnimationFrame(raf)
      stopDrag.current = null
      const target = dropRef.current
      dragRef.current = null
      dropRef.current = null
      setDragging(null)
      setDrop(null)
      if (commit && active && target)
        moveEntry(entry, target.groupId, target.index)
    }
    const onUp = () => finish(true)
    const onCancel = () => finish(false)
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return
      // Esc 只取消拖动，不关闭弹窗
      ev.preventDefault()
      ev.stopPropagation()
      finish(false)
    }
    stopDrag.current = () => finish(false)
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onCancel)
    window.addEventListener("keydown", onKey, true)
    window.addEventListener("blur", onCancel)
  }

  const close = (value: boolean) => {
    if (busy) return
    if (!value && draft && !window.confirm(t("discardConfirm"))) return
    setDraft(null)
    onOpenChange(value)
  }
  const removeCount = (removeIds ?? []).filter((id) => openIds.has(id)).length
  const dropClass = (key: string) => {
    if (drop?.rowKey !== key) return ""
    return drop.pos === "before"
      ? "shadow-[inset_0_2px_0_0_var(--color-primary)]"
      : drop.pos === "after"
        ? "shadow-[inset_0_-2px_0_0_var(--color-primary)]"
        : "bg-primary/10 ring-1 ring-primary ring-inset"
  }
  const rankBadge = (rank: DirectoryRank | undefined) =>
    rank === "archived"
      ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
      : rank === "active"
        ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
        : "bg-muted text-muted-foreground"
  const rankLabel = (rank: DirectoryRank | undefined) =>
    rank === "archived"
      ? t("badgeArchived")
      : rank === "active"
        ? t("statusInWorkspace")
        : t("badgeRemoved")
  const reasonLabel = (reason: string | null | undefined) =>
    reason === "manual"
      ? t("reasonManual")
      : reason === "auto"
        ? t("reasonAuto")
        : reason === "folder"
          ? t("reasonFolder")
          : null

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
            <Select
              value={status}
              disabled={sorting}
              onValueChange={(value) => setStatus(value as DirectoryStatus)}
            >
              <SelectTrigger
                aria-label={t("statusLabel")}
                size="sm"
                className="min-w-36"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("statusAll")}</SelectItem>
                <SelectItem value="active">{t("statusActive")}</SelectItem>
                <SelectItem value="archived">{t("statusArchived")}</SelectItem>
                <SelectItem value="removed">{t("statusRemoved")}</SelectItem>
              </SelectContent>
            </Select>
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
                <span>{t("selectedCount", { count: selected.size })}</span>
                <span className="text-muted-foreground/80">
                  {t("archiveNote")}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || !selected.size}
                  onClick={() => archive(true)}
                >
                  <Archive className="size-3.5" />
                  {t("archiveBatch")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || !selected.size}
                  onClick={() => archive(false)}
                >
                  <ArchiveRestore className="size-3.5" />
                  {t("restore")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || !selectedFolders.length}
                  onClick={() =>
                    openGroupDialog(selectedFolders.map((f) => f.id))
                  }
                >
                  <Layers className="size-3.5" />
                  {t("groupBatch")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  disabled={
                    busy || !selectedFolders.some((f) => openIds.has(f.id))
                  }
                  onClick={() => setRemoveIds(selectedFolders.map((f) => f.id))}
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
            className={cn(
              "mx-6 flex min-h-0 flex-1 flex-col overflow-x-auto rounded-xl border",
              dragging && "select-none"
            )}
          >
            <div
              role="row"
              className={cn(
                COLUMNS,
                "md:min-w-[780px] shrink-0 border-b bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground"
              )}
            >
              <div role="columnheader" className="flex items-center">
                <Checkbox
                  aria-label={t("selectAll")}
                  disabled={busy || sorting || !visibleKeys.length}
                  checked={
                    allChecked ? true : someChecked ? "indeterminate" : false
                  }
                  onCheckedChange={(value) =>
                    toggle(visibleKeys, value === true)
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
              ref={scrollRef}
              data-testid="directory-scroll"
              className="min-h-0 md:min-w-[780px] flex-1 overflow-y-auto"
            >
              {!rows.length ? (
                <div className="py-16 text-center text-sm text-muted-foreground">
                  {t("empty")}
                </div>
              ) : (
                <Virtualizer>
                  {rows.map((row, index) => {
                    const folder = row.folder
                    const conv = row.conversation
                    const name =
                      row.group?.name ??
                      (conv
                        ? conv.title?.trim() || t("untitled")
                        : folder?.alias
                          ? `${folder.alias} [ ${folder.name} ]`
                          : folder?.name)
                    const inWorkspace = !!folder && openIds.has(folder.id)
                    const isArchived = row.rank === "archived"
                    const checked =
                      row.selectable.length > 0 &&
                      row.selectable.every((k) => selected.has(k))
                    const partial = row.selectable.some((k) => selected.has(k))
                    const isRoot = !!folder && rootIds.has(folder.id)
                    const canMove = row.kind === "group" || isRoot
                    const entry: SidebarEntry = {
                      kind: row.kind === "group" ? "group" : "folder",
                      id: row.id,
                    }
                    const location = locations.get(`${entry.kind}:${entry.id}`)
                    const hasChildren =
                      row.kind === "group" ||
                      (row.kind === "folder" && parentIds.has(row.id))
                    const sessionsOpen = expandedSessions.has(row.key)
                    return (
                      <div
                        key={row.key}
                        role="row"
                        data-row-key={row.key}
                        aria-rowindex={index + 2}
                        aria-level={row.depth + 1}
                        aria-selected={checked}
                        aria-expanded={
                          hasChildren ? !collapsed.has(row.key) : undefined
                        }
                        onPointerDown={(e) =>
                          sorting &&
                          canMove &&
                          onRowPointerDown(e, entry, name ?? "")
                        }
                        className={cn(
                          COLUMNS,
                          ROW_H,
                          "border-b border-border/60 px-3 text-sm last:border-0 hover:bg-muted/35",
                          row.kind === "group" && "bg-muted/25 font-medium",
                          row.kind === "conversation" &&
                            "text-[13px] text-muted-foreground",
                          checked && "bg-primary/5",
                          sorting && canMove && "cursor-grab touch-none",
                          dragging === row.key && "opacity-40",
                          dropClass(row.key)
                        )}
                      >
                        <div role="gridcell" className="flex items-center">
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
                              disabled={busy || !row.selectable.length}
                              onCheckedChange={(value) =>
                                toggle(row.selectable, value === true)
                              }
                            />
                          )}
                        </div>
                        <div
                          role="gridcell"
                          className="flex min-w-0 items-center gap-1.5 pl-[calc(var(--depth)*12px)] md:pl-[calc(var(--depth)*20px)]"
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
                              onClick={() => toggleIn(setCollapsed, row.key)}
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
                          ) : conv ? (
                            <MessageSquare className="size-3.5 shrink-0" />
                          ) : (
                            <Folder className="size-4 shrink-0 text-muted-foreground" />
                          )}
                          <span className="truncate" title={name}>
                            {name}
                          </span>
                          {folder && row.rank !== "active" && (
                            <span className="shrink-0 rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground md:hidden">
                              {rankLabel(row.rank)}
                            </span>
                          )}
                          {row.kind === "group" && (
                            <span className="rounded bg-muted px-1.5 text-xs text-muted-foreground">
                              {row.selectable.length}
                            </span>
                          )}
                          {folder && !sorting && !!row.sessionCount && (
                            <button
                              type="button"
                              aria-label={t(
                                sessionsOpen ? "hideSessions" : "showSessions",
                                { name: name ?? "" }
                              )}
                              aria-pressed={sessionsOpen}
                              onClick={() =>
                                toggleIn(setExpandedSessions, row.key)
                              }
                              className={cn(
                                "flex shrink-0 items-center gap-0.5 rounded px-1 text-[11px] text-muted-foreground hover:bg-muted",
                                sessionsOpen && "bg-muted text-foreground"
                              )}
                            >
                              <MessageSquare className="size-3" />
                              {row.sessionCount}
                            </button>
                          )}
                        </div>
                        <div role="gridcell" className="hidden md:block">
                          {folder || conv ? (
                            <span
                              className={cn(
                                "rounded-full px-2 text-xs",
                                rankBadge(row.rank)
                              )}
                            >
                              {rankLabel(row.rank)}
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
                          {conv
                            ? (reasonLabel(row.reason) ??
                              conv.updated_at.slice(0, 16).replace("T", " "))
                            : (folder?.path ?? t("groupPath"))}
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
                                  size="icon-xs"
                                  aria-label={t("moveUp", { name: name ?? "" })}
                                  disabled={
                                    busy || !location || location.index === 0
                                  }
                                  onClick={() =>
                                    location &&
                                    moveEntry(
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
                                  size="icon-xs"
                                  aria-label={t("moveDown", {
                                    name: name ?? "",
                                  })}
                                  disabled={busy || !location}
                                  onClick={() =>
                                    location &&
                                    moveEntry(
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
                              size="xs"
                              className={ROW_BTN}
                              disabled={busy}
                              onClick={() => {
                                setDefaultGroupId(row.id)
                                setFolderOpen(true)
                              }}
                            >
                              <Plus />
                              {t("addFolderToGroup")}
                            </Button>
                          ) : conv ? (
                            row.reason !== "folder" && (
                              <Button
                                variant="ghost"
                                size="xs"
                                className={ROW_BTN}
                                disabled={busy}
                                title={name}
                                onClick={() =>
                                  setConversationsArchived(
                                    [conv.id],
                                    !row.reason
                                  )
                                }
                              >
                                {row.reason ? <ArchiveRestore /> : <Archive />}
                                {row.reason ? t("restore") : t("archive")}
                              </Button>
                            )
                          ) : (
                            folder && (
                              <>
                                <Button
                                  variant="ghost"
                                  size="xs"
                                  className={ROW_BTN}
                                  disabled={busy || !isRoot}
                                  title={isRoot ? undefined : t("worktreeNote")}
                                  onClick={() => openGroupDialog([folder.id])}
                                >
                                  <Layers />
                                  <span className="max-md:sr-only">
                                    {t("group")}
                                  </span>
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="xs"
                                  className={ROW_BTN}
                                  disabled={busy}
                                  onClick={() =>
                                    void run(async () => {
                                      if (!inWorkspace) {
                                        await reopenFolder(folder.id)
                                        setFoldersArchived([folder.path], false)
                                      } else {
                                        setFoldersArchived(
                                          [folder.path],
                                          !archived.has(folder.path)
                                        )
                                      }
                                    })
                                  }
                                >
                                  {!inWorkspace ? (
                                    <Plus />
                                  ) : isArchived ? (
                                    <ArchiveRestore />
                                  ) : (
                                    <Archive />
                                  )}
                                  <span className="max-md:sr-only">
                                    {!inWorkspace
                                      ? t("rejoin")
                                      : isArchived
                                        ? t("restore")
                                        : t("archive")}
                                  </span>
                                </Button>
                                {inWorkspace && (
                                  <Button
                                    variant="ghost"
                                    size="xs"
                                    className={cn(
                                      ROW_BTN,
                                      "text-destructive hover:text-destructive"
                                    )}
                                    disabled={busy}
                                    onClick={() => setRemoveIds([folder.id])}
                                  >
                                    <FolderMinus />
                                    <span className="max-md:sr-only">
                                      {t("removeRow")}
                                    </span>
                                  </Button>
                                )}
                              </>
                            )
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
                data-drop-root
                className={cn(
                  "md:min-w-[780px] shrink-0 border-t border-dashed py-2 text-center text-xs",
                  drop?.rowKey === "root"
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground"
                )}
              >
                {t("dropRoot")}
              </div>
            )}
          </div>
          {dragging && (
            <div
              ref={ghostRef}
              className="pointer-events-none fixed top-0 left-0 z-[100] max-w-60 truncate rounded-md border bg-popover px-2 py-1 text-xs shadow-md"
            >
              {dragRef.current?.label}
            </div>
          )}
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
      <Dialog
        open={groupTargets !== null}
        onOpenChange={(value) => !value && !busy && setGroupTargets(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("groupTitle")}</DialogTitle>
            <DialogDescription>
              {t("groupDescription", {
                count: groupableIds.length,
                skipped: (groupTargets?.length ?? 0) - groupableIds.length,
              })}
            </DialogDescription>
          </DialogHeader>
          <Select value={groupChoice} onValueChange={setGroupChoice}>
            <SelectTrigger
              aria-label={t("groupTargetLabel")}
              className="w-full"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{t("noGroup")}</SelectItem>
              {groups.map((group) => (
                <SelectItem key={group.id} value={String(group.id)}>
                  {group.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t("worktreeNote")}</p>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setGroupTargets(null)}
            >
              {t("cancel")}
            </Button>
            <Button
              disabled={busy || !groupableIds.length}
              onClick={confirmGroup}
            >
              {t("confirmGroup")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={removeIds !== null}
        onOpenChange={(value) => !value && setRemoveIds(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("removeTitle")}</DialogTitle>
            <DialogDescription>
              {t("removeDescription", { count: removeCount })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setRemoveIds(null)}
            >
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const failures: string[] = []
                  for (const id of removeIds ?? []) {
                    if (!openIds.has(id)) continue
                    try {
                      await removeFolder(id)
                    } catch {
                      failures.push(folderMap.get(id)?.name ?? String(id))
                    }
                  }
                  await fetchFolders()
                  setSelected(new Set())
                  setRemoveIds(null)
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
