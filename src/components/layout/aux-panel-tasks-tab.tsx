"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ChevronRight,
  Funnel,
  ListTodo,
  Plus,
  Search,
  SquareArrowOutUpRight,
  X,
} from "lucide-react"
import {
  groupTasksByColumn,
  type BoardColumnId,
} from "@/components/tasks/board-columns"
import { mergeQueueRanks } from "@/components/tasks/task-acceptance"
import { ConversationBoardCard } from "@/components/tasks/conversation-board-card"
import { projectBoardConversations } from "@/components/tasks/folder-board-conversations"
import { TaskCard } from "@/components/tasks/task-card"
import { useOpenConversation } from "@/components/tasks/use-open-conversation"
import { searchTerms, taskMatchesSearch } from "@/components/tasks/task-search"
import { useTaskDialogs } from "@/components/tasks/use-task-dialogs"
import { Button } from "@/components/ui/button"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { useTasksView } from "@/contexts/tasks-view-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useActiveProjectFolderId } from "@/hooks/use-active-project-folder"
import {
  saveTasksBoardFilter,
  useTasksBoardFilter,
} from "@/lib/tasks-board-filter-storage"
import { cn } from "@/lib/utils"
import { requestTasksFocus } from "@/lib/workbench-focus"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { GIT_TOOLBAR_ICON_BUTTON_CLASS } from "./git-toolbar-controls"

/**
 * The board's four columns, stacked — in the order a glance down a sidebar
 * wants them: what is waiting on you, what is running, what is queued, and
 * what is finished. (The board reads them left to right in workflow order; a
 * column of sections reads top-down, and the top is what gets seen.)
 */
const SECTION_ORDER: readonly BoardColumnId[] = [
  "attention",
  "inProgress",
  "todo",
  "done",
]

/** The board's own column names and marker tones, so a section reads as the
 *  column it is. */
const SECTION_LABEL_KEYS = {
  todo: "colTodo",
  inProgress: "colInProgress",
  attention: "colAttention",
  done: "colDone",
} as const satisfies Record<BoardColumnId, string>

const SECTION_TONE: Record<BoardColumnId, string> = {
  todo: "bg-muted-foreground/50",
  inProgress: "bg-primary",
  attention: "bg-amber-500",
  done: "bg-emerald-500",
}

/**
 * 右侧面板的任务页签：只看当前文件夹——项目根目录下已有的任务，加上还没有
 * 关联任务的普通会话（纯前端投影，不新建任务记录）。两者按同一套看板分区纵向
 * 堆叠，已关联任务的会话不会重复出现。
 *
 * 任务卡片能力与看板一致：编辑器、详情抽屉，以及验收 / 重启 / 跟进对话框都来自
 * Tasks 页面同一个 `useTaskDialogs`。普通会话卡只打开会话本身，不调用任何任务
 * 更新/删除接口。留在完整页上的，是需要更大空间的那些操作：拖拽卡片、列表视图。
 *
 * 分区按任务的真实状态划分：「以后处理」的 review / failed 仍归入等你处理分区；
 * 完整看板则把它们归到已完成——那个覆盖规则属于看板，不改变状态本身，也不改变
 * 右侧面板的分组。归档 / 已取消开关直接在本页签的筛选按钮里操作，与完整页共用
 * 同一份持久化设置。
 */
