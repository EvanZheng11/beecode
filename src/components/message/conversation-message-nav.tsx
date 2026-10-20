"use client"

import { memo, useCallback, useState } from "react"
import {
  ChevronDownIcon,
  ChevronRight,
  FileIcon,
  Loader2,
  BotIcon,
  Eye,
  RotateCw,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useWorkspaceActions } from "@/contexts/workspace-context"
import type { FileChangeStat } from "@/lib/session-files"
import {
  CommitFileAdditions,
  CommitFileDeletions,
} from "@/components/ai-elements/commit"
import {
  useDelegationCardModel,
  type DelegationCardSource,
} from "@/hooks/use-delegation-card-model"
import {
  DelegationIdentityAvatar,
  DelegationIdentityName,
} from "./delegation-identity"
import { StatusBadge } from "./delegation-status-badge"
import { useSessionViewerHost } from "./session-viewer-host-context"
import {
  fileNameOf,
  isRemovedFileDiff,
  normalizeSlashPath,
  toFolderRelativePath,
} from "@/lib/file-path-display"
import { cn } from "@/lib/utils"

/** One navigable user message. Present for every user turn, even when it made
 *  no file edits (`hasChanges === false`) so the list is a complete index —
 *  including the messages above the loaded window of a long conversation. */
export interface MessageNavEntry {
  /** Index into the rendered `threadItems` array — fed to `scrollToIndex`.
   *  Null for a message above the loaded window. */
  threadIndex: number | null
  /** Global turn index of a message above the loaded window (what paging it
   *  in needs); null for a loaded one. */
  turnIndex: number | null
  turnId: string
  /** 1-based position among the conversation's user messages. */
  ordinal: number
  label: string
  additions: number
  deletions: number
  files: FileChangeStat[]
  hasChanges: boolean
  subAgents?: readonly DelegationCardSource[]
}

interface ConversationMessageNavProps {
  /** Number of user messages — drives the collapsed chip summary. The parent
   *  derives this cheaply (no diff parsing) so the chip can show without
   *  computing the expensive per-file `entries` until the panel is opened. */
  count: number
  /** Whether the panel is expanded. Owned by the parent so it can compute
   *  `entries` lazily — only while open. */
  expanded: boolean
  onToggle: (next: boolean) => void
  /** Per-message rows. Only populated while `expanded` (computed lazily). */
  entries: MessageNavEntry[]
  /** Jump to a message: the parent scrolls to a loaded one, or pages one
   *  above the loaded window in first. */
  onSelect: (entry: MessageNavEntry) => void
  /** The message being paged in for a jump, if any. */
  revealingTurnId?: string | null
  /** The messages above the loaded window aren't listed yet: their outline
   *  is loading, or failed to (offering `onRetryEarlier`). */
  earlier?: "loading" | "error" | null
  onRetryEarlier?: () => void
}

/**
 * 当前会话的消息导航，通过 Portal 显示在会话详情内部。
 *
 * 折叠时显示标题和消息数量；展开后列出每条用户消息及文件变更。
 * 点击文件通过 `openSessionFileDiff` 打开差异；点击尚未加载的消息
 * 通过 `onSelect` 先加载对应历史记录。折叠时保持属性稳定，避免流式重渲染。
 */
