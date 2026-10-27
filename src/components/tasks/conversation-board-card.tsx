"use client"

import { useTranslations } from "next-intl"
import { Check, Loader2 } from "lucide-react"
import { AgentIcon } from "@/components/agent-icon"
import { formatRelative } from "@/components/conversations/sidebar-conversation-grouping"
import { cn } from "@/lib/utils"
import type { DbConversationSummary } from "@/lib/types"

/** 会话状态 → `Folder.statusLabels` 的键（与侧栏同一套文案）。 */
const STATUS_LABEL_KEYS = {
  in_progress: "statusLabels.in_progress",
  pending_review: "statusLabels.pending_review",
  completed: "statusLabels.completed",
  cancelled: "statusLabels.cancelled",
} as const

type KnownStatus = keyof typeof STATUS_LABEL_KEYS

function isKnownStatus(status: string): status is KnownStatus {
  return status in STATUS_LABEL_KEYS
}

/**
 * 看板上的普通会话卡：沿用任务卡的外观与密度，但底部没有任务操作——
 * 会话不是任务，点击只打开它自己的原会话。它由 `projectBoardConversations`
 * 从前端投影得到，没有任务行可更新或删除。
 */
export function ConversationBoardCard({
  conversation,
  folderName,
  now,
  onOpen,
}: {
  conversation: DbConversationSummary
  folderName: string | null
  /** 共享的渲染时间戳，让所有卡的相对时间一致。 */
  now: number
  onOpen: () => void
}) {
  const t = useTranslations("Folder")
  const status = conversation.status
  const label = isKnownStatus(status) ? t(STATUS_LABEL_KEYS[status]) : status
  const title = conversation.title ?? t("conversationCard.untitledConversation")

  let tone =
    "rounded-full bg-muted px-2 py-1 text-[0.625rem] text-muted-foreground"
  let icon: React.ReactNode = null
  switch (conversation.status) {
    case "in_progress":
      tone = "gap-1 text-[0.6875rem] text-primary"
      icon = (
        <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden="true" />
      )
      break
    case "pending_review":
      tone =
        "rounded-full border border-amber-500/45 bg-amber-500/5 px-2 py-1 text-[0.625rem] text-amber-600 dark:border-amber-400/40 dark:text-amber-400"
      break
    case "completed":
      tone =
        "gap-1 rounded-full bg-emerald-500/10 px-2 py-1 text-[0.625rem] text-emerald-600 dark:text-emerald-400"
      icon = (
        <Check
          className="size-2.5 shrink-0"
          strokeWidth={3}
          aria-hidden="true"
        />
      )
      break
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onOpen()
        }
      }}
      className={cn(
        "group/card flex cursor-pointer flex-col rounded-xl border border-foreground/15 bg-card ws-msg-card p-3 text-left",
        "transition-colors hover:border-primary",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <AgentIcon
          agentType={conversation.agent_type}
          className="mt-[0.125rem] size-3.5"
        />
        <span className="min-w-0 flex-1 break-words text-[0.8125rem] font-medium leading-snug">
          {title}
        </span>
        <span
          className={cn(
            "inline-flex min-w-0 shrink-0 items-center font-medium leading-none",
            tone
          )}
          title={label}
        >
          {icon}
          <span className="truncate">{label}</span>
        </span>
      </div>

      <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[0.6875rem] text-muted-foreground">
        {folderName ? (
          <span className="max-w-40 truncate">{folderName}</span>
        ) : null}
        {folderName && conversation.git_branch ? (
          <span className="text-muted-foreground/40">/</span>
        ) : null}
        {conversation.git_branch ? (
          <span className="truncate font-mono text-[0.625rem]">
            {conversation.git_branch}
          </span>
        ) : null}
        {folderName || conversation.git_branch ? (
          <span className="text-muted-foreground/40">·</span>
        ) : null}
        <span className="shrink-0">
          {formatRelative(conversation.updated_at, now)}
        </span>
      </div>
    </div>
  )
}
