"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import {
  Crosshair,
  Eye,
  Globe,
  ListChevronsDownUp,
  ListChevronsUpDown,
  LayoutTemplate,
  ListTodo,
  Map as MapIcon,
  Menu,
  MessagesSquare,
  MonitorCloud,
  MonitorSmartphone,
  Search,
  Settings,
  SquarePen,
  Zap,
  type LucideIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useSidebarContext } from "@/contexts/sidebar-context"
import { useTabActions } from "@/contexts/tab-context"
import { useAutomationsView } from "@/contexts/automations-view-context"
import { useTasksView } from "@/contexts/tasks-view-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useOptionalWorkspaceActions } from "@/contexts/workspace-context"
import { useRemoteWorkspaceConnections } from "@/hooks/use-remote-workspace-connections"
import {
  SidebarConversationList,
  type SidebarConversationListHandle,
} from "@/components/conversations/sidebar-conversation-list"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useIsMobile } from "@/hooks/use-mobile"
import { useIsMac } from "@/hooks/use-is-mac"
import { usePlatform } from "@/hooks/use-platform"
import { useZoomLevel } from "@/hooks/use-appearance"
import { useShortcutSettings } from "@/hooks/use-shortcut-settings"
import { BLANK_PAGE_URL } from "@/lib/browser/browser-url"
import { useBrowserCapabilities } from "@/lib/browser/use-browser-capabilities"
import { formatShortcutLabel } from "@/lib/keyboard-shortcuts"
import { isDesktop } from "@/lib/platform"
import { leftChromeReserve } from "@/lib/window-chrome"
import {
  isNavItemVisible,
  loadNavItemVisibility,
  loadTagFilter,
  saveTagFilter,
  loadShowCompleted,
  loadShowRecent,
  loadShowWorktrees,
  loadSortMode,
  loadSectionOrder,
  moveSectionInOrder,
  saveNavItemVisibility,
  saveShowCompleted,
  saveShowRecent,
  saveShowWorktrees,
  saveSortMode,
  saveSectionOrder,
  DEFAULT_SECTION_ORDER,
  SIDEBAR_NAV_ITEM_IDS,
  type SidebarNavItemId,
  type SidebarNavItemVisibility,
  type SidebarSectionId,
  type SidebarSortMode,
  type SidebarSectionOrder,
} from "@/lib/sidebar-view-mode-storage"
import { useCanvasBoardsStore } from "@/stores/canvas-boards-store"
import { useConversationTagsStore } from "@/stores/conversation-tags-store"
import {
  EMPTY_TAG_FILTER,
  pruneTagFilter,
  type TagFilter,
} from "@/lib/conversation-tags"
import {
  SidebarTagFilterBar,
  SidebarTagFilterButton,
} from "@/components/conversations/sidebar-tag-filter"
import { RemoteWorkspaceManageDialog } from "./remote-workspace-manage-dialog"
import { SidebarSectionOrderControl } from "./sidebar-section-order-control"
import { cn } from "@/lib/utils"

// Keyboard-shortcut hint at the trailing edge of the New chat row.
// Mirrors the folder count badge exactly — same chip (0.9375rem height,
// 0.3125rem radius, bg-primary/10, text-primary, 0.625rem text) per the request
// to match it. That pairing is also solidly legible (text-primary on
// primary/10 ≈ 14:1 light / 11:1 dark), unlike the muted-on-muted kbd it
// replaces (4.34:1). Revealed only on hover / keyboard focus of its row (each
// row is a `group`); font-mono renders the shortcut glyphs cleanly.
const SHORTCUT_BADGE_CLASS = cn(
  "ml-auto inline-flex h-[0.9375rem] shrink-0 items-center justify-center",
  "rounded-[0.3125rem] bg-primary/10 px-[0.25rem]",
  "font-mono text-[0.625rem] font-medium leading-none text-primary",
  "opacity-0 transition-opacity duration-150",
  "group-hover:opacity-100 group-focus-visible:opacity-100"
)

