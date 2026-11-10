import { describe, expect, it } from "vitest"

import {
  buildDelegationSeedEnvelopes,
  buildRemoteDelegationSeedEnvelopes,
} from "@/lib/delegation-seed"
import type {
  ActiveDelegationState,
  ActiveRemoteDelegationState,
} from "@/lib/types"

function dele(
  overrides: Partial<ActiveDelegationState> & { parent_tool_use_id: string }
): ActiveDelegationState {
  return {
    child_connection_id: "c1",
    child_conversation_id: 99,
    agent_type: "codex",
    ...overrides,
  }
}

describe("buildDelegationSeedEnvelopes", () => {
  it("seeds a delegation_started per running delegation, carrying the parent connection id", () => {
    const env = buildDelegationSeedEnvelopes(
      "parent-conn",
      [dele({ parent_tool_use_id: "pt-1" })],
      42
    )
    expect(env).toHaveLength(1)
    expect(env[0]).toMatchObject({
      seq: 42,
      connection_id: "parent-conn",
      type: "delegation_started",
      parent_connection_id: "parent-conn",
      parent_tool_use_id: "pt-1",
      child_connection_id: "c1",
      child_conversation_id: 99,
      agent_type: "codex",
      // Absent on older-backend snapshots → normalized to null.
      task_preview: null,
      task_id: null,
      assistant_id: null,
      assistant_name: null,
    })
  })

  it("re-seeds the assistant a running delegation runs as", () => {
    const env = buildDelegationSeedEnvelopes(
      "parent-conn",
      [
        dele({
          parent_tool_use_id: "pt-1",
          assistant_id: 3,
          assistant_name: "Reviewer",
        }),
      ],
      1
    )
    expect(env[0]).toMatchObject({
      assistant_id: 3,
      assistant_name: "Reviewer",
    })
  })

  it("passes the snapshot's task label + task id through to the seeded envelope", () => {
    const env = buildDelegationSeedEnvelopes(
      "parent-conn",
      [
        dele({
          parent_tool_use_id: "pt-1",
          task_preview: "执行 pnpm build",
          task_id: "task-uuid-3",
        }),
      ],
      1
    )
    expect(env[0]).toMatchObject({
      task_preview: "执行 pnpm build",
      task_id: "task-uuid-3",
    })
  })

  it("preserves order and emits one started envelope per delegation", () => {
    const env = buildDelegationSeedEnvelopes(
      "p",
      [
        dele({ parent_tool_use_id: "pt-a", child_conversation_id: 1 }),
        dele({ parent_tool_use_id: "pt-b", child_conversation_id: 2 }),
        dele({ parent_tool_use_id: "pt-c", child_conversation_id: 3 }),
      ],
      5
    )
    expect(env.map((e) => e.type)).toEqual([
      "delegation_started",
      "delegation_started",
      "delegation_started",
    ])
    expect(
      env.map((e) =>
        "parent_tool_use_id" in e ? e.parent_tool_use_id : undefined
      )
    ).toEqual(["pt-a", "pt-b", "pt-c"])
  })

  it("returns an empty array for no delegations", () => {
    expect(buildDelegationSeedEnvelopes("p", [], 0)).toEqual([])
  })
})

function remoteDele(
  overrides: Partial<ActiveRemoteDelegationState> & {
    parent_tool_use_id: string
    task_id: string
  }
): ActiveRemoteDelegationState {
  return {
    remote: {
      connection_id: 7,
      connection_name: "办公室 Mac mini",
      run_id: "run-abcdef123456",
      conversation_id: 512,
      link: "codeg://session/512",
      worktree: { path: "/repo/.worktrees/x", branch: "wt/x" },
    },
    status: "running",
    ...overrides,
  }
}

describe("buildRemoteDelegationSeedEnvelopes", () => {
  it("seeds remote_delegation_started with the remote task info, never local child ids", () => {
    const env = buildRemoteDelegationSeedEnvelopes(
      "parent-conn",
      [remoteDele({ parent_tool_use_id: "pt-1", task_id: "task-1" })],
      42
    )
    // 运行中的远程任务：只需 started（状态就是 running，不补 update）。
    expect(env).toHaveLength(1)
    expect(env[0]).toMatchObject({
      seq: 42,
      connection_id: "parent-conn",
      type: "remote_delegation_started",
      parent_connection_id: "parent-conn",
      parent_tool_use_id: "pt-1",
      task_id: "task-1",
      remote: {
        connection_id: 7,
        connection_name: "办公室 Mac mini",
        run_id: "run-abcdef123456",
        conversation_id: 512,
      },
    })
    // 远程派生的信封里没有本机 child_* 字段 —— 那正是「不误开本机会话」的根据。
    expect(env[0]).not.toHaveProperty("child_conversation_id")
    expect(env[0]).not.toHaveProperty("child_connection_id")
  })

  it("replays a blocked task as a started + updated pair so the card shows it waiting", () => {
    const env = buildRemoteDelegationSeedEnvelopes(
      "p",
      [
        remoteDele({
          parent_tool_use_id: "pt-1",
          task_id: "task-1",
          status: "blocked",
          blocked_on: "permission",
        }),
      ],
      7
    )
    expect(env.map((e) => e.type)).toEqual([
      "remote_delegation_started",
      "remote_delegation_updated",
    ])
    expect(env[1]).toMatchObject({
      task_id: "task-1",
      status: "blocked",
      blocked_on: "permission",
    })
  })

  it("replays an unreachable task as a started + updated pair (it is not terminal)", () => {
    const env = buildRemoteDelegationSeedEnvelopes(
      "p",
      [
        remoteDele({
          parent_tool_use_id: "pt-1",
          task_id: "task-1",
          status: "unreachable",
        }),
      ],
      1
    )
    expect(env.map((e) => e.type)).toEqual([
      "remote_delegation_started",
      "remote_delegation_updated",
    ])
    expect(env[1]).toMatchObject({ status: "unreachable" })
  })

  it("replays a finished task as started + completed with its result preview", () => {
    const env = buildRemoteDelegationSeedEnvelopes(
      "p",
      [
        remoteDele({
          parent_tool_use_id: "pt-1",
          task_id: "task-1",
          status: "failed",
          error_code: "remote_run_lost",
          duration_ms: 1234,
        }),
      ],
      1
    )
    expect(env.map((e) => e.type)).toEqual([
      "remote_delegation_started",
      "remote_delegation_completed",
    ])
    expect(env[1]).toMatchObject({
      task_id: "task-1",
      status: "failed",
      error_code: "remote_run_lost",
      duration_ms: 1234,
    })
  })

  it("returns an empty array when the snapshot carries none", () => {
    expect(buildRemoteDelegationSeedEnvelopes("p", [], 0)).toEqual([])
  })
})
