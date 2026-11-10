"use client"

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react"
import { ChevronLeft, Loader2, RotateCcw } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { formatConversationTitle } from "@/lib/conversation-title"
import {
  buildRemoteMentionUri,
  classifyRemoteMentionError,
  isPublicHttpBaseUrl,
  listRemoteMentionAgents,
  listRemoteMentionAssistants,
  listRemoteMentionFiles,
  listRemoteMentionFolders,
  listRemoteMentionSessions,
  probeRemoteMention,
  REMOTE_MENTION_MAX_ROWS,
  supportsRemoteRun,
  type RemoteAgentEntry,
  type RemoteAssistantEntry,
  type RemoteCapabilities,
  type RemoteFileList,
  type RemoteFolder,
  type RemoteMentionErrorKind,
  type RemoteMentionKind,
} from "@/lib/remote-mention"
import { listRemoteWorkspaceConnections } from "@/lib/remote-workspace"
import type {
  DbConversationSummary,
  RemoteWorkspaceConnection,
} from "@/lib/types"
import { cn } from "@/lib/utils"

import { ReferenceIcon } from "../badges/reference-badge"
import { remoteMentionReference } from "../reference-uri"
import type { ReferenceAttrs } from "../types"

/** 面板内的导航层级（设计 5.4）。 */
export type RemoteNavLevel = "connections" | "folders" | "kinds" | "items"

/** 资源类型层的顺序。 */
const KIND_ORDER: readonly RemoteMentionKind[] = [
  "file",
  "session",
  "assistant",
  "agent",
]

/** 一行可选项。 */
interface NavRow {
  /** `aria-activedescendant` / React key 用的稳定 id。 */
  id: string
  label: string
  detail?: string | null
  /** 不可选（离线连接、缺 run 能力的类型）。 */
  disabled?: boolean
  /** 行内状态说明，例如"离线""token 无效"。 */
  note?: string | null
  /** items 层：插入编辑器用的引用。 */
  reference?: ReferenceAttrs
  /** 其它层：下钻动作。 */
  onActivate?: () => void
}

type LoadState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; rows: T[]; truncated: boolean }
  | { status: "error"; kind: RemoteMentionErrorKind }

/** 连接能力探测结果。 */
type ProbeState =
  | { status: "loading" }
  | { status: "ok"; capabilities: RemoteCapabilities }
  | { status: "error"; kind: RemoteMentionErrorKind }

/**
 * 首次在 @ 面板使用公网明文连接时只提示一次（设计 4.1.1.3）。按连接 id 记在
 * localStorage 里；连接被删除后这条记录没有任何可见影响。
 */
const PUBLIC_HTTP_WARNED_KEY = "remote-mention:public-http-warned"

function readWarnedConnections(): number[] {
  if (typeof window === "undefined") return []
  try {
    const raw = window.localStorage.getItem(PUBLIC_HTTP_WARNED_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed)
      ? parsed.filter((id): id is number => typeof id === "number")
      : []
  } catch {
    return []
  }
}

function markConnectionWarned(id: number): void {
  if (typeof window === "undefined") return
  try {
    const warned = new Set(readWarnedConnections())
    warned.add(id)
    window.localStorage.setItem(
      PUBLIC_HTTP_WARNED_KEY,
      JSON.stringify([...warned])
    )
  } catch {
    /* localStorage 不可用时只是会重复提示，不影响功能 */
  }
}

export interface RemoteNavigatorHandle {
  /** 返回 true 表示按键已被面板消费。 */
  onKeyDown: (event: KeyboardEvent) => boolean
}

export interface RemoteNavigatorProps {
  /** 当前 `@` 查询串；各层用它做子串过滤。 */
  query: string
  /** 插入选中的远程引用。 */
  onSelect: (
    reference: ReferenceAttrs,
    range: { from: number; to: number }
  ) => void
  /** 关闭面板。 */
  onClose: () => void
  /** 把当前活动选项 id 报给宿主（→ 编辑器的 `aria-activedescendant`）。 */
  onActiveOptionChange?: (optionId: string | null) => void
  /** 插入时被替换的文档范围（`@` 触发符 + 查询串）。 */
  range: { from: number; to: number }
  /** listbox 的无障碍名称。 */
  listboxLabel: string
  /** listbox 的 DOM id，供宿主的 `aria-controls` 指向。 */
  listboxId: string
}

