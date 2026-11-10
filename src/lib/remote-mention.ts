"use client"

/**
 * 跨机 @ 引用（Remote Mention）的前端公共层：引用 URI 语法、远程网关调用、
 * 列表缓存和公网明文判定。
 *
 * 设计依据：`docs/superpowers/specs/2026-11-11-remote-mention-详细设计说明书.md`
 * 的 4.1.2（面板与徽标）、5.2（URI 语法）、4.1.1.3（明文风险）和第 7 章接口。
 *
 * 这里的命令一律经 `getShellTransport()` 调用，保证请求落在本机窗口，不会被
 * 远程桌面窗口的传输代理出去（设计 5.5）。后端命令（`remote_mention_*`）由
 * 网关层提供，本模块只按已定契约调用。
 */

import { useEffect, useSyncExternalStore } from "react"

import { listRemoteWorkspaceConnections } from "@/lib/remote-workspace"
import { getShellTransport } from "@/lib/transport"
import type {
  DbConversationSummary,
  RemoteWorkspaceConnection,
} from "@/lib/types"

/** 远程引用的四类资源，与 URI 里的路径段一一对应。 */
export type RemoteMentionKind = "file" | "session" | "assistant" | "agent"

export const REMOTE_MENTION_KINDS: readonly RemoteMentionKind[] = [
  "file",
  "session",
  "assistant",
  "agent",
]

/**
 * 与后端一致的解析正则（设计 5.2）：连接 id 是正整数，资源类型是固定的四个
 * 单词，其余部分（`(.+)`）由各类型自己的语法再拆。刻意不加 `i`：大写形式的
 * 类型段不匹配，解析失败后按普通链接处理，避免"解析成功但重建出另一个 URI"。
 */
const REMOTE_URI =
  /^codeg:\/\/remote\/([1-9]\d{0,9})\/(file|session|assistant|agent)\/(.+)$/

/** 正整数 id 的字面形式：不补零、不超过 10 位。 */
const POSITIVE_INT = /^[1-9]\d{0,9}$/

/** 一次远程引用的解析结果。 */
export interface RemoteMentionTarget {
  /** 本机 `remote_workspace_connection.id`。 */
  connectionId: number
  kind: RemoteMentionKind
  /**
   * 远程 `folder.id`：`file` 用它定位项目根目录，`assistant` / `agent` 用它
   * 告诉委派在哪个远程目录运行。`session` 没有项目段，为 null。
   */
  folderId: number | null
  /**
   * 资源身份：`file` 是项目内相对路径（未编码的原始路径），`session` 是远程
   * 会话 id 的字符串，`assistant` 是远程助手 id 的字符串，`agent` 是智能体
   * slug。
   */
  target: string
}

function toPositiveInt(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 2_147_483_647) {
    return null
  }
  return parsed
}

/** 字符串形式的正整数 id（不补零），非法时返回 null。 */
function toPositiveIntString(value: string): number | null {
  return POSITIVE_INT.test(value) ? toPositiveInt(value) : null
}

/**
 * 把项目内相对路径按段编码：`a/b c.ts` → `a/b%20c.ts`。
 *
 * 逐段编码（而不是整体 `encodeURIComponent`）是为了保留段之间的 `/`，同时让
 * 段内的 `/`、`?`、`#`、空格等都被转义，解析回来仍是同一段路径。空段（前导或
 * 重复的 `/`）视为非法：远程路径始终是项目内相对路径。
 */
function validRemoteSegment(segment: string): boolean {
  return Boolean(segment) && !/[\u0000-\u001f\u007f/\\]/.test(segment)
}

function validFileSegment(segment: string): boolean {
  return (
    validRemoteSegment(segment) &&
    segment !== "." &&
    segment !== ".." &&
    !segment.includes(":")
  )
}

function encodeRelativePath(path: string): string | null {
  const segments = path.split("/")
  if (segments.length === 0) return null
  const encoded: string[] = []
  for (const segment of segments) {
    if (!validFileSegment(segment)) return null
    encoded.push(encodeURIComponent(segment))
  }
  return encoded.join("/")
}

