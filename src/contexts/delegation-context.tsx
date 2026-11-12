"use client"

/**
 * DelegationContext — tracks live parent ↔ child delegation bindings
 * indexed by `parent_tool_use_id`.
 *
 * The parent's `delegate_to_agent` row needs to show the child
 * sub-session inline. Both wire events (`delegation_started` /
 * `delegation_completed`) are emitted on the *parent*'s connection stream by
 * the broker, so this context subscribes via the provider's `useAcpEvent`
 * fanout — which is fed by the Tauri firehose AND the per-connection attach
 * streams, so it behaves identically in desktop and web/server runtimes. It
 * filters the two delegation variants and exposes a tool-use-id-keyed lookup
 * so the row can resolve the binding by the field it already has in hand.
 *
 * State stays in-memory; persistence across reloads relies on the
 * parent_tool_use_id stored on the child's DB row (Phase 7).
 *
 * On the child's blocking prompts: attaching the child (below) is what makes
 * them visible at all. The permission store stays per-connection — a child's
 * `permission_request` is never re-keyed onto the parent's row — but
 * because the child IS a connection in the store, `useDelegationCardModel`
 * reads its pending prompts directly and badges the delegation row
 * "waiting", and both `SubAgentSessionDialog` and the `get_delegation_status`
 * row (`useDelegationTaskLive`, found by task id) answer through the child's
 * own connection id. Surfaces OUTSIDE this transcript (the pet badge/panel,
 * the work-task row, the parent LLM's view of `get_delegation_status`) are
 * handled in the backend, not here — see `pet_list_active_sessions_core` and
 * the broker's `blocked_on` (#447).
 */

import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import type {
  AgentType,
  EventEnvelope,
  RemoteDelegationStatus,
  RemoteTaskInfo,
} from "@/lib/types"
import {
  type AcpEventDelivery,
  useAcpActions,
  useAcpEvent,
} from "@/contexts/acp-connections-context"

export type DelegationStatus = "running" | "ok" | "err"

/**
 * 远程委派在当前卡片上的全部远程信息（跨机执行的任务）。
 *
 * `status` 保留后端原始状态（`RemoteDelegationStatus`），卡片据此区分
 * 「等待远程处理」「无法连接」「取消未确认」等只有远程才有的情形；绑定自身的
 * `status` 仍是本机三态，供既有状态解析逻辑复用。
 */
export interface RemoteDelegationBinding {
  connectionId: number
  connectionName: string
  runId: string
  /** 远程会话 id：本机不存在该会话，绝不用它查本机记录。 */
  conversationId: number | null
  link: string | null
  worktree: { path: string; branch: string } | null
  status: RemoteDelegationStatus
  blockedOn: string | null
  resultPreview: string | null
  errorCode: string | null
  durationMs: number | null
}

/** 后端远程状态 → 卡片既有三态。远程专属状态在 `remote.status` 里另行保留。 */
export function remoteStatusToDelegationStatus(
  status: RemoteDelegationStatus
): DelegationStatus {
  switch (status) {
    case "completed":
      return "ok"
    case "failed":
    case "canceled":
      return "err"
    default:
      // reserving / running / blocked / unreachable：任务仍在远程进行（或仍可
      // 重新同步），不能提前判死。
      return "running"
  }
}

