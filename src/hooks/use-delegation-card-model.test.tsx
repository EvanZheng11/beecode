import { renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { useDelegationCardModel } from "./use-delegation-card-model"

vi.mock("@/hooks/use-delegated-sub-session", () => ({
  useDelegatedSubSession: () => ({ binding: undefined, detail: null }),
}))

vi.mock("@/contexts/acp-connections-context", async () => {
  const actual = await vi.importActual<
    typeof import("@/contexts/acp-connections-context")
  >("@/contexts/acp-connections-context")
  return {
    ...actual,
    useConnectionStore: () => ({
      subscribeKey: () => () => {},
      getConnection: () => undefined,
    }),
  }
})

const REMOTE = {
  connection_name: "办公室 Mac mini",
  run_id: "run-abcdef123456",
  conversation_id: 512,
}

function model(source: Parameters<typeof useDelegationCardModel>[0]) {
  return renderHook(() => useDelegationCardModel(source)).result.current
}

describe("useDelegationCardModel: 远程卡片的冷加载", () => {
  it("meta 只有机器名（连接已删除）：保留远程身份，连接 id 为 null", () => {
    const m = model({
      parentToolUseId: "pt-1",
      input: "{}",
      state: "output-available",
      meta: {
        "codeg.delegation": {
          status: "canceled",
          error_code: "remote_cancel_unconfirmed",
          remote: REMOTE,
        },
      },
    })
    expect(m.remote).toMatchObject({
      connectionId: null,
      connectionName: "办公室 Mac mini",
      status: "canceled",
      errorCode: "remote_cancel_unconfirmed",
    })
    // 远程任务没有本机子会话，任何按 child 查本机的路径都落空。
    expect(m.childConnectionId).toBeNull()
    expect(m.childConversationId).toBeNull()
  })

  it("实时/报告来源把已删除的连接写成 0：归 null，不伪造连接 id", () => {
    const m = model({
      parentToolUseId: "pt-1",
      input: "{}",
      state: "output-available",
      output: JSON.stringify({
        status: "canceled",
        task_id: "task-1",
        remote: { connection_id: 0, ...REMOTE },
      }),
    })
    expect(m.remote?.connectionId).toBeNull()
    expect(m.remote?.connectionName).toBe("办公室 Mac mini")
  })

  it("冷加载的 text_preview 成为结果预览，实时预览优先", () => {
    const meta = {
      "codeg.delegation": {
        status: "completed",
        text_preview: "历史结果预览",
        remote: { connection_id: 7, ...REMOTE },
      },
    }
    expect(
      model({ parentToolUseId: "pt-1", input: "{}", meta }).remote
        ?.resultPreview
    ).toBe("历史结果预览")
  })

  it("meta 没有 text_preview 时结果预览为空", () => {
    const m = model({
      parentToolUseId: "pt-1",
      input: "{}",
      meta: {
        "codeg.delegation": {
          status: "running",
          remote: { connection_id: 7, ...REMOTE },
        },
      },
    })
    expect(m.remote?.resultPreview).toBeNull()
  })
})
