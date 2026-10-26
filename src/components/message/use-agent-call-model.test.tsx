import type { ReactElement, ReactNode } from "react"
import { renderHook } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { AdaptedToolCallPart } from "@/lib/adapters/ai-elements-adapter"
import type { AgentExecutionStats, SubagentDetails } from "@/lib/types"
import { useAgentCallModel } from "./use-agent-call-model"

function wrapper({ children }: { children: ReactNode }): ReactElement {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {children}
    </NextIntlClientProvider>
  )
}

function part(
  overrides: Partial<AdaptedToolCallPart> = {}
): AdaptedToolCallPart {
  return {
    type: "tool-call",
    toolCallId: "pi_1",
    toolName: "subagent",
    input: JSON.stringify({
      agent: "general-executor",
      task: "Find the parser tests",
    }),
    state: "output-available",
    output: "Found it.",
    ...overrides,
  }
}

const singleRun: SubagentDetails = {
  mode: "single",
  runs: [
    {
      agent: "general-executor",
      task: "Find the parser tests",
      model: "myhome/deepseek-v4.1-flash",
      is_error: false,
      running: false,
      blocks: [
        { type: "text", text: "PI_CHILD_PROSE" },
        {
          type: "tool_use",
          tool_name: "bash",
          input: JSON.stringify({ command: "rg -n PI_CHILD_COMMAND" }),
          output: "src/parsers/pi.rs",
          is_error: false,
          settled: true,
        },
      ],
    },
  ],
}

function renderModel(p: AdaptedToolCallPart) {
  return renderHook(() => useAgentCallModel(p), { wrapper })
}

describe("useAgentCallModel: pi's native subagent", () => {
  it("reads the record history carries on agent_stats", () => {
    const stats: AgentExecutionStats = { subagent: singleRun }
    const { result } = renderModel(part({ agentStats: stats }))

    // 标题用子任务实际的 agent；它的任务就是标题行后面的灰色提示词。
    expect(result.current.subagentType).toBe("general-executor")
    expect(result.current.description).toBeNull()
    expect(result.current.prompt).toBe("Find the parser tests")
    expect(result.current.piSubagent?.runs[0]?.agent).toBe("general-executor")
    // single 派发直接把唯一一条铺开，不再套一层卡片。
    expect(result.current.piSubagentParts.map((p) => p.type)).toEqual([
      "text",
      "tool-call",
    ])
    // 折叠状态的摘要就是子任务最后说的那句话；外层不再重复渲染结果。
    expect(result.current.piSummary).toBe("PI_CHILD_PROSE")
  })

  it("reads the same record from the live `_meta.piSubagent`", () => {
    const { result } = renderModel(
      part({ meta: { piSubagent: singleRun }, output: null })
    )

    expect(result.current.piSubagent?.mode).toBe("single")
    expect(result.current.piSubagentParts).toHaveLength(2)
    expect(result.current.subagentType).toBe("general-executor")
  })

  it("falls back to the dispatch input when the record never arrives", () => {
    const { result } = renderModel(part({ agentStats: null, meta: null }))

    expect(result.current.piSubagent).toBeNull()
    expect(result.current.piSubagentParts).toEqual([])
    expect(result.current.piSummary).toBeNull()
    // 标题与提示词仍然读得出来，卡片不会停在「子智能体启动中…」。
    expect(result.current.subagentType).toBe("general-executor")
    expect(result.current.prompt).toBe("Find the parser tests")
    expect(result.current.title).toBe("general-executor")
  })

  it("labels a multi-child dispatch by count instead of borrowing one child's task", () => {
    const { result } = renderModel(
      part({
        input: JSON.stringify({
          chain: [
            { agent: "general-executor", task: "first" },
            { agent: "reviewer", task: "then {previous}" },
          ],
        }),
        agentStats: {
          subagent: {
            mode: "chain",
            runs: [
              singleRun.runs[0]!,
              {
                agent: "reviewer",
                task: "then {previous}",
                is_error: false,
                running: true,
                blocks: [],
              },
            ],
          },
        },
      })
    )

    expect(result.current.subagentType).toBeNull()
    expect(result.current.description).toBe("2-step chain")
    expect(result.current.prompt).toBeNull()
    // 每条子任务一张卡片，正文由各自的记录铺开。
    expect(result.current.piSubagentParts).toHaveLength(2)
    expect(
      result.current.piSubagentParts.map((p) =>
        p.type === "tool-call" ? p.toolName : p.type
      )
    ).toEqual(["agent", "agent"])
  })

  it("ignores a record that cannot be drawn (unknown shape)", () => {
    const { result } = renderModel(
      part({ meta: { piSubagent: { mode: "swarm", runs: [] } } })
    )
    expect(result.current.piSubagent).toBeNull()
    expect(result.current.piSubagentParts).toEqual([])
  })
})