/** `encodeRelativePath` 的逆操作；任一段解码失败即整条路径非法。 */
function decodeRelativePath(path: string): string | null {
  const segments = path.split("/")
  const decoded: string[] = []
  for (const segment of segments) {
    if (!segment) return null
    try {
      const value = decodeURIComponent(segment)
      if (!validFileSegment(value)) return null
      decoded.push(value)
    } catch {
      return null
    }
  }
  return decoded.join("/")
}

/**
 * 按设计 5.2 的语法拼出一条远程引用 URI，参数非法时返回 null。
 *
 * 四种形态：
 * - `codeg://remote/<c>/file/<folderId>/<相对路径，逐段编码>`
 * - `codeg://remote/<c>/session/<remoteConversationId>`
 * - `codeg://remote/<c>/assistant/<remoteAssistantId>?folder=<folderId>`
 * - `codeg://remote/<c>/agent/<slug，编码>?folder=<folderId>`
 *
 * 拼出的字符串再经 {@link parseRemoteMentionUri} 解析、重建后必须逐字节相同
 * （往返不丢 URI），这是徽标、草稿还原和会话记录共用的身份依据。
 */
export function buildRemoteMentionUri(
  target: Omit<RemoteMentionTarget, "folderId"> & { folderId?: number | null }
): string | null {
  const connectionId = toPositiveInt(target.connectionId)
  if (connectionId === null) return null
  const base = `codeg://remote/${connectionId}`
  const folderId = toPositiveInt(target.folderId)
  switch (target.kind) {
    case "file": {
      if (folderId === null) return null
      const path = encodeRelativePath(target.target)
      if (path === null) return null
      return `${base}/file/${folderId}/${path}`
    }
    case "session": {
      const id = toPositiveIntString(target.target)
      return id === null ? null : `${base}/session/${id}`
    }
    case "assistant": {
      if (folderId === null) return null
      const id = toPositiveIntString(target.target)
      return id === null ? null : `${base}/assistant/${id}?folder=${folderId}`
    }
    case "agent": {
      if (folderId === null) return null
      const slug = target.target
      if (!validRemoteSegment(slug)) return null
      return `${base}/agent/${encodeURIComponent(slug)}?folder=${folderId}`
    }
  }
}

/**
 * 解析一条远程引用 URI，非本语法（或任一段非法）返回 null。
 *
 * 严格校验正整数 id：`folder=0`、`session/007`、越界位数都判非法，避免把
 * 畸形链接当成远程引用插入徽标。
 */