export const ConversationMessageNav = memo(function ConversationMessageNav({
  count,
  expanded,
  onToggle,
  entries,
  onSelect,
  revealingTurnId = null,
  earlier = null,
  onRetryEarlier,
}: ConversationMessageNavProps) {
  const t = useTranslations("Folder.chat.messageNav")
  const { openSessionFileDiff } = useWorkspaceActions()
  const { activeFolder: folder } = useActiveFolder()
  const [chosen, setChosen] = useState<{ turnId: string | null } | null>(null)
  const openTurnId = chosen
    ? chosen.turnId
    : entries[entries.length - 1]?.turnId

  const handleFileClick = useCallback(
    (
      filePath: string,
      diff: string | null,
      ordinal: number,
      changeIndex: number
    ) => {
      openSessionFileDiff(
        filePath,
        diff ?? t("noDiffDataAvailable", { filePath }),
        `msg-${ordinal}-chg-${changeIndex + 1}`
      )
    },
    [openSessionFileDiff, t]
  )

  if (count <= 0) return null

  return (
    <section className="min-w-0">
      <h3 className="min-w-0">
        <button
          type="button"
          aria-label={
            expanded ? t("collapse") : t("collapsedSummary", { count })
          }
          aria-expanded={expanded}
          onClick={() => onToggle(!expanded)}
          className="group/section flex h-7 w-full min-w-0 items-center gap-2 rounded-md text-start outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <span aria-hidden="true" className="flex w-7 shrink-0 justify-center">
            <ChevronDownIcon
              className={cn(
                "size-3.5 text-muted-foreground transition-transform",
                !expanded && "-rotate-90 rtl:rotate-90"
              )}
            />
          </span>
          <span className="min-w-0 truncate text-xs font-semibold text-foreground">
            {t("title")}
          </span>
          <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
            {count}
          </span>
        </button>
      </h3>

      {expanded && (
        <div className="min-w-0 space-y-px">
          {earlier === "loading" && (
            <div className="flex items-center gap-2 px-2.5 py-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
              <span className="min-w-0 truncate">{t("loadingEarlier")}</span>
            </div>
          )}
          {earlier === "error" && (
            <button
              type="button"
              onClick={onRetryEarlier}
              className="flex w-full items-center gap-2 rounded-lg border border-dashed border-border px-2.5 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
            >
              <RotateCw className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 truncate">{t("loadEarlier")}</span>
            </button>
          )}
          {entries.map((entry) => {
            const isOpen = openTurnId === entry.turnId
            const subAgents = entry.subAgents ?? []
            const expandable = entry.hasChanges || subAgents.length > 0
            const isRevealing = revealingTurnId === entry.turnId
            const uniqueFileCount = new Set(
              entry.files.map((file) => normalizeSlashPath(file.path))
            ).size

            return (
              <div key={entry.turnId} className="min-w-0">
                <div
                  className={cn(
                    "-mx-1.5 flex h-8 min-w-0 items-center rounded-md px-1.5",
                    isOpen ? "bg-blue-500/[0.08]" : "hover:bg-muted/60"
                  )}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setChosen({ turnId: entry.turnId })
                      onSelect(entry)
                    }}
                    title={entry.label}
                    aria-current={isOpen ? "location" : undefined}
                    aria-expanded={expandable ? isOpen : undefined}
                    aria-busy={isRevealing || undefined}
                    className="flex h-8 min-w-0 flex-1 items-center gap-2 text-start outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    <span className="flex h-5 min-w-7 shrink-0 items-center justify-center gap-1 rounded-md bg-blue-500/10 px-0.5 text-2xs tabular-nums text-blue-600 dark:text-blue-400">
                      {isRevealing && (
                        <Loader2
                          aria-hidden="true"
                          className="size-2.5 animate-spin"
                        />
                      )}
                      {entry.ordinal}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-foreground/85">
                      {entry.label}
                    </span>
                    {subAgents.length > 0 && (
                      <span className="flex shrink-0 items-center gap-0.5 text-2xs text-muted-foreground">
                        <BotIcon aria-hidden="true" className="size-3" />
                        {subAgents.length}
                      </span>
                    )}
                  </button>

                  {expandable && (
                    <button
                      type="button"
                      aria-label={
                        entry.hasChanges
                          ? t("fileCount", { count: uniqueFileCount })
                          : t("title")
                      }
                      aria-expanded={isOpen}
                      onClick={() =>
                        setChosen({ turnId: isOpen ? null : entry.turnId })
                      }
                      className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
                    >
                      <ChevronRight
                        className={cn(
                          "h-3.5 w-3.5 transition-transform",
                          isOpen && "rotate-90"
                        )}
                      />
                    </button>
                  )}
                </div>

                {isOpen && subAgents.length > 0 && (
                  <div className="space-y-1.5 py-1.5">
                    {subAgents.map((source) => (
                      <NavSubAgentCard
                        key={source.parentToolUseId}
                        source={source}
                      />
                    ))}
                  </div>
                )}
                {entry.hasChanges && isOpen && (
                  <div className="my-1.5 overflow-hidden rounded-lg border border-border bg-card">
                    <div className="flex h-7 items-center gap-1.5 border-b px-2.5 text-2xs text-muted-foreground">
                      <span className="flex-1">
                        {t("fileCount", { count: uniqueFileCount })}
                      </span>
                      <span className="text-green-600 dark:text-green-400">
                        +{entry.additions}
                      </span>
                      <span className="text-red-600 dark:text-red-400">
                        -{entry.deletions}
                      </span>
                    </div>
                    <ul className="space-y-1 p-1.5">
                      {entry.files.map((file, fileIndex) => {
                        const displayPath = toFolderRelativePath(
                          file.path,
                          folder?.path
                        )
                        const isRemoved = isRemovedFileDiff(file.diff)

                        return (
                          <li key={file.id}>
                            <button
                              type="button"
                              onClick={() =>
                                handleFileClick(
                                  file.path,
                                  file.diff,
                                  entry.ordinal,
                                  fileIndex
                                )
                              }
                              title={displayPath}
                              className={cn(
                                "flex w-full min-w-0 items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors",
                                isRemoved
                                  ? "border-destructive/30 bg-destructive/10 hover:bg-destructive/20"
                                  : "border-border bg-transparent hover:bg-accent/40"
                              )}
                            >
                              <FileIcon
                                className={cn(
                                  "h-3.5 w-3.5 shrink-0",
                                  isRemoved
                                    ? "text-destructive"
                                    : "text-muted-foreground"
                                )}
                              />
                              <span
                                className={cn(
                                  "min-w-0 flex-1 truncate text-xs",
                                  isRemoved
                                    ? "text-destructive"
                                    : "text-foreground"
                                )}
                              >
                                {fileNameOf(displayPath)}
                              </span>
                              {isRemoved ? (
                                <span className="inline-flex shrink-0 items-center rounded-md border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 font-mono text-3xs text-destructive">
                                  {t("remove")}
                                </span>
                              ) : (
                                <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-3xs text-foreground">
                                  <CommitFileAdditions
                                    count={file.additions}
                                    className="text-3xs"
                                  />
                                  <CommitFileDeletions
                                    count={file.deletions}
                                    className="text-3xs"
                                  />
                                </span>
                              )}
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
})

/** 沿用上游导航委派卡，复用消息正文的身份、状态与会话查看器。 */
const NavSubAgentCard = memo(function NavSubAgentCard({
  source,
}: {
  source: DelegationCardSource
}) {
  const t = useTranslations("Folder.chat.delegation")
  const viewerHost = useSessionViewerHost()
  const { identity, task, status, errorCode, childConversationId } =
    useDelegationCardModel(source)
  const body = (
    <span className="flex min-w-0 flex-1 items-center gap-2.5 py-2 ps-2.5 pe-2">
      <DelegationIdentityAvatar identity={identity} size="overlay" />
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <DelegationIdentityName
            identity={identity}
            className="min-w-0 truncate text-xs font-semibold text-foreground"
          />
          <StatusBadge status={status} errorCode={errorCode} />
        </span>
        {task && (
          <span
            className="block truncate text-2xs text-muted-foreground"
            title={task}
          >
            {task}
          </span>
        )}
      </span>
    </span>
  )
  const card =
    "flex w-full min-w-0 items-stretch overflow-hidden rounded-lg border border-border bg-card text-start"
  return childConversationId != null && viewerHost ? (
    <button
      type="button"
      title={t("openDetail")}
      onClick={() => viewerHost.open({ kind: "delegation", source })}
      className={cn(card, "hover:bg-muted/40")}
    >
      {body}
      <span
        aria-hidden="true"
        className="flex w-8 shrink-0 items-center justify-center border-s border-border text-foreground/70"
      >
        <Eye className="size-3.5" />
      </span>
    </button>
  ) : (
    <div className={card}>{body}</div>
  )
})