/**
 * `@` 面板的"远程"tab：连接 → 远程项目 → 资源类型 → 资源 的四层导航
 * （设计 4.1.2.1 / 5.4）。
 *
 * 状态只存在本组件内，面板关闭即随卸载重置。键盘：↑/↓ 移动，Enter/→ 进入，
 * 空查询下 ←/Backspace 返回上一层，Esc 关闭。每层 option id 为
 * `remote-<层>-<序号>`，`aria-activedescendant` 指向它。
 *
 * 数据全部经本机命令（`remote_mention_*`）读取，列表在 lib 层做 60 秒缓存；
 * 单次请求超过 8 秒按加载失败处理，可重试。
 */
export const RemoteNavigator = forwardRef<
  RemoteNavigatorHandle,
  RemoteNavigatorProps
>(function RemoteNavigator(
  {
    query,
    onSelect,
    onClose,
    onActiveOptionChange,
    range,
    listboxLabel,
    listboxId,
  },
  ref
) {
  const t = useTranslations("RemoteMention")
  const tRemoteWorkspace = useTranslations("RemoteWorkspace")

  const [level, setLevel] = useState<RemoteNavLevel>("connections")
  const [connection, setConnection] =
    useState<RemoteWorkspaceConnection | null>(null)
  const [folder, setFolder] = useState<RemoteFolder | null>(null)
  const [kind, setKind] = useState<RemoteMentionKind | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  /** 重试计数：变化即重新加载当前层。 */
  const [reloadToken, setReloadToken] = useState(0)

  // 连接列表（本机数据库）
  const [connections, setConnections] = useState<
    LoadState<RemoteWorkspaceConnection>
  >({ status: "loading" })
  // 每条连接的能力探测结果，按 id 累积
  const [probes, setProbes] = useState<Record<number, ProbeState>>({})
  // 远程项目
  const [folders, setFolders] = useState<LoadState<RemoteFolder>>({
    status: "idle",
  })
  // 资源层：已适配成行
  const [items, setItems] = useState<LoadState<NavRow>>({ status: "idle" })

  const connectionId = connection?.id ?? null
  const folderId = folder?.id ?? null
  const connectionName = connection?.name ?? null
  const folderPath = folder?.path ?? null

  const kindLabel = useCallback(
    (value: RemoteMentionKind): string => {
      switch (value) {
        case "file":
          return t("kindFile")
        case "session":
          return t("kindSession")
        case "assistant":
          return t("kindAssistant")
        case "agent":
          return t("kindAgent")
      }
    },
    [t]
  )

  // ── 连接列表 + 能力探测 ──────────────────────────────────────────────
  useEffect(() => {
    let active = true
    setConnections({ status: "loading" })
    // 连接列表复用本机既有 API（设计 4.1.2.1：连接列表在本机数据库）。
    listRemoteWorkspaceConnections()
      .then((list) => {
        if (!active) return
        setConnections({ status: "ready", rows: list, truncated: false })
        // 先出列表，能力探测到位后再更新行内状态与置灰。
        setProbes((prev) => {
          const next: Record<number, ProbeState> = { ...prev }
          for (const item of list) next[item.id] ??= { status: "loading" }
          return next
        })
        for (const item of list) {
          probeRemoteMention(item.id)
            .then((capabilities) => {
              if (!active) return
              setProbes((prev) => ({
                ...prev,
                [item.id]: { status: "ok", capabilities },
              }))
            })
            .catch((error: unknown) => {
              if (!active) return
              setProbes((prev) => ({
                ...prev,
                [item.id]: {
                  status: "error",
                  kind: classifyRemoteMentionError(error),
                },
              }))
            })
        }
      })
      .catch((error: unknown) => {
        if (!active) return
        setConnections({
          status: "error",
          kind: classifyRemoteMentionError(error),
        })
      })
    return () => {
      active = false
    }
  }, [reloadToken])

  // 首次使用公网明文连接时提示一次（设计 4.1.1.3）
  useEffect(() => {
    if (connections.status !== "ready") return
    const warned = new Set(readWarnedConnections())
    for (const item of connections.rows) {
      if (warned.has(item.id) || !isPublicHttpBaseUrl(item.base_url)) continue
      markConnectionWarned(item.id)
      toast.warning(tRemoteWorkspace("publicHttpWarning"), {
        description: item.name,
      })
    }
  }, [connections, tRemoteWorkspace])

  // ── 远程项目 ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (level !== "folders" || connectionId === null) return
    let active = true
    setFolders({ status: "loading" })
    listRemoteMentionFolders(connectionId)
      .then((list) => {
        if (!active) return
        setFolders({ status: "ready", rows: list, truncated: false })
      })
      .catch((error: unknown) => {
        if (!active) return
        setFolders({ status: "error", kind: classifyRemoteMentionError(error) })
      })
    return () => {
      active = false
    }
  }, [level, connectionId, reloadToken])

  // ── 资源层 ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (level !== "items" || connectionId === null || kind === null) return
    if (kind !== "session" && folderId === null) return
    let active = true
    setItems({ status: "loading" })
    const name = connectionName ?? `#${connectionId}`

    const toRows = (
      entries: { target: string; label: string; detail?: string | null }[]
    ): NavRow[] =>
      entries.map((entry, index) => {
        const target = {
          connectionId,
          kind,
          // 会话没有项目段；其余三类都带 folder 参数。
          folderId: kind === "session" ? null : folderId,
          target: entry.target,
        }
        return {
          id: `remote-items-${index}`,
          label: entry.label,
          detail: entry.detail ?? null,
          reference: remoteMentionReference(target, entry.label, {
            uri: buildRemoteMentionUri(target) ?? undefined,
            connectionName: name,
            folderPath: folderPath ?? undefined,
          }),
        }
      })

    const load = async (): Promise<{ rows: NavRow[]; truncated: boolean }> => {
      if (kind === "file") {
        const list: RemoteFileList = await listRemoteMentionFiles(
          connectionId,
          folderId as number
        )
        return {
          rows: toRows(
            list.entries
              .filter((entry) => entry.kind === "file")
              .map((entry) => ({
                target: entry.path,
                label: `${name}:${entry.path}`,
                detail: entry.name,
              }))
          ),
          truncated: list.truncated,
        }
      }
      if (kind === "session") {
        const list: DbConversationSummary[] = await listRemoteMentionSessions(
          connectionId,
          folderId as number
        )
        return {
          rows: toRows(
            list.map((session) => ({
              target: String(session.id),
              label: `${name}:${
                formatConversationTitle(session.title) || `#${session.id}`
              }`,
              detail: session.git_branch || session.status,
            }))
          ),
          truncated: false,
        }
      }
      if (kind === "assistant") {
        const list: RemoteAssistantEntry[] =
          await listRemoteMentionAssistants(connectionId)
        return {
          rows: toRows(
            list.map((assistant) => ({
              target: String(assistant.id),
              label: `${name}:@${assistant.name}`,
              detail: assistant.description ?? assistant.agent,
            }))
          ),
          truncated: false,
        }
      }
      const list: RemoteAgentEntry[] =
        await listRemoteMentionAgents(connectionId)
      // 只列出启用且已安装的智能体（设计 4.1.2.2）
      return {
        rows: toRows(
          list
            .filter((agent) => agent.enabled && agent.installed)
            .map((agent) => ({
              target: agent.slug,
              label: `${name}:@${agent.name || agent.slug}`,
              detail: agent.slug,
            }))
        ),
        truncated: false,
      }
    }

    load()
      .then(({ rows, truncated }) => {
        if (!active) return
        setItems({ status: "ready", rows, truncated })
      })
      .catch((error: unknown) => {
        if (!active) return
        setItems({ status: "error", kind: classifyRemoteMentionError(error) })
      })
    return () => {
      active = false
    }
  }, [
    level,
    kind,
    connectionId,
    folderId,
    connectionName,
    folderPath,
    reloadToken,
  ])

  // ── 各层可选行 ───────────────────────────────────────────────────────
  const runSupported = useMemo(() => {
    if (connectionId === null) return true
    const probe = probes[connectionId]
    // 还没探到结果时不禁用：探测失败只会让助手/智能体在点进去后报错，
    // 而错误信息由资源层自己的加载失败呈现。
    if (!probe || probe.status !== "ok") return true
    return supportsRemoteRun(probe.capabilities)
  }, [probes, connectionId])

  const q = query.trim().toLowerCase()
  const matches = useCallback(
    (label: string, detail?: string | null) =>
      !q ||
      label.toLowerCase().includes(q) ||
      (detail ?? "").toLowerCase().includes(q),
    [q]
  )

  const rows = useMemo<NavRow[]>(() => {
    if (level === "connections") {
      if (connections.status !== "ready") return []
      const list: NavRow[] = []
      for (const item of connections.rows) {
        if (!matches(item.name, item.base_url)) continue
        const probe = probes[item.id]
        const offline = probe?.status === "error" && probe.kind !== "token"
        const tokenInvalid = probe?.status === "error" && probe.kind === "token"
        list.push({
          id: `remote-connections-${item.id}`,
          label: item.name,
          detail: item.base_url,
          disabled: offline || tokenInvalid,
          note: offline
            ? t("offline")
            : tokenInvalid
              ? t("tokenInvalid")
              : probe?.status === "loading"
                ? t("probing")
                : null,
          onActivate: () => {
            setConnection(item)
            setFolder(null)
            setKind(null)
            setSelectedIndex(0)
            setLevel("folders")
          },
        })
      }
      return list
    }

    if (level === "folders") {
      if (folders.status !== "ready") return []
      return folders.rows
        .filter((item) => matches(item.alias || item.name, item.path))
        .map((item) => ({
          id: `remote-folders-${item.id}`,
          label: item.alias || item.name,
          detail: item.path,
          onActivate: () => {
            setFolder(item)
            setKind(null)
            setSelectedIndex(0)
            setLevel("kinds")
          },
        }))
    }

    if (level === "kinds") {
      return KIND_ORDER.map((item) => {
        // 远程没有 run 能力时，助手/智能体两类置灰（设计 4.1.2.1）
        const needsRun = item === "assistant" || item === "agent"
        const disabled = needsRun && !runSupported
        return {
          id: `remote-kinds-${item}`,
          label: kindLabel(item),
          detail: disabled ? t("runUnsupported") : null,
          disabled,
          onActivate: () => {
            setKind(item)
            setSelectedIndex(0)
            setLevel("items")
          },
        }
      }).filter((row) => matches(row.label, row.detail))
    }

    if (items.status !== "ready") return []
    return items.rows
      .filter((row) => matches(row.label, row.detail))
      .slice(0, REMOTE_MENTION_MAX_ROWS)
  }, [
    level,
    connections,
    folders,
    items,
    probes,
    runSupported,
    matches,
    kindLabel,
    t,
  ])

  /** 命中数超过展示上限（或后端已截断）时提示"请输入更精确的路径"。 */
  const truncated = useMemo(() => {
    if (level === "items" && items.status === "ready") {
      return (
        items.truncated ||
        items.rows.filter((row) => matches(row.label, row.detail)).length >
          REMOTE_MENTION_MAX_ROWS
      )
    }
    if (level === "folders" && folders.status === "ready") {
      return (
        folders.rows.filter((item) =>
          matches(item.alias || item.name, item.path)
        ).length > REMOTE_MENTION_MAX_ROWS
      )
    }
    return false
  }, [level, items, folders, matches])

  const selectable = useMemo(
    () =>
      rows
        .map((row, index) => ({ row, index }))
        .filter(({ row }) => !row.disabled),
    [rows]
  )

  // 行集合变化（换层、换查询、数据到达）后把选中项拉回第一行。
  const rowsKey = rows.map((row) => row.id).join("|")
  const previousRowsKey = useRef(rowsKey)
  useEffect(() => {
    if (previousRowsKey.current === rowsKey) return
    previousRowsKey.current = rowsKey
    setSelectedIndex(0)
  }, [rowsKey])

  const activeRow =
    rows[selectedIndex] && !rows[selectedIndex].disabled
      ? rows[selectedIndex]
      : (selectable[0]?.row ?? null)

  const activeRowId = activeRow?.id ?? null
  useEffect(() => {
    onActiveOptionChange?.(activeRowId)
  }, [activeRowId, onActiveOptionChange])

  const activate = useCallback(
    (row: NavRow | null) => {
      if (!row || row.disabled) return
      if (row.reference) {
        onSelect(row.reference, range)
        return
      }
      row.onActivate?.()
    },
    [onSelect, range]
  )

  const goBack = useCallback((): boolean => {
    if (level === "items") {
      setLevel("kinds")
      setKind(null)
      setSelectedIndex(0)
      return true
    }
    if (level === "kinds") {
      setLevel("folders")
      setFolder(null)
      setSelectedIndex(0)
      return true
    }
    if (level === "folders") {
      setLevel("connections")
      setConnection(null)
      setSelectedIndex(0)
      return true
    }
    return false
  }, [level])

  useImperativeHandle(
    ref,
    (): RemoteNavigatorHandle => ({
      onKeyDown: (event) => {
        switch (event.key) {
          case "ArrowDown": {
            if (selectable.length === 0) return false
            const at = selectable.findIndex(({ row }) => row === activeRow)
            const next = selectable[(at + 1) % selectable.length]
            setSelectedIndex(next.index)
            return true
          }
          case "ArrowUp": {
            if (selectable.length === 0) return false
            const at = selectable.findIndex(({ row }) => row === activeRow)
            const prev =
              selectable[(at - 1 + selectable.length) % selectable.length]
            setSelectedIndex(prev.index)
            return true
          }
          case "ArrowRight":
          case "Enter": {
            if (!activeRow) return false
            activate(activeRow)
            return true
          }
          case "ArrowLeft":
            return goBack()
          case "Backspace":
            if (query) return false
            return goBack()
          case "Escape":
            onClose()
            return true
          default:
            return false
        }
      },
    }),
    [selectable, activeRow, activate, goBack, onClose, query]
  )

  const loading =
    (level === "connections" && connections.status === "loading") ||
    (level === "folders" && folders.status === "loading") ||
    (level === "items" && items.status === "loading")

  const errorState: RemoteMentionErrorKind | null =
    level === "connections"
      ? connections.status === "error"
        ? connections.kind
        : null
      : level === "folders"
        ? folders.status === "error"
          ? folders.kind
          : null
        : level === "items" && items.status === "error"
          ? items.kind
          : null

  const errorText =
    errorState === "token"
      ? t("tokenInvalid")
      : errorState === "offline"
        ? t("offline")
        : errorState === "timeout"
          ? t("timeout")
          : errorState
            ? t("loadFailed")
            : null

  const breadcrumb = [
    connection?.name ?? null,
    folder ? folder.alias || folder.name : null,
    kind ? kindLabel(kind) : null,
  ].filter((part): part is string => Boolean(part))

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 面包屑：当前层级路径；返回上一层用 ← / 空查询 Backspace（设计 4.1.2.1）。 */}
      {breadcrumb.length > 0 && (
        <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1 text-xs text-muted-foreground">
          <button
            type="button"
            tabIndex={-1}
            aria-label={t("back")}
            title={t("back")}
            className="rounded p-0.5 hover:bg-accent/50"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => goBack()}
          >
            <ChevronLeft className="size-3.5" />
          </button>
          <span className="truncate">{breadcrumb.join(" / ")}</span>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {loading ? (
          <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            {t("loading")}
          </div>
        ) : errorText ? (
          <div className="space-y-2 px-2 py-3 text-sm text-muted-foreground">
            <div>{errorText}</div>
            <button
              type="button"
              tabIndex={-1}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setReloadToken((token) => token + 1)}
            >
              <RotateCcw className="size-3" />
              {t("retry")}
            </button>
          </div>
        ) : rows.length === 0 ? (
          <div className="px-2 py-3 text-sm text-muted-foreground">
            {level === "connections" && connections.status === "ready"
              ? t("noConnections")
              : t("empty")}
          </div>
        ) : null}
        {/* 始终渲染，宿主的 aria-controls 指向它；只装 option 子节点。 */}
        <div id={listboxId} role="listbox" aria-label={listboxLabel}>
          {!loading &&
            !errorText &&
            rows.map((row, index) => {
              const active = row === activeRow
              return (
                <button
                  key={row.id}
                  type="button"
                  id={row.id}
                  role="option"
                  aria-selected={active}
                  aria-disabled={row.disabled || undefined}
                  data-active={active}
                  disabled={row.disabled}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm",
                    active
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent/50",
                    row.disabled && "cursor-default opacity-50"
                  )}
                  onMouseDown={(event) => {
                    // 保持编辑器焦点；点击即下钻或插入。
                    event.preventDefault()
                    activate(row)
                  }}
                  onMouseEnter={() => {
                    if (!row.disabled) setSelectedIndex(index)
                  }}
                >
                  {row.reference ? (
                    <ReferenceIcon data={row.reference} variant="option" />
                  ) : null}
                  <span className="min-w-0 truncate" title={row.label}>
                    {row.label}
                  </span>
                  {(row.note || row.detail) && (
                    <span
                      className="min-w-0 grow basis-24 truncate text-xs text-muted-foreground"
                      title={row.note || row.detail || undefined}
                    >
                      {row.note || row.detail}
                    </span>
                  )}
                </button>
              )
            })}
        </div>
        {truncated && (
          <div
            aria-hidden
            className="px-2 py-1 text-xs italic text-muted-foreground"
          >
            {t("truncated")}
          </div>
        )}
      </div>
    </div>
  )
})