// 45px 图标主菜单栏里的角标：把未读 / 待办的计数缩成图标右上角的小圆片，
// 信息不丢（图标态的栏里放不下整条计数 chip）。两种色调沿用行内的语义：
// 失败 = destructive，待办 = primary。
const RAIL_BADGE_BASE_CLASS = cn(
  "pointer-events-none absolute -top-1 -right-1 inline-flex h-[0.8125rem]",
  "min-w-[0.8125rem] items-center justify-center rounded-full px-0.5",
  "font-mono text-[0.5625rem] font-medium leading-none"
)
const RAIL_BADGE_FAILURE_CLASS = cn(
  RAIL_BADGE_BASE_CLASS,
  "bg-destructive/15 text-destructive"
)
const RAIL_BADGE_ATTENTION_CLASS = cn(
  RAIL_BADGE_BASE_CLASS,
  "bg-primary/10 text-primary"
)

// 45px 图标栏按钮的共用几何。路由按钮与弹出菜单触发器必须长得一样，
// 否则「操作」和「导航」在视觉上会莫名其妙地错位。
const RAIL_BUTTON_CLASS = cn(
  "relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg outline-none",
  "text-muted-foreground transition-colors duration-150",
  "hover:bg-sidebar-accent hover:text-sidebar-foreground",
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
)

// Which sections the order editor should render as switched-off. Module
// constants rather than a per-render `new Set`, so the reference is stable and
// the two states are spelled out once. "Recent" is the only section with a
// visibility toggle today.
const NO_HIDDEN_SECTIONS: ReadonlySet<SidebarSectionId> = new Set()
const RECENT_HIDDEN: ReadonlySet<SidebarSectionId> = new Set(["recent"])

// Icon per optional nav row. The visibility checkboxes in the view-options menu
// carry the same glyph as the row they switch, so that group reads as a mirror
// of the nav block rather than three bare labels.
const NAV_ITEM_ICONS: Record<SidebarNavItemId, LucideIcon> = {
  automations: Zap,
  tasks: ListTodo,
  forge: LayoutTemplate,
  canvas: MapIcon,
}

/**
 * A fixed top-of-sidebar action row (today: New chat). `trailing` carries a
 * shortcut hint. Extracting this keeps the fixed action on one geometry instead
 * of copy-pasting the className. Each row is a `group` so the
 * `group-hover`-revealed trailing hint works.
 */
function SidebarNavButton({
  icon: Icon,
  label,
  onClick,
  trailing,
}: {
  icon: LucideIcon
  label: string
  onClick: () => void
  trailing?: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className={cn(
        "group flex h-8 w-full items-center gap-[0.4375rem] rounded-full pl-[0.4375rem] pr-1.5",
        "text-[0.875rem] text-sidebar-foreground outline-none",
        "transition-colors duration-150 hover:bg-sidebar-accent",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      )}
    >
      <Icon className="h-[0.875rem] w-[0.875rem] shrink-0 text-muted-foreground" />
      <span className="truncate">{label}</span>
      {trailing}
    </button>
  )
}

/**
 * 45px 图标主菜单栏里的一枚入口：只有图标，名字靠 tooltip（title）和
 * aria-label 给出（无障碍与测试都读后者）。命中当前路由时整枚按钮高亮。
 */
function SidebarRailButton({
  icon: Icon,
  label,
  onClick,
  active,
  badge,
  badgeClassName,
}: {
  icon: LucideIcon
  label: string
  onClick: () => void
  active?: boolean
  badge?: number
  badgeClassName?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={cn(
        RAIL_BUTTON_CLASS,
        active && "bg-sidebar-primary/15 text-sidebar-foreground"
      )}
    >
      <Icon aria-hidden="true" className="h-[1.125rem] w-[1.125rem]" />
      {badge != null && badge > 0 && (
        <span className={cn(RAIL_BADGE_BASE_CLASS, badgeClassName)}>
          {badge}
        </span>
      )}
    </button>
  )
}