/** 把事件里的远程信息归一成绑定用结构（防御缺失/异常字段）。 */
function remoteBindingFrom(
  remote: RemoteTaskInfo,
  status: RemoteDelegationStatus,
  extra?: {
    blockedOn?: string | null
    resultPreview?: string | null
    errorCode?: string | null
    durationMs?: number | null
  }
): RemoteDelegationBinding {
  return {
    connectionId: remote.connection_id,
    connectionName: remote.connection_name,
    runId: remote.run_id,
    conversationId: remote.conversation_id ?? null,
    link: remote.link ?? null,
    worktree: remote.worktree ?? null,
    status,
    blockedOn: extra?.blockedOn ?? null,
    resultPreview: extra?.resultPreview ?? null,
    errorCode: extra?.errorCode ?? null,
    durationMs: extra?.durationMs ?? null,
  }
}
export interface DelegationBinding {
  parentConnectionId: string
  parentToolUseId: string
  /** 本机子连接；远程委派没有本机子连接，为 `null`。 */
  childConnectionId: string | null
  /** 本机子会话 id；远程委派为 `null`（远程会话 id 在 `remote.conversationId`）。 */
  childConversationId: number | null
  agentType: AgentType | null
  status: DelegationStatus
  errorCode?: string
  /** Bounded task text from `delegation_started`. The card's fallback when
   *  the tool call's `raw_input` never carried the arguments (Cursor's
   *  identity-less announcements). */
  task: string | null
  /** Broker-minted task id from `delegation_started`. */
  taskId: string | null
  /** The assistant the child runs as (then `agentType` is ITS agent), and its
   *  name when the delegation started; null for a plain agent delegation. */
  assistantId: number | null
  assistantName: string | null
  /** 远程委派信息。存在时卡片走远程展示/跳转分支，且不按 `child*` 查本机。 */
  remote?: RemoteDelegationBinding | null
}

export interface DelegationContextValue {
  findByParentToolUseId(id: string): DelegationBinding | undefined
  findByChildConversationId(id: number): DelegationBinding | undefined
  /**
   * Resolve a binding by the broker-minted task id rather than the parent's
   * tool_use_id. `resume_delegation` needs this: it re-binds the child to the
   * ORIGINAL `delegate_to_agent` call's id, so the resume card's own
   * tool_call_id matches no binding — the task id is the only handle it holds.
   */
  findByTaskId(taskId: string): DelegationBinding | undefined
  /**
   * Every binding a parent connection's delegations left here, finished ones
   * included, in the order they started. The composer's running list takes
   * WHICH delegations still run from the parent's own `delegatedChildren`
   * (the backend's word, recovered by a snapshot) and only their identity from
   * here: a binding stays `running` forever if its completion event was
   * missed, and an async delegation is not tied to any one reply.
   */
  bindingsForParent(parentConnectionId: string): DelegationBinding[]
}

const DelegationContext = createContext<DelegationContextValue | null>(null)

export function useDelegation(): DelegationContextValue {
  const ctx = useContext(DelegationContext)
  if (!ctx) {
    throw new Error("useDelegation must be used within DelegationProvider")
  }
  return ctx
}

/**
 * Fixed lookups in place of the live provider — for surfaces that render chat
 * cards outside a workspace (the activity gallery page, component tests).
 */
export function StaticDelegationProvider({
  value,
  children,
}: {
  value: DelegationContextValue
  children: ReactNode
}) {
  return (
    <DelegationContext.Provider value={value}>
      {children}
    </DelegationContext.Provider>
  )
}

/** The lookups, or `null` outside `DelegationProvider` — for a card that only
 *  enriches itself from a live binding when there is one. */
export function useOptionalDelegation(): DelegationContextValue | null {
  return useContext(DelegationContext)
}

/** Grace period after `delegation_completed` before tearing down the
 *  synthetic child ConnectionState. Long enough for the parent UI to
 *  finish rendering the child's final assistant text from live state
 *  before falling through to the DB-persisted view. */
const CHILD_DETACH_GRACE_MS = 2_000

/** 暂存的远程任务状态变化（绑定尚未建立时）。`task_id` 唯一，后到覆盖先到。 */
type PendingRemoteUpdate = {
  status: RemoteDelegationStatus
  blockedOn?: string | null
  resultPreview?: string | null
  errorCode?: string | null
  durationMs?: number | null
}

/** 暂存表上限：超过即丢最旧，避免客户端长时间离线的任务把内存撑大。 */
const MAX_PENDING_REMOTE_UPDATES = 64

/**
 * 记一条远程状态变化。同 task id 覆盖合并（后到的字段优先），并把该条移到表尾
 * ——表按到达顺序淘汰最旧的一条。
 */
function stampPendingRemoteUpdate(
  store: Map<string, PendingRemoteUpdate>,
  taskId: string,
  update: PendingRemoteUpdate
): void {
  if (!taskId) return
  const merged: PendingRemoteUpdate = {
    ...(store.get(taskId) ?? {}),
    ...update,
  }
  store.delete(taskId)
  store.set(taskId, merged)
  while (store.size > MAX_PENDING_REMOTE_UPDATES) {
    const oldest = store.keys().next().value
    if (oldest === undefined) break
    store.delete(oldest)
  }
}