export function parseRemoteMentionUri(uri: string): RemoteMentionTarget | null {
  const match = REMOTE_URI.exec(uri)
  if (!match || /[#\s]/.test(uri)) return null
  const connectionId = toPositiveIntString(match[1])
  if (connectionId === null) return null
  const kind = match[2] as RemoteMentionKind
  let rest = match[3]

  // 查询串只出现在 assistant / agent 形态里，承载 `folder`。文件路径中的 `?`
  // 已被逐段编码成 `%3F`，不会在这里被误切。
  let folderParam: number | null = null
  const queryAt = rest.indexOf("?")
  if (queryAt >= 0) {
    if (kind !== "assistant" && kind !== "agent") return null
    const query = rest.slice(queryAt + 1)
    rest = rest.slice(0, queryAt)
    const raw = /^folder=([1-9]\d{0,9})$/.exec(query)?.[1]
    if (!raw) return null
    folderParam = toPositiveIntString(raw)
    if (folderParam === null) return null
  }

  switch (kind) {
    case "file": {
      const slash = rest.indexOf("/")
      if (slash <= 0) return null
      const folderId = toPositiveIntString(rest.slice(0, slash))
      if (folderId === null) return null
      const path = decodeRelativePath(rest.slice(slash + 1))
      if (path === null) return null
      return { connectionId, kind, folderId, target: path }
    }
    case "session": {
      const id = toPositiveIntString(rest)
      return id === null
        ? null
        : { connectionId, kind, folderId: null, target: String(id) }
    }
    case "assistant": {
      const id = toPositiveIntString(rest)
      if (id === null || folderParam === null) return null
      return { connectionId, kind, folderId: folderParam, target: String(id) }
    }
    case "agent": {
      let slug: string
      try {
        slug = decodeURIComponent(rest)
      } catch {
        return null
      }
      if (!validRemoteSegment(slug) || folderParam === null) return null
      return { connectionId, kind, folderId: folderParam, target: slug }
    }
  }
}

// ── 远程网关调用 ──────────────────────────────────────────────────────────
//
// 命令名与参数形状来自设计 7.4；响应体按第 7.1 节各路由的实际序列化分别定义
// （`FolderDetail` / `DbConversationSummary` 是 snake_case，其余是 camelCase）。

/** 能力探测结果（`remote_mention_probe`）。 */
export interface RemoteCapabilities {
  runtime: string
  version: string
  apiVersion: number
  capabilities: string[]
}

/** 远程项目（远程 `list_all_folder_details` 的投影）。 */
export interface RemoteFolder {
  id: number
  name: string
  path: string
  alias: string | null
}

/** 远程文件条目（项目内相对路径）。 */
export interface RemoteFileEntry {
  name: string
  path: string
  kind: string
}

export interface RemoteFileList {
  entries: RemoteFileEntry[]
  truncated: boolean
}

/** 远程助手（远程 `cli_assistants`）。 */
export interface RemoteAssistantEntry {
  id: number
  name: string
  agent: string
  description: string | null
}

/** 远程智能体（远程 `cli_agents`）。 */
export interface RemoteAgentEntry {
  slug: string
  name: string
  enabled: boolean
  installed: boolean
  installHint?: string | null
}

/** 前端命令名，集中在常量里便于测试断言与后端对表。 */
export const REMOTE_MENTION_COMMANDS = {
  probe: "remote_mention_probe",
  listFolders: "remote_mention_list_folders",
  listFiles: "remote_mention_list_files",
  listSessions: "remote_mention_list_sessions",
  listAssistants: "remote_mention_list_assistants",
  listAgents: "remote_mention_list_agents",
} as const

/** 单次远程调用的等待上限：超过即视为加载失败，面板给出重试。 */
export const REMOTE_MENTION_TIMEOUT_MS = 8_000

/** 文件列表的缓存上限（设计 4.1.2.2）。 */
export const REMOTE_MENTION_MAX_FILES = 20_000

/** 每个列表层的展示上限（设计 4.1.2.2：最多显示 50 条）。 */
export const REMOTE_MENTION_MAX_ROWS = 50

/** 连接 + 项目列表的内存缓存时长（设计 4.1.2.2：60 秒）。 */
export const REMOTE_MENTION_CACHE_TTL_MS = 60_000

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("remote_mention_timeout"))
    }, REMOTE_MENTION_TIMEOUT_MS)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/**
 * 远程引用列表的失败分类：面板据此显示"离线""token 无效""加载超时"等提示。
 * 后端把 401 归一成 `authentication_failed`，网络/超时归到 offline/timeout。
 */
export type RemoteMentionErrorKind = "offline" | "token" | "timeout" | "unknown"

export function classifyRemoteMentionError(
  error: unknown
): RemoteMentionErrorKind {
  const message = (
    error instanceof Error ? error.message : String(error ?? "")
  ).toLowerCase()
  if (!message) return "unknown"
  if (
    message.includes("remote_mention_timeout") ||
    message.includes("timeout")
  ) {
    return "timeout"
  }
  if (
    message.includes("authentication_failed") ||
    message.includes("unauthorized") ||
    message.includes("401") ||
    message.includes("token")
  ) {
    return "token"
  }
  if (
    message.includes("network_error") ||
    message.includes("failed to fetch") ||
    message.includes("connection refused") ||
    message.includes("econnrefused") ||
    message.includes("dns") ||
    message.includes("offline")
  ) {
    return "offline"
  }
  return "unknown"
}

/** 远程能力里是否带 `run`：没有它就只能引用文件/会话，助手与智能体置灰。 */
export function supportsRemoteRun(
  capabilities: RemoteCapabilities | null | undefined
): boolean {
  return (capabilities?.capabilities ?? []).includes("run")
}

