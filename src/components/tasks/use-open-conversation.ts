"use client"

import { useCallback } from "react"
import { useOptionalWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useTabStore } from "@/stores/tab-store"
import type { DbConversationSummary } from "@/lib/types"

/**
 * 打开一条被投影到看板上的普通会话：切回会话工作区并打开它的原标签页。
 * 看板投影出来的会话没有任务行，所以这条路径不触碰任何任务 API。
 */
export function useOpenConversation(): (
  conversation: DbConversationSummary
) => void {
  const openTab = useTabStore((s) => s.openTab)
  const route = useOptionalWorkbenchRoute()
  return useCallback(
    (conversation: DbConversationSummary) => {
      route?.setRoute("conversations")
      openTab(
        conversation.folder_id,
        conversation.id,
        conversation.agent_type,
        false
      )
    },
    [openTab, route]
  )
}