export function DelegationProvider({ children }: { children: ReactNode }) {
  const { attachDelegationChild, detachDelegationChild } = useAcpActions()
  const [byToolUseId, setByToolUseId] = useState<
    Map<string, DelegationBinding>
  >(() => new Map())

  // Stable refs so the event-subscription effect doesn't tear down on
  // every action identity change (the actions object is memoized but
  // its members are stable callbacks; still, defensive ref-pinning
  // keeps the subscription stable across React's StrictMode double-effect).
  const attachRef = useRef(attachDelegationChild)
  const detachRef = useRef(detachDelegationChild)
  useEffect(() => {
    attachRef.current = attachDelegationChild
  }, [attachDelegationChild])
  useEffect(() => {
    detachRef.current = detachDelegationChild
  }, [detachDelegationChild])

  // Pending detach timers — one per parent_tool_use_id. Started on
  // `delegation_completed`, cleared if a fresh `delegation_started`
  // arrives for the same parent_tool_use_id before the timer fires.
  const detachTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>()
  )

  // 远程任务的状态/终态事件只带 `task_id`（没有 parent_tool_use_id，也没有本机
  // 子连接）。绑定还没建立时（事件乱序、客户端中途挂载后先收到 updated），先按
  // task id 暂存，等 `remote_delegation_started` 到达时补上；有界（丢弃最旧），
  // 因为远程任务结束即离开这份表。
  const pendingRemoteUpdatesRef = useRef(new Map<string, PendingRemoteUpdate>())

  const cancelDetachTimer = useCallback((parentToolUseId: string) => {
    const timers = detachTimersRef.current
    const t = timers.get(parentToolUseId)
    if (t) {
      clearTimeout(t)
      timers.delete(parentToolUseId)
    }
  }, [])

  const handleEnvelope = useCallback(
    (envelope: EventEnvelope, delivery?: AcpEventDelivery) => {
      if (envelope.type === "delegation_started") {
        const next: DelegationBinding = {
          parentConnectionId: envelope.parent_connection_id,
          parentToolUseId: envelope.parent_tool_use_id,
          childConnectionId: envelope.child_connection_id,
          childConversationId: envelope.child_conversation_id,
          agentType: envelope.agent_type,
          status: "running",
          task: envelope.task_preview ?? null,
          taskId: envelope.task_id ?? null,
          assistantId: envelope.assistant_id ?? null,
          assistantName: envelope.assistant_name ?? null,
        }
        setByToolUseId((prev) => {
          const m = new Map(prev)
          m.set(envelope.parent_tool_use_id, next)
          return m
        })
        // Cancel any pending detach for this parent_tool_use_id —
        // delegation_started can be replayed after a partial flow
        // (e.g. reconnect), and an in-flight detach would tear the
        // child state down right as it returns.
        cancelDetachTimer(envelope.parent_tool_use_id)
        // Pull the child connection into the reducer so its
        // streaming text / tool calls / pendingPermission reach
        // the parent's delegation row. A binding re-seeded from
        // the parent's snapshot names a child that is already mid-turn —
        // possibly parked on a permission it raised before this client
        // attached — so that one is hydrated from the child's own snapshot.
        attachRef.current({
          connectionId: envelope.child_connection_id,
          parentConnectionId: envelope.parent_connection_id,
          parentToolUseId: envelope.parent_tool_use_id,
          agentType: envelope.agent_type,
          hydrate: delivery?.seededFromSnapshot === true,
        })
        return
      }
      if (envelope.type === "delegation_completed") {
        setByToolUseId((prev) => {
          const existing = prev.get(envelope.parent_tool_use_id)
          // If we missed the start event (e.g. context mounted mid-flight,
          // reconnect, or snapshot replay that only re-delivered the
          // completion), synthesize a minimal binding so the parent UI still
          // shows the result — with the real agent_type the event now carries,
          // so the card renders the correct agent icon/label.
          const base: DelegationBinding = existing ?? {
            parentConnectionId: envelope.parent_connection_id,
            parentToolUseId: envelope.parent_tool_use_id,
            childConnectionId: envelope.child_connection_id,
            childConversationId: envelope.child_conversation_id,
            agentType: envelope.agent_type,
            status: "running",
            // Missed-start synthesis: the completion event carries no task
            // label; the card recovers it from the terminal meta instead.
            task: null,
            taskId: null,
            assistantId: envelope.assistant_id ?? null,
            assistantName: envelope.assistant_name ?? null,
          }
          const updated: DelegationBinding =
            envelope.result.kind === "ok"
              ? {
                  ...base,
                  status: "ok",
                }
              : {
                  ...base,
                  status: "err",
                  errorCode: envelope.result.error_code,
                }
          const m = new Map(prev)
          m.set(envelope.parent_tool_use_id, updated)
          return m
        })

        // Schedule detach of the synthetic child entry. We keep it
        // around briefly so the final assistant text rendered from
        // live state survives long enough for the user to read it
        // before the parent UI falls back to the DB-persisted view.
        const parentToolUseId = envelope.parent_tool_use_id
        const childConnectionId = envelope.child_connection_id
        cancelDetachTimer(parentToolUseId)
        const timer = setTimeout(() => {
          detachTimersRef.current.delete(parentToolUseId)
          detachRef.current(childConnectionId)
        }, CHILD_DETACH_GRACE_MS)
        detachTimersRef.current.set(parentToolUseId, timer)
        return
      }
      // ── 远程委派（跨机执行）────────────────────────────────────────────
      // 远程任务不在本机起子智能体：没有 child_connection_id /
      // child_conversation_id，也就没有可 attach 的子连接。绑定里 child* 一律
      // 为 null，卡片只按 `remote` 展示与跳转。
      if (envelope.type === "remote_delegation_started") {
        // 先到的状态事件（updated/completed 只带 task id）在这里补上；同时保留
        // 同 task 已有绑定的远程状态，避免重放把「无法连接」倒退成「运行中」。
        const pending = pendingRemoteUpdatesRef.current.get(envelope.task_id)
        setByToolUseId((prev) => {
          const existing = prev.get(envelope.parent_tool_use_id)
          const previousRemote =
            existing && existing.taskId === envelope.task_id
              ? (existing.remote ?? null)
              : null
          const status = pending?.status ?? previousRemote?.status ?? "running"
          const terminal =
            status === "completed" ||
            status === "failed" ||
            status === "canceled"
          const remote: RemoteDelegationBinding = {
            ...remoteBindingFrom(envelope.remote, status),
            conversationId:
              envelope.remote.conversation_id ??
              previousRemote?.conversationId ??
              null,
            link: envelope.remote.link ?? previousRemote?.link ?? null,
            worktree:
              envelope.remote.worktree ?? previousRemote?.worktree ?? null,
            blockedOn: terminal
              ? null
              : (pending?.blockedOn ?? previousRemote?.blockedOn ?? null),
            resultPreview:
              pending?.resultPreview ?? previousRemote?.resultPreview ?? null,
            errorCode: pending?.errorCode ?? previousRemote?.errorCode ?? null,
            durationMs:
              pending?.durationMs ?? previousRemote?.durationMs ?? null,
          }
          const next: DelegationBinding = {
            parentConnectionId: envelope.parent_connection_id,
            parentToolUseId: envelope.parent_tool_use_id,
            childConnectionId: null,
            childConversationId: null,
            agentType: envelope.agent_type ?? existing?.agentType ?? null,
            status: remoteStatusToDelegationStatus(status),
            errorCode: remote.errorCode ?? undefined,
            task: envelope.task_preview ?? existing?.task ?? null,
            taskId: envelope.task_id,
            assistantId: envelope.assistant_id ?? null,
            assistantName: envelope.assistant_name ?? null,
            remote,
          }
          const m = new Map(prev)
          m.set(envelope.parent_tool_use_id, next)
          return m
        })
        pendingRemoteUpdatesRef.current.delete(envelope.task_id)
        // 同一 parent_tool_use_id 上可能有本机绑定的残留（极少见的重放），
        // 远程绑定已接管，别再让待执行的 detach 拆掉远程卡片。
        cancelDetachTimer(envelope.parent_tool_use_id)
        return
      }
      if (
        envelope.type === "remote_delegation_updated" ||
        envelope.type === "remote_delegation_completed"
      ) {
        const update: PendingRemoteUpdate =
          envelope.type === "remote_delegation_updated"
            ? {
                status: envelope.status,
                blockedOn: envelope.blocked_on ?? null,
              }
            : {
                status: envelope.status,
                resultPreview: envelope.result_preview ?? null,
                errorCode: envelope.error_code ?? null,
                durationMs: envelope.duration_ms ?? null,
              }
        stampPendingRemoteUpdate(
          pendingRemoteUpdatesRef.current,
          envelope.task_id,
          update
        )
        setByToolUseId((prev) => {
          let hit = false
          const m = new Map(prev)
          for (const [key, binding] of prev) {
            if (!binding.remote || binding.taskId !== envelope.task_id) continue
            hit = true
            const terminal =
              update.status === "completed" ||
              update.status === "failed" ||
              update.status === "canceled"
            m.set(key, {
              ...binding,
              status: remoteStatusToDelegationStatus(update.status),
              errorCode: update.errorCode ?? binding.errorCode,
              remote: {
                ...binding.remote,
                status: update.status,
                blockedOn: terminal
                  ? null
                  : (update.blockedOn ?? binding.remote.blockedOn),
                resultPreview:
                  update.resultPreview ?? binding.remote.resultPreview,
                errorCode: update.errorCode ?? binding.remote.errorCode,
                durationMs: update.durationMs ?? binding.remote.durationMs,
              },
            })
          }
          // 没命中就原样返回，避免无谓的重渲染；状态留着等 started 到达。
          return hit ? m : prev
        })
        return
      }
    },
    [cancelDetachTimer]
  )

  // Single subscription via the provider's fanout. `useAcpEvent` fires for
  // every mapped envelope on both the Tauri firehose and the per-connection
  // attach streams, so the parent-stream delegation events reach us in both
  // desktop and web/server runtimes; non-delegation types are ignored above.
  useAcpEvent(handleEnvelope)

  // Clear any pending detach timers on unmount. The synthetic children are
  // also cleaned up by the connections context's own teardown.
  useEffect(() => {
    const timers = detachTimersRef.current
    const pendingRemote = pendingRemoteUpdatesRef.current
    return () => {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
      pendingRemote.clear()
    }
  }, [])

  const findByParentToolUseId = useCallback(
    (id: string): DelegationBinding | undefined => byToolUseId.get(id),
    [byToolUseId]
  )

  const findByChildConversationId = useCallback(
    (id: number): DelegationBinding | undefined => {
      for (const b of byToolUseId.values()) {
        if (b.childConversationId === id) return b
      }
      return undefined
    },
    [byToolUseId]
  )

  const findByTaskId = useCallback(
    (taskId: string): DelegationBinding | undefined => {
      if (!taskId) return undefined
      for (const b of byToolUseId.values()) {
        if (b.taskId === taskId) return b
      }
      return undefined
    },
    [byToolUseId]
  )

  const bindingsForParent = useCallback(
    (parentConnectionId: string): DelegationBinding[] => {
      const out: DelegationBinding[] = []
      if (!parentConnectionId) return out
      // Map order is insertion order: a binding is inserted when its
      // delegation starts (a re-start replaces it in place).
      for (const b of byToolUseId.values()) {
        if (b.parentConnectionId === parentConnectionId) out.push(b)
      }
      return out
    },
    [byToolUseId]
  )

  const value = useMemo(
    () => ({
      findByParentToolUseId,
      findByChildConversationId,
      findByTaskId,
      bindingsForParent,
    }),
    [
      findByParentToolUseId,
      findByChildConversationId,
      findByTaskId,
      bindingsForParent,
    ]
  )

  return (
    <DelegationContext.Provider value={value}>
      {children}
    </DelegationContext.Provider>
  )
}