export function TasksAuxTab() {
  const t = useTranslations("Tasks")
  const tAux = useTranslations("Folder.auxPanel")
  const { tasks, loading, refetch } = useTasksView()
  // 当前目录所属的项目根：任务行的 folder_id 就记在这里（在 worktree 里跑的任务
  // 也记在项目根），按它严格过滤既覆盖当前 worktree 的任务，也不混入别的项目。
  const folderId = useActiveProjectFolderId()
  const allFolders = useAppWorkspaceStore((s) => s.allFolders)
  const conversations = useAppWorkspaceStore((s) => s.conversations)
  // 普通会话则严格按「当前目录」取：worktree 标签页里只看这个 worktree 的会话，
  // 不把同项目其它 worktree 的会话混进来。
  const conversationFolderId = useAppWorkspaceStore((s) => s.activeFolderId)
  const { setRoute } = useWorkbenchRoute()
  const openConversation = useOpenConversation()

  const folderNames = useMemo(() => {
    const map = new Map<number, string>()
    for (const f of allFolders) map.set(f.id, f.alias ?? f.name)
    return map
  }, [allFolders])

  // 与完整看板共用同一份开关（跨窗口实时同步），所以这里直接切换归档筛选
  // 就等同于完整页的「显示归档」。
  const boardFilter = useTasksBoardFilter()
  const [searchInput, setSearchInput] = useState("")
  const terms = useMemo(() => searchTerms(searchInput), [searchInput])
  const searching = terms.length > 0
  // Done starts folded: it only grows, and the sections above it are the ones
  // that ask for something.
  const [collapsed, setCollapsed] = useState<ReadonlySet<BoardColumnId>>(
    () => new Set<BoardColumnId>(["done"])
  )

  // One shared timestamp per tick keeps every card's relative time
  // consistent, like the board's.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [])

  // 当前文件夹范围：没有当前文件夹时列表为空（页签本身也只在这种时候隐藏）。
  const currentTasks = useMemo(
    () =>
      folderId == null
        ? []
        : tasks.filter((task) => task.folder_id === folderId),
    [tasks, folderId]
  )
  const columns = useMemo(
    () =>
      groupTasksByColumn(
        currentTasks.filter((task) =>
          taskMatchesSearch(
            task,
            terms,
            folderNames.get(task.folder_id) ?? null
          )
        ),
        boardFilter.showCanceled,
        boardFilter.showArchived,
        // 按真实状态分区（以后处理的 review / failed 仍在等你处理）。
        true
      ),
    [currentTasks, terms, folderNames, boardFilter]
  )
  // 未关联任务的普通会话：用全量任务做去重，避免已归档任务的会话又冒出来。
  const conversationColumns = useMemo(
    () =>
      projectBoardConversations({
        conversations,
        tasks,
        folderId: conversationFolderId ?? folderId,
        showCanceled: boardFilter.showCanceled,
        terms,
        folderNames,
      }),
    [
      conversations,
      tasks,
      conversationFolderId,
      folderId,
      boardFilter.showCanceled,
      terms,
      folderNames,
    ]
  )
  // Over ALL tasks: the merge queue is the project's, and a narrowed view must
  // not renumber it (the board computes it the same way).
  const queueRanks = useMemo(() => mergeQueueRanks(tasks), [tasks])

  const { handlersFor, openDetail, openNewTask, dialogs } = useTaskDialogs({
    tasks,
    refetch,
    folderNames,
    defaultFolderId: folderId,
  })

  // 完整页与这里同范围：打开就是当前文件夹的看板。
  const openBoard = useCallback(() => {
    requestTasksFocus({ folderId })
    setRoute("tasks")
  }, [folderId, setRoute])

  const toggleSection = useCallback((column: BoardColumnId) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(column)) next.delete(column)
      else next.add(column)
      return next
    })
  }, [])

  const shownSections = SECTION_ORDER.filter(
    (column) =>
      columns[column].length > 0 || conversationColumns[column].length > 0
  )
  const conversationTotal = SECTION_ORDER.reduce(
    (total, column) => total + conversationColumns[column].length,
    0
  )
  const hasAnyTask = currentTasks.length > 0 || conversationTotal > 0

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The h-10 band every aux tab opens with: the search where the changes
          tab keeps its commit field, then the two actions. */}
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/50 pl-2 pr-2">
        <InputGroup className="h-7 min-w-0 flex-1 rounded-full">
          <InputGroupAddon align="inline-start">
            <Search className="size-3.5" aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && searchInput !== "") {
                e.preventDefault()
                setSearchInput("")
              }
            }}
            placeholder={t("searchPlaceholder")}
            aria-label={t("searchPlaceholder")}
            className="h-7 text-xs"
          />
          {searchInput !== "" ? (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                aria-label={t("clearSearch")}
                title={t("clearSearch")}
                onClick={() => setSearchInput("")}
              >
                <X className="size-3" />
              </InputGroupButton>
            </InputGroupAddon>
          ) : null}
        </InputGroup>
        {/* 归档 / 已取消筛选：直接在当前看板上操作，写入与完整页共用的设置。 */}
        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn(
                GIT_TOOLBAR_ICON_BUTTON_CLASS,
                (boardFilter.showArchived || !boardFilter.showCanceled) &&
                  "text-primary"
              )}
              title={t("filter")}
              aria-label={t("filter")}
            >
              <Funnel className="size-3.5" aria-hidden />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-52 gap-0.5 rounded-xl p-1.5">
            <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-accent/50">
              <Checkbox
                checked={boardFilter.showArchived}
                onCheckedChange={(v) =>
                  saveTasksBoardFilter({
                    ...boardFilter,
                    showArchived: v === true,
                  })
                }
              />
              {t("showArchived")}
            </label>
            <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-accent/50">
              <Checkbox
                checked={boardFilter.showCanceled}
                onCheckedChange={(v) =>
                  saveTasksBoardFilter({
                    ...boardFilter,
                    showCanceled: v === true,
                  })
                }
              />
              {t("showCanceled")}
            </label>
          </PopoverContent>
        </Popover>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={GIT_TOOLBAR_ICON_BUTTON_CLASS}
          title={t("new")}
          aria-label={t("new")}
          onClick={() => openNewTask()}
        >
          <Plus className="size-3.5" aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(GIT_TOOLBAR_ICON_BUTTON_CLASS, "-mr-1")}
          title={tAux("openFullPage")}
          aria-label={tAux("openFullPage")}
          onClick={openBoard}
        >
          <SquareArrowOutUpRight className="size-3.5" aria-hidden />
        </Button>
      </div>

      {loading && tasks.length === 0 ? (
        <TasksAuxSkeleton />
      ) : !hasAnyTask ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <ListTodo
            className="size-8 text-muted-foreground/40"
            aria-hidden="true"
          />
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">{t("empty")}</p>
            <p className="text-xs text-muted-foreground">{t("emptyHint")}</p>
          </div>
          <Button
            type="button"
            size="sm"
            className="gap-1.5"
            onClick={() => openNewTask()}
          >
            <Plus className="size-3.5" aria-hidden="true" />
            {t("new")}
          </Button>
        </div>
      ) : shownSections.length === 0 ? (
        // Tasks exist, but none are left to show: a search narrowed them all
        // away, or every one is canceled / archived and the board hides those.
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-xs text-muted-foreground">
            {searching
              ? t("searchNoResults", { query: searchInput.trim() })
              : t("listEmpty")}
          </p>
          {searching ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => setSearchInput("")}
            >
              {t("clearSearch")}
            </Button>
          ) : null}
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-3 p-3">
            {shownSections.map((column) => {
              const sectionTasks = columns[column]
              // A search opens every section that has a match: a hit folded
              // away under "Done" reads as no hit at all.
              const open = searching || !collapsed.has(column)
              return (
                <section key={column} className="flex flex-col gap-2">
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => toggleSection(column)}
                    disabled={searching}
                    className="flex h-6 items-center gap-2 rounded-md px-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
                  >
                    <ChevronRight
                      className={cn(
                        "size-3.5 shrink-0 text-muted-foreground transition-transform",
                        open && "rotate-90"
                      )}
                      aria-hidden="true"
                    />
                    <span
                      className={cn(
                        "h-3.5 w-[3px] shrink-0 rounded-full",
                        SECTION_TONE[column]
                      )}
                      aria-hidden="true"
                    />
                    <span className="text-xs font-semibold">
                      {t(SECTION_LABEL_KEYS[column])}
                    </span>
                    <span
                      className={cn(
                        "rounded-full px-1.5 py-0.5 text-[0.625rem] leading-none tabular-nums",
                        column === "attention"
                          ? "bg-amber-500/15 font-semibold text-amber-600 dark:text-amber-400"
                          : "bg-muted/70 font-medium text-muted-foreground"
                      )}
                    >
                      {sectionTasks.length + conversationColumns[column].length}
                    </span>
                  </button>
                  {open ? (
                    <div className="flex flex-col gap-2">
                      {sectionTasks.map((task) => (
                        <TaskCard
                          key={task.id}
                          task={task}
                          folderName={folderNames.get(task.folder_id) ?? null}
                          now={now}
                          mergeQueueRank={queueRanks.get(task.id)}
                          onOpen={() => openDetail(task.id)}
                          {...handlersFor(task)}
                        />
                      ))}
                      {conversationColumns[column].map((conversation) => (
                        <ConversationBoardCard
                          key={`conversation-${conversation.id}`}
                          conversation={conversation}
                          folderName={
                            folderNames.get(conversation.folder_id) ?? null
                          }
                          now={now}
                          onOpen={() => openConversation(conversation)}
                        />
                      ))}
                    </div>
                  ) : null}
                </section>
              )
            })}
          </div>
        </ScrollArea>
      )}

      {dialogs}
    </div>
  )
}

/** First-paint placeholder: two section headers over ghost cards, on the real
 *  sections' insets. */
function TasksAuxSkeleton() {
  return (
    <div className="flex flex-col gap-3 p-3" aria-hidden>
      {[2, 1].map((cards, section) => (
        <div key={section} className="flex flex-col gap-2">
          <Skeleton className="h-4 w-24" />
          {Array.from({ length: cards }, (_, i) => (
            <Skeleton key={i} className="h-20 w-full rounded-xl" />
          ))}
        </div>
      ))}
    </div>
  )
}