// ── 缓存 ──────────────────────────────────────────────────────────────────
//
// 远程项目/文件/会话/助手/智能体列表都是实时查询加内存缓存，不落库（设计
// 9.3.1）：远程数据随时变化，落库只会产生过期副本。键是连接 + 项目，60 秒。

interface CacheEntry<T> {
  at: number
  value: T
}

const cache = new Map<string, CacheEntry<unknown>>()

function cacheKey(command: string, ids: (number | string | null)[]): string {
  return `${command}:${ids.map((id) => id ?? "-").join(":")}`
}

function readCache<T>(key: string, now: number): T | null {
  const entry = cache.get(key)
  if (!entry) return null
  if (now - entry.at > REMOTE_MENTION_CACHE_TTL_MS) {
    cache.delete(key)
    return null
  }
  return entry.value as T
}

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const now = Date.now()
  const hit = readCache<T>(key, now)
  if (hit !== null) return hit
  const value = await load()
  cache.set(key, { at: Date.now(), value })
  return value
}

/** 清空缓存：测试隔离，以及窗口重新获得焦点时刷新。 */
export function clearRemoteMentionCache(): void {
  cache.clear()
}

// ── 命令封装 ──────────────────────────────────────────────────────────────

export async function probeRemoteMention(
  connectionId: number
): Promise<RemoteCapabilities> {
  return withTimeout(
    getShellTransport().call(REMOTE_MENTION_COMMANDS.probe, { connectionId })
  )
}

export async function listRemoteMentionFolders(
  connectionId: number
): Promise<RemoteFolder[]> {
  return cached(
    cacheKey(REMOTE_MENTION_COMMANDS.listFolders, [connectionId]),
    () =>
      withTimeout(
        getShellTransport().call(REMOTE_MENTION_COMMANDS.listFolders, {
          connectionId,
        })
      )
  )
}

export async function listRemoteMentionFiles(
  connectionId: number,
  folderId: number
): Promise<RemoteFileList> {
  // 显式给出类型参数：`call` 的返回类型是 `unknown`，靠推断拿不到 `RemoteFileList`。
  return cached<RemoteFileList>(
    cacheKey(REMOTE_MENTION_COMMANDS.listFiles, [connectionId, folderId]),
    () =>
      withTimeout(
        getShellTransport().call(REMOTE_MENTION_COMMANDS.listFiles, {
          connectionId,
          folderId,
        })
      )
  )
}

export async function listRemoteMentionSessions(
  connectionId: number,
  folderId: number,
  search?: string
): Promise<DbConversationSummary[]> {
  // 带搜索词的请求不进缓存：关键字是自由文本，缓存只会积累无用条目。
  const load = () =>
    withTimeout(
      getShellTransport().call<DbConversationSummary[]>(
        REMOTE_MENTION_COMMANDS.listSessions,
        {
          connectionId,
          folderId,
          ...(search ? { search } : {}),
        }
      )
    )
  return search
    ? load()
    : cached<DbConversationSummary[]>(
        cacheKey(REMOTE_MENTION_COMMANDS.listSessions, [
          connectionId,
          folderId,
        ]),
        load
      )
}

export async function listRemoteMentionAssistants(
  connectionId: number
): Promise<RemoteAssistantEntry[]> {
  return cached(
    cacheKey(REMOTE_MENTION_COMMANDS.listAssistants, [connectionId]),
    () =>
      withTimeout(
        getShellTransport().call(REMOTE_MENTION_COMMANDS.listAssistants, {
          connectionId,
        })
      )
  )
}

export async function listRemoteMentionAgents(
  connectionId: number
): Promise<RemoteAgentEntry[]> {
  return cached(
    cacheKey(REMOTE_MENTION_COMMANDS.listAgents, [connectionId]),
    () =>
      withTimeout(
        getShellTransport().call(REMOTE_MENTION_COMMANDS.listAgents, {
          connectionId,
        })
      )
  )
}

// ── 公网明文判定（设计 4.1.1.3 / 8 S2） ──────────────────────────────────

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return false
  }
  const [a, b] = parts
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  // 100.64.0.0/10 —— 运营商级 NAT，FRP 常见
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 127) return true
  if (a === 0) return true
  return false
}

