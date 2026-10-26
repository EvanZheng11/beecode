import { describe, expect, it } from "vitest"

import type {
  AdaptedContentPart,
  AdaptedToolCallPart,
} from "@/lib/adapters/ai-elements-adapter"
import type { SubagentBlock, SubagentDetails, SubagentRun } from "@/lib/types"
import {
  parseSubagentDetails,
  piSubagentInvocation,
  piTaskLine,
  subagentLastText,
  subagentParts,
} from "./pi-subagent"

/** 一条子任务记录，字段同 Rust `parsers::pi::subagent_run` 归一化后的样子。 */
function run(o: {
  agent?: string
  task?: string
  model?: string | null
  running?: boolean
  isError?: boolean
  error?: string | null
  blocks?: SubagentBlock[]
}): SubagentRun {
  return {
    agent: o.agent ?? "general-executor",
    task: o.task ?? "Find the parser tests",
    model: o.model ?? null,
    is_error: o.isError === true,
    running: o.running === true,
    error: o.error ?? null,
    blocks: o.blocks ?? [],
  }
}

function text(value: string): SubagentBlock {
  return { type: "text", text: value }
}

function toolUse(o: {
  name?: string
  input?: string | null
  output?: string | null
  isError?: boolean
  settled?: boolean
  subagent?: SubagentDetails | null
}): SubagentBlock {
  return {
    type: "tool_use",
    tool_name: o.name ?? "bash",
    input: o.input ?? '{"command":"rg -n pi.rs"}',
    output: o.output ?? null,
    is_error: o.isError === true,
    settled: o.settled === true,
    subagent: o.subagent ?? null,
  }
}

function toolParts(parts: AdaptedContentPart[]): AdaptedToolCallPart[] {
  return parts.filter(
    (part): part is AdaptedToolCallPart => part.type === "tool-call"
  )
}

/** `parseSubagentDetails` 吃的是 JSON，构造时只给形状（不经类型系统）。 */
function jsonRun(o: {
  agent?: string
  task?: string
  blocks?: unknown[]
}): Record<string, unknown> {
  return {
    agent: o.agent ?? "general-executor",
    task: o.task ?? "Find the parser tests",
    model: "myhome/deepseek-v4.1-flash",
    is_error: false,
    running: false,
    error: null,
    blocks: o.blocks ?? [],
  }
}

describe("parseSubagentDetails", () => {
  it("keeps the child's own timeline and refuses records with nothing in them", () => {
    const details = parseSubagentDetails({
      mode: "single",
      runs: [jsonRun({ blocks: [{ type: "text", text: "Searching now." }] })],
    })
    expect(details?.mode).toBe("single")
    expect(details?.runs[0]?.blocks).toEqual([
      { type: "text", text: "Searching now." },
    ])

    // 扩展在参数非法 / 用户取消派生时也回一份 details，但 results 是空的 ——
    // 空壳画出来只会挡住真正的结果摘要。
    expect(parseSubagentDetails({ mode: "single", runs: [] })).toBeNull()
    expect(parseSubagentDetails({ runs: [jsonRun({})] })).toBeNull()
    expect(parseSubagentDetails(null)).toBeNull()
    expect(parseSubagentDetails([jsonRun({})])).toBeNull()
    expect(parseSubagentDetails("nope")).toBeNull()
  })

  it("drops a malformed block but keeps the run it belongs to", () => {
    const details = parseSubagentDetails({
      mode: "parallel",
      runs: [
        jsonRun({
          blocks: [
            { type: "text", text: "kept" },
            { type: "text" }, // 没有 text
            { type: "tool_use" }, // 没有 tool_name
            { type: "mystery", text: "x" },
          ],
        }),
      ],
    })
    expect(details?.runs[0]?.blocks).toEqual([{ type: "text", text: "kept" }])
  })
})

describe("piSubagentInvocation", () => {
  it("reads all three dispatch shapes", () => {
    expect(piSubagentInvocation({ agent: "a", task: "do it" })).toEqual({
      agent: "a",
      task: "do it",
      count: 1,
      mode: "single",
    })
    expect(
      piSubagentInvocation({
        tasks: [
          { agent: "a", task: "first" },
          { agent: "b", task: "second" },
        ],
      })
    ).toEqual({ agent: "a", task: "first", count: 2, mode: "parallel" })
    expect(
      piSubagentInvocation({
        chain: [
          { agent: "a", task: "first" },
          { agent: "b", task: "then {previous}" },
        ],
      })
    ).toEqual({ agent: "a", task: "first", count: 2, mode: "chain" })
  })

  it("does not claim inputs that are not a subagent dispatch", () => {
    expect(piSubagentInvocation({})).toBeNull()
    expect(piSubagentInvocation({ path: "/a" })).toBeNull()
    expect(piSubagentInvocation(null)).toBeNull()
  })
})