export function Sidebar() {
  const t = useTranslations("Folder.sidebar")
  const { isOpen, toggle } = useSidebarContext()
  const { activeFolder } = useActiveFolder()
  const { openNewConversationTab, openChatModeTab } = useTabActions()
  const { unseenFailures } = useAutomationsView()
  const { attentionCount } = useTasksView()
  const { routeId, setRoute, openConversations } = useWorkbenchRoute()
  const workspaceActions = useOptionalWorkspaceActions()
  const browserCapabilities = useBrowserCapabilities()
  const {
    desktop: remoteDesktop,
    connections: remoteConnections,
    refresh: refreshRemote,
    open: handleOpenRemote,
  } = useRemoteWorkspaceConnections()
  const [remoteManageOpen, setRemoteManageOpen] = useState(false)
  const isMac = useIsMac()
  const { isMac: platformIsMac } = usePlatform()
  const { zoomLevel } = useZoomLevel()
  const { shortcuts } = useShortcutSettings()
  const isMobile = useIsMobile()
  const listRef = useRef<SidebarConversationListHandle>(null)
  // On desktop the header's top-left is owned by the fixed window-chrome overlay
  // (sidebar toggle + remote); reserve exactly its width so the view controls
  // and drag region clear it. The reserve scales with the app zoom to track the
  // rem-sized overlay buttons. Mobile has no overlay (the sidebar is a Drawer).
  const leftReserve = leftChromeReserve(platformIsMac && isDesktop(), zoomLevel)

  // `showCompleted` defaults OFF; `showWorktrees` and `showRecent` default ON
  // (the mount effect below reconciles a persisted override). Each initial
  // value matches its own default so the pre-hydration render doesn't flash as
  // the stored preference is applied.
  const [showCompleted, setShowCompleted] = useState(false)
  const [showWorktrees, setShowWorktrees] = useState(true)
  const [showRecent, setShowRecent] = useState(true)
  // Empty = every nav row shown, which is also the hydrated default — so the
  // pre-hydration render matches for a user who never hid one.
  const [navItems, setNavItems] = useState<SidebarNavItemVisibility>({})
  const [sortMode, setSortMode] = useState<SidebarSortMode>("created")
  const [sectionOrder, setSectionOrder] = useState<SidebarSectionOrder>(
    DEFAULT_SECTION_ORDER
  )
  const [allExpanded, setAllExpanded] = useState(true)
  // 会话标题搜索词：受控输入，即时过滤下面的列表（不落盘，关掉侧栏/重开就清空）。
  const [titleQuery, setTitleQuery] = useState("")
  // What the user picked, persisted as picked. The list gets it PRUNED to tags
  // that still exist (below) — but only once the tag list has loaded: matching
  // needs nothing but ids, so a persisted filter applies from the first paint
  // instead of flashing the whole list and then narrowing it.
  const [rawTagFilter, setRawTagFilter] = useState<TagFilter>(EMPTY_TAG_FILTER)
  const tagsById = useConversationTagsStore((s) => s.tagsById)
  const tagsHydrated = useConversationTagsStore((s) => s.hydrated)
  const tagFilter = useMemo(
    () =>
      tagsHydrated ? pruneTagFilter(rawTagFilter, tagsById) : rawTagFilter,
    [rawTagFilter, tagsById, tagsHydrated]
  )
  const newConversationShortcutLabel = formatShortcutLabel(
    shortcuts.new_conversation,
    isMac
  )
  // General umbrella name for the eye menu (list toggles + nav rows + sort +
  // section order). Kept generic so the accessible name / tooltip stays
  // accurate as the menu gains options.
  const viewOptionsLabel = t("viewOptions")
  const toggleExpandLabel = allExpanded
    ? t("collapseAllGroups")
    : t("expandAllGroups")
  const hiddenSections = showRecent ? NO_HIDDEN_SECTIONS : RECENT_HIDDEN

  useEffect(() => {
    // Hydrate from localStorage after mount to keep SSR/CSR markup consistent.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShowCompleted(loadShowCompleted())
    setShowWorktrees(loadShowWorktrees())
    setShowRecent(loadShowRecent())
    setNavItems(loadNavItemVisibility())
    setSortMode(loadSortMode())
    setSectionOrder(loadSectionOrder())
    setRawTagFilter(loadTagFilter())
  }, [])

  const handleSetTagFilter = useCallback((next: TagFilter) => {
    setRawTagFilter(next)
    saveTagFilter(next)
  }, [])

  const handleSetShowCompleted = useCallback((value: boolean) => {
    setShowCompleted(value)
    saveShowCompleted(value)
  }, [])

  const handleSetShowWorktrees = useCallback((value: boolean) => {
    setShowWorktrees(value)
    saveShowWorktrees(value)
  }, [])

  const handleSetShowRecent = useCallback((value: boolean) => {
    setShowRecent(value)
    saveShowRecent(value)
  }, [])

  const handleSetNavItem = useCallback(
    (id: SidebarNavItemId, visible: boolean) => {
      setNavItems((prev) => {
        const next = { ...prev, [id]: visible }
        saveNavItemVisibility(next)
        return next
      })
    },
    []
  )

  const handleSetSortMode = useCallback((value: string) => {
    const mode: SidebarSortMode = value === "updated" ? "updated" : "created"
    setSortMode(mode)
    saveSortMode(mode)
  }, [])

  // Nudge one section up/down a slot. `moveSectionInOrder` returns the SAME
  // array when the move would fall off an end, so a clamped nudge neither
  // re-renders the list nor rewrites localStorage.
  const handleMoveSection = useCallback(
    (id: SidebarSectionId, delta: number) => {
      setSectionOrder((prev) => {
        const next = moveSectionInOrder(prev, id, delta)
        if (next !== prev) saveSectionOrder(next)
        return next
      })
    },
    []
  )

  const handleToggleExpandAll = useCallback(() => {
    if (allExpanded) {
      listRef.current?.collapseAll()
      setAllExpanded(false)
    } else {
      listRef.current?.expandAll()
      setAllExpanded(true)
    }
  }, [allExpanded])

  // 浏览器标签住在文件列里；其他 workbench 路由会把那一列整个替换掉，
  // 所以先回到会话工作区，保证宿主存在后再开空白页。
  const handleOpenBrowser = useCallback(() => {
    const openBrowserTab = workspaceActions?.openBrowserTab
    if (!openBrowserTab) return
    openConversations()
    openBrowserTab(BLANK_PAGE_URL)
  }, [openConversations, workspaceActions])

  const handleNewConversation = useCallback(() => {
    // On mobile the sidebar is a Drawer overlay — close it so the new
    // conversation is visible (mirrors tapping a conversation card, which the
    // list wrapper already closes on).
    if (isMobile) toggle()
    // Starting a conversation always returns to the conversation workspace (in
    // case a route like Automations was taking over the content region).
    openConversations()
    // Defense-in-depth: with no active folder (e.g. a cold start that recovered
    // to nothing, or all folders closed) fall back to folderless chat mode
    // rather than no-op, so this entry point is never a dead end.
    if (!activeFolder) {
      openChatModeTab()
      return
    }
    openNewConversationTab(activeFolder.id, activeFolder.path)
  }, [
    activeFolder,
    openChatModeTab,
    openNewConversationTab,
    openConversations,
    isMobile,
    toggle,
  ])

  if (!isOpen) return null

  return (
    <aside className="@container/sidebar flex h-full min-h-0 flex-col overflow-hidden text-sidebar-foreground select-none">
      <div
        className={cn(
          "flex h-10 shrink-0 items-center gap-2 pr-2",
          // Desktop: the fixed left window-chrome overlay (reserved below) owns
          // the top-left, so drop the header's own left padding. Off-image the
          // divider is border-border/50, matching the conversation / file detail
          // headers. But the sidebar sits on a FROSTED surface (ws-surface-sidebar)
          // while those headers sit on the transparent canvas: with a workspace
          // background image on, a border-border/50 hairline washes out against the
          // frosted shade, so it takes the boosted `ws-chrome-border` (like the
          // frosted status bar) to stay legible. Mobile (Drawer): keep the original
          // title padding + a full-strength divider — mobile is unchanged.
          isMobile
            ? "border-b border-border pl-4"
            : "border-b border-border/50 ws-chrome-border pl-0"
        )}
      >
        {isMobile ? (
          <div className="flex min-w-0 items-center gap-4">
            <h2 className="truncate text-[0.875rem] font-bold tracking-[-0.00625rem] text-sidebar-foreground">
              {t("title")}
            </h2>
          </div>
        ) : (
          // Reserve exactly the fixed left overlay's width so the view controls
          // clear it; the empty reserved space is a window-drag region.
          <div
            data-tauri-drag-region
            className="h-full shrink-0"
            style={{ width: leftReserve }}
          />
        )}
        {/* Draggable filler between the two clusters — the header is the
            window's top edge, so its empty space must move the window. */}
        <div data-tauri-drag-region className="h-full min-w-0 flex-1" />
        <div className="flex items-center gap-0.5">
          {/* Narrow the list to conversations carrying chosen tags. A funnel,
              unlike the view-options eye: this one filters. */}
          <SidebarTagFilterButton
            filter={tagFilter}
            onChange={handleSetTagFilter}
          />
          {/* Locate the active conversation in the list below (moved here from
              the conversation detail header). Always shown, leading the header
              cluster. The sidebar is unmounted while collapsed, so `listRef` is
              live whenever this button is visible. */}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0 text-muted-foreground"
            onClick={() => listRef.current?.scrollToActive()}
            title={t("locateActiveConversation")}
            aria-label={t("locateActiveConversation")}
          >
            <Crosshair aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
          {/* Expand/collapse-all is an icon-only header button on every
              viewport (it used to be a labelled row inside the view-options
              menu on desktop): it acts on the list right now instead of storing
              a display preference, so it does not belong among that menu's
              settings rows — and it took two clicks there. The icon itself
              states the direction, hence label-free with a tooltip. */}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0 text-muted-foreground"
            onClick={handleToggleExpandAll}
            title={toggleExpandLabel}
            aria-label={toggleExpandLabel}
          >
            {allExpanded ? (
              <ListChevronsDownUp aria-hidden="true" className="h-3.5 w-3.5" />
            ) : (
              <ListChevronsUpDown aria-hidden="true" className="h-3.5 w-3.5" />
            )}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0 text-muted-foreground"
                title={viewOptionsLabel}
                aria-label={viewOptionsLabel}
              >
                {/* An eye, not a funnel: nothing in this menu filters the list
                    down to matches — every option decides what is shown and in
                    what order. */}
                <Eye aria-hidden="true" className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            {/* Wider than the shared `min-w-48`: the section-order rows carry a
                position chip and two move buttons beside the name, and the menu
                clips overflow-x — 48 would start truncating longer localized
                section names. */}
            <DropdownMenuContent align="end" className="min-w-56">
              {/* Four groups: what the list shows → which nav rows exist → how
                  the list is sorted → how its sections are stacked. The first
                  two are hover-opened submenus rather than inline blocks: they
                  are set-and-forget on/off inventories, six checkboxes between
                  them, and inlining all six left a fifteen-row menu with Sort
                  by / Section order — the two settings people actually come
                  back for — stranded at the bottom of it. Those two stay
                  inline: a pair of radios and a ranked list read wrong behind
                  another hop, and the order rows need this menu's width.
                  Every option keeps the menu open on select (the default is to
                  close): this menu is a settings panel, not a command list, and
                  flipping two of them used to cost two round trips through the
                  trigger. The one action it used to carry — expand/collapse
                  all — is now a header button of its own. */}
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <MessagesSquare className="text-muted-foreground" />
                  {t("listOptions")}
                </DropdownMenuSubTrigger>
                {/* No width override: unlike the root content — held at exactly
                    `min-w-56` and clipping overflow-x — the sub-content grows to
                    fit its rows, which is the headroom these three (the longest
                    labels in the menu) want. */}
                <DropdownMenuSubContent>
                  <DropdownMenuCheckboxItem
                    checked={showCompleted}
                    onCheckedChange={handleSetShowCompleted}
                    onSelect={(event) => event.preventDefault()}
                  >
                    {t("showCompleted")}
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={showWorktrees}
                    onCheckedChange={handleSetShowWorktrees}
                    onSelect={(event) => event.preventDefault()}
                  >
                    {t("showWorktrees")}
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={showRecent}
                    onCheckedChange={handleSetShowRecent}
                    onSelect={(event) => event.preventDefault()}
                  >
                    {t("showRecent")}
                  </DropdownMenuCheckboxItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Menu className="text-muted-foreground" />
                  {t("navigationItems")}
                </DropdownMenuSubTrigger>
                {/* Driven by the id list itself, so a route added there can
                    never ship a row without its toggle. Each id doubles as its
                    message key. Hiding one only drops the sidebar shortcut: the
                    status bar's quick-actions menu still reaches every route, so
                    no choice here can strand the user on a page. */}
                <DropdownMenuSubContent>
                  {SIDEBAR_NAV_ITEM_IDS.map((id) => {
                    const Icon = NAV_ITEM_ICONS[id]
                    return (
                      <DropdownMenuCheckboxItem
                        key={id}
                        checked={isNavItemVisible(navItems, id)}
                        onCheckedChange={(value) => handleSetNavItem(id, value)}
                        onSelect={(event) => event.preventDefault()}
                      >
                        <Icon className="text-muted-foreground" />
                        {t(id)}
                      </DropdownMenuCheckboxItem>
                    )
                  })}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{t("sortBy")}</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={sortMode}
                onValueChange={handleSetSortMode}
              >
                <DropdownMenuRadioItem
                  value="created"
                  onSelect={(event) => event.preventDefault()}
                >
                  {t("sortByCreatedAt")}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem
                  value="updated"
                  onSelect={(event) => event.preventDefault()}
                >
                  {t("sortByUpdatedAt")}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{t("sectionOrder")}</DropdownMenuLabel>
              <SidebarSectionOrderControl
                order={sectionOrder}
                onMove={handleMoveSection}
                hiddenSections={hiddenSections}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* 顶栏以下左右分栏：左侧是 45px 图标主菜单栏（仅桌面），右侧是二级
          菜单（New chat + 搜索 + 会话列表）。图标栏放在顶栏
          **下方**而不是整个 aside 的最左边：桌面端的 window-chrome 覆盖层
          固定在窗口 top-0、高 h-10（macOS 红绿灯 + 切换/搜索按钮），
          只要图标栏从顶栏下方开始，它就永远落在覆盖层之外，
          `leftReserve` 的预留也照旧作用于整条顶栏，不必改。 */}
      <div className="flex min-h-0 flex-1">
        {!isMobile && (
          // 45px 定宽：只放图标，横向空间全部让给右侧的会话列表。用
          // `bg-sidebar-accent/40` + 右边框与右侧的二级菜单拉开层次。
          // 每一项都可以从视图菜单的「导航项」组里关掉；关掉后仍能从状态栏
          // 的快捷动作菜单进入该路由，不会成为死路。
          <nav
            aria-label={t("navigationItems")}
            className={cn(
              "flex w-[45px] shrink-0 flex-col items-center gap-1",
              "border-r border-sidebar-border bg-sidebar-accent/40 pt-1.5 pb-2"
            )}
          >
            {isNavItemVisible(navItems, "automations") && (
              <SidebarRailButton
                icon={Zap}
                label={t("automations")}
                active={routeId === "automations"}
                onClick={() => setRoute("automations")}
                badge={unseenFailures}
                badgeClassName={RAIL_BADGE_FAILURE_CLASS}
              />
            )}
            {isNavItemVisible(navItems, "tasks") && (
              <SidebarRailButton
                icon={ListTodo}
                label={t("tasks")}
                active={routeId === "tasks"}
                onClick={() => setRoute("tasks")}
                // Attention（待办）不是失败：跟快捷提示一样用 primary 色。
                badge={attentionCount}
                badgeClassName={RAIL_BADGE_ATTENTION_CLASS}
              />
            )}
            {isNavItemVisible(navItems, "forge") && (
              <SidebarRailButton
                icon={LayoutTemplate}
                label={t("forge")}
                active={routeId === "forge"}
                onClick={() => setRoute("forge")}
              />
            )}
            {isNavItemVisible(navItems, "canvas") && (
              <SidebarRailButton
                icon={MapIcon}
                label={t("canvas")}
                active={routeId === "canvas"}
                onClick={() => {
                  // Coming from elsewhere returns to the canvas that was open;
                  // clicking it again from inside one goes up to the list — the
                  // route's own home, like re-tapping an active tab.
                  if (routeId === "canvas") {
                    useCanvasBoardsStore.getState().closeBoard()
                  }
                  setRoute("canvas")
                }}
              />
            )}
            {remoteDesktop && (
              <>
                <div
                  aria-hidden="true"
                  className="my-1 h-px w-5 shrink-0 bg-sidebar-border"
                />
                <DropdownMenu
                  onOpenChange={(open) => {
                    if (open) void refreshRemote()
                  }}
                >
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      title={t("openRemoteWorkspace")}
                      aria-label={t("openRemoteWorkspace")}
                      className={cn(
                        RAIL_BUTTON_CLASS,
                        "data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-foreground"
                      )}
                    >
                      <MonitorSmartphone
                        aria-hidden="true"
                        className="h-[1.125rem] w-[1.125rem]"
                      />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    side="right"
                    align="start"
                    className="w-72"
                  >
                    {remoteConnections.length === 0 ? (
                      <div className="px-3 py-2 text-sm text-muted-foreground">
                        {t("noRemoteConnections")}
                      </div>
                    ) : (
                      remoteConnections.map((connection) => (
                        <DropdownMenuItem
                          key={connection.id}
                          onSelect={() => handleOpenRemote(connection.id)}
                        >
                          <MonitorCloud />
                          <span className="min-w-0">
                            <span className="block truncate">
                              {connection.name}
                            </span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {connection.base_url}
                            </span>
                          </span>
                        </DropdownMenuItem>
                      ))
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={() => setRemoteManageOpen(true)}
                    >
                      <Settings />
                      {t("manageRemoteWorkspace")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                {browserCapabilities?.available &&
                  workspaceActions?.openBrowserTab && (
                    <SidebarRailButton
                      icon={Globe}
                      label={t("openBrowser")}
                      onClick={handleOpenBrowser}
                    />
                  )}
              </>
            )}
          </nav>
        )}

        {/* 二级菜单：图标栏右侧的那一列。手机（Drawer）里图标栏不渲染，
            这里就是原来的整列。 */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Fixed actions above the scrollable list. `shrink-0` keeps them pinned —
              they never scroll with the conversation list. Rows are `rounded-full`
              like the conversation pills, and the icon/text geometry matches the
              folder header: a 0.875rem icon + 0.875rem label at a 0.4375rem gap, with
              the row's pl-[0.4375rem] (atop the container's px-1.5) placing the icon
              center on the same 0.875rem rail axis as the folder/conversation icons in
              the list below. Each row is a `group` so its shortcut hint reveals on
              hover / keyboard focus. */}
          <div className="flex shrink-0 flex-col gap-0.5 px-1.5 pt-1.5">
            <SidebarNavButton
              icon={SquarePen}
              label={t("newChat")}
              onClick={handleNewConversation}
              trailing={
                newConversationShortcutLabel ? (
                  <kbd className={SHORTCUT_BADGE_CLASS}>
                    {newConversationShortcutLabel}
                  </kbd>
                ) : null
              }
            />
          </div>

          {/* 会话标题搜索：只管下面的列表（不区分大小写的子串匹配），与窗口
              顶栏里那个始终存在的全局搜索（⌘K）不是同一个东西 —— 那个从
              `LeftEdgeChrome` / 手机端 `FolderTitleBar` 进。 */}
          <div className="relative shrink-0 px-1.5 pt-1.5">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={titleQuery}
              onChange={(event) => setTitleQuery(event.target.value)}
              // 输入即时过滤，不需要回车；Esc 清空恢复全部。
              onKeyDown={(event) => {
                if (event.key === "Escape") setTitleQuery("")
              }}
              placeholder={t("searchPlaceholder")}
              aria-label={t("search")}
              className="h-8 rounded-full pr-2.5 pl-7"
            />
          </div>

          {/* On mobile, clicking a conversation card auto-closes the Drawer */}
          <div
            className="flex flex-col flex-1 min-h-0 overflow-hidden pt-1.5"
            onClick={
              isMobile
                ? (e) => {
                    const target = e.target as HTMLElement
                    if (target.closest("[data-conversation-id]")) {
                      toggle()
                    }
                  }
                : undefined
            }
          >
            <SidebarTagFilterBar
              filter={tagFilter}
              onChange={handleSetTagFilter}
            />
            <SidebarConversationList
              ref={listRef}
              showCompleted={showCompleted}
              showWorktrees={showWorktrees}
              showRecent={showRecent}
              sortMode={sortMode}
              sectionOrder={sectionOrder}
              tagFilter={tagFilter}
              titleQuery={titleQuery}
            />
          </div>
        </div>
      </div>

      {remoteDesktop && (
        <RemoteWorkspaceManageDialog
          open={remoteManageOpen}
          onOpenChange={setRemoteManageOpen}
          onChanged={refreshRemote}
        />
      )}
    </aside>
  )
}