/**
 * 该 `base_url` 是否是"经公网明文发送 token"的地址：`http://` 且主机不是
 * 回环、私网（10/8、172.16/12、192.168/16、100.64/10、fc00::/7）或 `.local`。
 *
 * 只提示、不阻止（Q8）。地址解析不出来时返回 false —— 输入过程中的半成品不
 * 应该先报一次风险。
 */
export function isPublicHttpBaseUrl(raw: string): boolean {
  const text = raw.trim()
  if (!text) return false
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return false
  }
  if (url.protocol !== "http:") return false
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (!host) return false
  if (host === "localhost" || host.endsWith(".localhost")) return false
  if (host.endsWith(".local")) return false
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return false
  // fc00::/7（唯一本地地址）
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return false
  if (isPrivateIpv4(host)) return false
  return true
}

// ── 本机连接列表（徽标失效态与明文提示共用） ─────────────────────────────
//
// 连接列表存在本机数据库里，一条命令即可读到；徽标要靠它判断"连接是否已被
// 删除"（设计 4.1.2.3 的灰色"已失效"），@ 面板要靠它列出可选的机器。这里做一
// 份进程内共享快照：所有徽标共用一次请求，窗口重新获得焦点时刷新。

let connectionsSnapshot: RemoteWorkspaceConnection[] | null = null
let connectionsLoading: Promise<void> | null = null
const connectionListeners = new Set<() => void>()

function emitConnections(): void {
  for (const listener of connectionListeners) listener()
}

/** 重新拉取连接列表；失败时保留"未知"（null），不把全部徽标误判为已失效。 */
export function refreshRemoteMentionConnections(): Promise<void> {
  if (connectionsLoading) return connectionsLoading
  connectionsLoading = listRemoteWorkspaceConnections()
    .then((list) => {
      connectionsSnapshot = list
      emitConnections()
    })
    .catch(() => {
      // 读不到就保持未知态：徽标照常显示，只是不标"已失效"。
    })
    .finally(() => {
      connectionsLoading = null
    })
  return connectionsLoading
}

function subscribeRemoteMentionConnections(onChange: () => void): () => void {
  connectionListeners.add(onChange)
  return () => {
    connectionListeners.delete(onChange)
  }
}

function getRemoteMentionConnectionsSnapshot():
  | RemoteWorkspaceConnection[]
  | null {
  return connectionsSnapshot
}

function getRemoteMentionConnectionsServerSnapshot():
  | RemoteWorkspaceConnection[]
  | null {
  return null
}

/** 当前共享的连接快照；`null` 表示还没读到（或读取失败）。 */
export function getRemoteMentionConnections():
  | RemoteWorkspaceConnection[]
  | null {
  return connectionsSnapshot
}

/** 一条远程引用的连接状态：`unknown` 时不做任何失效提示。 */
export type RemoteMentionConnectionState = "unknown" | "available" | "missing"

/**
 * 解析某个连接 id 在本机是否还存在。首个订阅者触发一次加载（并在窗口重新获得
 * 焦点时刷新），因此把远程引用粘进会话后删掉连接，徽标会自己变成"已失效"。
 */
export function useRemoteMentionConnectionState(
  connectionId: number | null | undefined
): RemoteMentionConnectionState {
  const list = useSyncExternalStore(
    subscribeRemoteMentionConnections,
    getRemoteMentionConnectionsSnapshot,
    getRemoteMentionConnectionsServerSnapshot
  )
  useEffect(() => {
    if (connectionsSnapshot === null) void refreshRemoteMentionConnections()
  }, [])
  useEffect(() => {
    const onFocus = () => {
      void refreshRemoteMentionConnections()
    }
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [])
  if (connectionId == null || list === null) return "unknown"
  return list.some((connection) => connection.id === connectionId)
    ? "available"
    : "missing"
}

/** 测试隔离：忘掉共享快照与在途请求。 */
export function resetRemoteMentionConnectionsForTests(): void {
  connectionsSnapshot = null
  connectionsLoading = null
  connectionListeners.clear()
}