describe("subagentParts", () => {
  it("lays a single child's own steps out in arrival order", () => {
    const details: SubagentDetails = {
      mode: "single",
      runs: [
        run({
          blocks: [
            { type: "thinking", text: "look for pi.rs" },
            text("Searching now."),
            toolUse({
              input: '{"command":"rg -n pi.rs"}',
              output: "src/parsers/pi.rs",
              settled: true,
            }),
          ],
        }),
      ],
    }

    const parts = subagentParts(details, "outer")

    expect(parts.map((part) => part.type)).toEqual([
      "reasoning",
      "text",
      "tool-call",
    ])
    const [bash] = toolParts(parts)
    expect(bash).toMatchObject({
      toolName: "bash",
      input: '{"command":"rg -n pi.rs"}',
      output: "src/parsers/pi.rs",
      state: "output-available",
    })
  })

  it("carries a nested dispatch's own record so the card can recurse", () => {
    const nested: SubagentDetails = {
      mode: "single",
      runs: [
        run({
          agent: "reviewer",
          task: "Review the change",
          blocks: [
            text("Reviewed."),
            toolUse({
              name: "read",
              input: '{"path":"/a"}',
              output: "file body",
              settled: true,
            }),
          ],
        }),
      ],
    }
    const details: SubagentDetails = {
      mode: "single",
      runs: [
        run({
          blocks: [
            toolUse({
              name: "subagent",
              input: '{"agent":"reviewer","task":"Review the change"}',
              output: "LGTM",
              settled: true,
              subagent: nested,
            }),
          ],
        }),
      ],
    }

    const parts = subagentParts(details, "outer")

    const [call] = toolParts(parts)
    expect(call?.toolName).toBe("subagent")
    // 下级记录原样带在 part 上，Agent 卡片再把它铺成第二层。
    expect(call?.subagent?.runs[0]?.agent).toBe("reviewer")
    const secondLevel = subagentParts(call!.subagent!, "outer-b0")
    expect(secondLevel.map((part) => part.type)).toEqual(["text", "tool-call"])
    expect(toolParts(secondLevel)[0]).toMatchObject({
      toolName: "read",
      output: "file body",
      state: "output-available",
    })
  })

  it("draws one Agent card per child for parallel and chain dispatches", () => {
    for (const mode of ["parallel", "chain"] as const) {
      const details: SubagentDetails = {
        mode,
        runs: [
          run({
            task: "First task\nwith a second line",
            model: "myhome/deepseek-v4.1-flash",
            running: true,
          }),
          run({
            agent: "reviewer",
            task: "Second task",
            isError: true,
            error: "boom",
          }),
        ],
      }

      const cards = toolParts(subagentParts(details, `outer-${mode}`))
      expect(cards).toHaveLength(2)
      // 复用现成的 Agent 卡片：标题/提示词都从合成出来的输入里读。
      expect(cards.map((card) => card.toolName)).toEqual(["agent", "agent"])
      expect(JSON.parse(cards[0]!.input!)).toMatchObject({
        subagent_type: "general-executor",
        description: "First task",
        prompt: "First task\nwith a second line",
        model: "myhome/deepseek-v4.1-flash",
      })
      // 还在跑的那条是运行态、没有结果；失败的那条带原因。两条都不在卡片底部
      // 重复渲染一份结果（结果留在它自己的时间线里）。
      expect(cards[0]!.state).toBe("input-available")
      expect(cards[0]!.output).toBeNull()
      expect(cards[1]!.state).toBe("output-error")
      expect(cards[1]!.errorText).toBe("boom")
      // 每条卡片自己带着「这一次子任务」的记录，正文由它铺开。
      expect(cards[0]!.subagent?.runs[0]?.agent).toBe("general-executor")
    }
  })

  it("marks a not-yet-settled child tool as running instead of done", () => {
    const details: SubagentDetails = {
      mode: "single",
      runs: [
        run({
          task: "Wait for the command",
          running: true,
          blocks: [
            toolUse({
              input: '{"command":"sleep 30"}',
              output: null,
              settled: false,
            }),
          ],
        }),
      ],
    }
    const [call] = toolParts(subagentParts(details, "outer"))
    expect(call?.state).toBe("input-available")
    expect(call?.output).toBeNull()
  })

  it("returns nothing when there are no runs to draw", () => {
    expect(subagentParts({ mode: "single", runs: [] }, "outer")).toEqual([])
  })
})

describe("subagentLastText", () => {
  it("uses the last thing the last child said", () => {
    expect(
      subagentLastText({
        mode: "parallel",
        runs: [
          run({
            agent: "a",
            task: "first",
            blocks: [text("first result"), text("first follow-up")],
          }),
          run({
            agent: "b",
            task: "second",
            blocks: [text("second result")],
          }),
        ],
      })
    ).toBe("second result")
    expect(
      subagentLastText({
        mode: "single",
        runs: [
          run({
            task: "only tools",
            blocks: [toolUse({ settled: true, output: "no prose" })],
          }),
        ],
      })
    ).toBeNull()
  })
})

describe("piTaskLine", () => {
  it("takes the first line and caps a long one", () => {
    expect(piTaskLine("  first line\nsecond line")).toBe("first line")
    expect(piTaskLine("x".repeat(400))).toHaveLength(121)
  })
})
