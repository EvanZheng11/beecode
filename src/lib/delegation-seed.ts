import type {
  ActiveDelegationState,
  ActiveRemoteDelegationState,
  EventEnvelope,
  RemoteDelegationStatus,
} from "@/lib/types"

/**
 * Build the `delegation_started` envelopes that re-seed `DelegationProvider`
 * bindings from a snapshot's `active_delegations`.
 *
 * `active_delegations` is the backend's RUNNING-only set (completed delegations
 * are removed and recovered elsewhere — the live binding, or the child's
 * persisted DB row via `inject_delegation_meta`), so every entry maps to a
 * `delegation_started`. The transient `DelegationStarted` event mutates no
 * persisted state and isn't replayed on the snapshot attach path, so without
 * this re-seed a web/server client that cold-attaches, re-attaches after a
 * broadcast lag, or refreshes mid-delegation never establishes the running
 * binding — the card shows a premature "completed" and no "查看会话" until the
 * child finishes. This reproduces the same envelope the broker emits live; the
 * caller fans it to the JS event subscribers (DelegationProvider), which
 * re-attaches the child's live stream. `connectionId` is the parent (the
 * snapshot's own connection_id); `eventSeq` is informational (DelegationProvider
 * ignores it).
 */
export function buildDelegationSeedEnvelopes(
  connectionId: string,
  activeDelegations: ActiveDelegationState[],
  eventSeq: number
): EventEnvelope[] {
  const out: EventEnvelope[] = []
  for (const d of activeDelegations) {
    out.push({
      seq: eventSeq,
      connection_id: connectionId,
      type: "delegation_started",
      parent_connection_id: connectionId,
      parent_tool_use_id: d.parent_tool_use_id,
      child_connection_id: d.child_connection_id,
      child_conversation_id: d.child_conversation_id,
      agent_type: d.agent_type,
      task_preview: d.task_preview ?? null,
      task_id: d.task_id ?? null,
      assistant_id: d.assistant_id ?? null,
      assistant_name: d.assistant_name ?? null,
    })
  }
  return out
}

/** 终态集合：这些状态到达后跟踪协程已结束，卡片只需渲染结果。 */
const REMOTE_TERMINAL_STATUSES: ReadonlySet<RemoteDelegationStatus> = new Set([
  "completed",
  "failed",
  "canceled",
])

/** 需要额外发 `remote_delegation_updated` 的状态（绑定建立后还要改状态）。 */
function needsRemoteUpdate(status: RemoteDelegationStatus): boolean {
  return status !== "running"
}

/**
 * 刷新/重连重放：把快照的 `active_remote_delegations` 还原成实时事件序列。
 *
 * 远程委派没有本机子连接，`delegation_started` 给不了它的信息，所以这里发
 * `remote_delegation_started`；快照还带着「当前状态」，而 started 事件本身不带
 * 状态，因此再补一条 `remote_delegation_updated`（`blocked` / `unreachable` /
 * `reserving`），或对已结束的任务补 `remote_delegation_completed`。
 *
 * 每条都用快照自身的 `eventSeq`：这些信封只喂给 JS 订阅者
 * （`DelegationProvider`），不进 reducer、不推进 `lastAppliedSeq`，与任何真实
 * 事件重放都是幂等的（同 `parent_tool_use_id` / `task_id` 覆盖写入）。
 */
export function buildRemoteDelegationSeedEnvelopes(
  connectionId: string,
  activeRemoteDelegations: ActiveRemoteDelegationState[],
  eventSeq: number
): EventEnvelope[] {
  const out: EventEnvelope[] = []
  for (const d of activeRemoteDelegations) {
    out.push({
      seq: eventSeq,
      connection_id: connectionId,
      type: "remote_delegation_started",
      parent_connection_id: connectionId,
      parent_tool_use_id: d.parent_tool_use_id,
      task_id: d.task_id,
      remote: d.remote,
      task_preview: d.task_preview ?? null,
      assistant_id: d.assistant_id ?? null,
      assistant_name: d.assistant_name ?? null,
      agent_type: d.agent_type ?? null,
    })
    if (REMOTE_TERMINAL_STATUSES.has(d.status)) {
      out.push({
        seq: eventSeq,
        connection_id: connectionId,
        type: "remote_delegation_completed",
        task_id: d.task_id,
        status: d.status,
        result_preview: d.result_preview ?? null,
        error_code: d.error_code ?? null,
        duration_ms: d.duration_ms ?? null,
      })
      continue
    }
    if (needsRemoteUpdate(d.status)) {
      out.push({
        seq: eventSeq,
        connection_id: connectionId,
        type: "remote_delegation_updated",
        task_id: d.task_id,
        status: d.status,
        blocked_on: d.blocked_on ?? null,
      })
    }
  }
  return out
}
