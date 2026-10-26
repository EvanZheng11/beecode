/**
 * pi 原生 `subagent` 扩展派发的子任务：读它带着的记录，折成卡片能画的 part。
 *
 * pi 的子任务跑在 `pi --mode json -p --no-session` 的一次性进程里 —— 磁盘上
 * 没有可以打开的会话，子任务的对话只存在于工具结果的 `details.results[].messages`
 * 里（扩展的 `SubagentDetails`）。所以「看见第二层」唯一的路就是读这份记录：
 *
 * - 历史：Rust 解析器把 `details` 归一化后放在 `agent_stats.subagent`
 *   （`parsers::pi::subagent_details`）；
 * - 实时：`connection.rs::stamp_pi_subagent_meta` 从 ACP `rawOutput` 的同一份
 *   `details` 取，挂在 `_meta.piSubagent` 上。
 *
 * 两条链路交给这里的是同一种形状，因此这里只需要一份映射：子任务自己的正文/
 * 思考/工具调用 → `AdaptedContentPart`，其中再派发 `subagent` 的那次调用把它的
 * 记录一起挂上来，递归下去就是任意层级。
 */

import type {
  AdaptedContentPart,
  AdaptedToolCallPart,
} from "@/lib/adapters/ai-elements-adapter"
import type { SubagentBlock, SubagentDetails, SubagentRun } from "@/lib/types"

/** 标题行里描述一个子任务时，任务原文截到这里为止。 */
const DESCRIPTION_CHARS = 120

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function optionalStr(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/**
 * 校验并归一化一份 `SubagentDetails`。接受 live `_meta.piSubagent`（未受信任的
 * 代理 JSON）与历史 `agent_stats.subagent` 两种来源。
 *
 * `runs` 为空的记录一律当作「没有详情」：扩展在参数非法 / 用户取消派生时也会回
 * 一份 `details`，那种记录画出来只会是一张空壳，不如让卡片退回结果摘要。
 */
export function parseSubagentDetails(value: unknown): SubagentDetails | null {
  if (!isRecord(value)) return null
  const mode = str(value.mode)
  if (!mode) return null
  const rawRuns = Array.isArray(value.runs) ? value.runs : []
  const runs = rawRuns
    .map(parseRun)
    .filter((run): run is SubagentRun => run !== null)
  return runs.length > 0 ? { mode, runs } : null
}

function parseRun(value: unknown): SubagentRun | null {
  if (!isRecord(value)) return null
  const agent = str(value.agent)
  if (!agent) return null
  const blocks = (Array.isArray(value.blocks) ? value.blocks : [])
    .map(parseBlock)
    .filter((block): block is SubagentBlock => block !== null)
  return {
    agent,
    task: typeof value.task === "string" ? value.task : "",
    model: optionalStr(value.model),
    step: num(value.step),
    stop_reason: optionalStr(value.stop_reason),
    error: optionalStr(value.error),
    is_error: value.is_error === true,
    running: value.running === true,
    blocks,
  }
}

function parseBlock(value: unknown): SubagentBlock | null {
  if (!isRecord(value)) return null
  if (value.type === "text" || value.type === "thinking") {
    const text = typeof value.text === "string" ? value.text : ""
    return text ? { type: value.type, text } : null
  }
  if (value.type !== "tool_use") return null
  const toolName = str(value.tool_name)
  if (!toolName) return null
  return {
    type: "tool_use",
    tool_name: toolName,
    input: optionalStr(value.input),
    output: optionalStr(value.output),
    is_error: value.is_error === true,
    settled: value.settled === true,
    subagent: parseSubagentDetails(value.subagent),
  }
}

/** 一次派发在工具输入里的样子（`subagent` 工具的 `{agent, task}` /
 *  `{tasks}` / `{chain}`）。详情还没到（或永远不到）时，卡片靠它给出标题。 */
export interface PiSubagentInvocation {
  agent: string | null
  task: string | null
  count: number
  mode: "single" | "parallel" | "chain"
}

/**
 * 从 `subagent` 工具的输入里读出这次派发。`null` 表示输入不像 pi 的
 * `subagent` 调用（别的智能体的 `agent`/`task` 字段不归这里解释）。
 */
export function piSubagentInvocation(
  parsed: Record<string, unknown> | null | undefined
): PiSubagentInvocation | null {
  if (!parsed) return null
  const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : []
  const chain = Array.isArray(parsed.chain) ? parsed.chain : []
  if (chain.length > 0) {
    const first = isRecord(chain[0]) ? chain[0] : {}
    return {
      agent: str(first.agent),
      task: str(first.task),
      count: chain.length,
      mode: "chain",
    }
  }
  if (tasks.length > 0) {
    const first = isRecord(tasks[0]) ? tasks[0] : {}
    return {
      agent: str(first.agent),
      task: str(first.task),
      count: tasks.length,
      mode: "parallel",
    }
  }
  const agent = str(parsed.agent)
  const task = str(parsed.task)
  if (!agent && !task) return null
  return { agent, task, count: 1, mode: "single" }
}

/** 任务原文 → 标题行用的一行描述（Agent 卡片标题里的 `description`）。 */
export function piTaskLine(text: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? ""
  return line.length > DESCRIPTION_CHARS
    ? `${line.slice(0, DESCRIPTION_CHARS)}…`
    : line
}

/**
 * 子任务的执行记录 → 可直接渲染的 part 列表。
 *
 * `single` 派发就是「这一次子任务」：直接铺开它的时间线 —— 再套一层卡片只会把
 * 同一个 agent 与任务画两遍。`parallel` / `chain` 是并列的几条子任务，每条各画
 * 一张 Agent 卡片，任务、状态与结果才好分辨。
 */
export function subagentParts(
  details: SubagentDetails,
  parentId: string
): AdaptedContentPart[] {
  if (details.runs.length === 0) return []
  if (details.mode === "single" && details.runs.length === 1) {
    return blocksToParts(details.runs[0].blocks, `${parentId}-pi`)
  }
  return details.runs.map((run, index) =>
    runPart(run, `${parentId}-pi-run-${index}`)
  )
}

/** 一条子任务 → 一张 Agent 卡片（复用现成的 Agent 行：标题、提示词、内部时间线
 *  与失败原因都已经在它那里）。内部记录挂在 `subagent` 上，卡片会照常递归。 */
function runPart(run: SubagentRun, id: string): AdaptedToolCallPart {
  return {
    type: "tool-call",
    toolCallId: id,
    toolName: "agent",
    input: JSON.stringify({
      subagent_type: run.agent,
      description: piTaskLine(run.task),
      prompt: run.task,
      ...(run.model ? { model: run.model } : {}),
    }),
    state: run.running
      ? "input-available"
      : run.is_error
        ? "output-error"
        : "output-available",
    // 结果留在时间线里（它的最后一条消息就是结果），这里不再重复一份。
    output: null,
    errorText: run.is_error ? (run.error ?? undefined) : undefined,
    subagent: { mode: "single", runs: [run] },
  }
}

/** 子任务自己的流水 → part 列表。工具调用按 `settled` 区分「还在跑」与「已完成」，
 *  否则一个还没返回结果的下级工具会被画成打勾。 */
function blocksToParts(
  blocks: SubagentBlock[],
  parentId: string
): AdaptedContentPart[] {
  const parts: AdaptedContentPart[] = []
  blocks.forEach((block, index) => {
    const key = `${parentId}-b${index}`
    switch (block.type) {
      case "text":
        if (block.text.trim()) parts.push({ type: "text", text: block.text })
        break
      case "thinking":
        if (block.text.trim()) {
          parts.push({
            type: "reasoning",
            content: block.text,
            isStreaming: false,
          })
        }
        break
      case "tool_use": {
        const output = block.output ?? null
        parts.push({
          type: "tool-call",
          toolCallId: key,
          toolName: block.tool_name,
          input: block.input ?? null,
          state: !block.settled
            ? "input-available"
            : block.is_error
              ? "output-error"
              : "output-available",
          output,
          errorText: block.is_error ? (output ?? undefined) : undefined,
          ...(block.subagent ? { subagent: block.subagent } : {}),
        })
        break
      }
    }
  })
  return parts
}

/**
 * 子任务最后说的一段话（它自己的结果）。折叠状态下卡片的摘要行用它 —— 详情在
 * 时结果已经画在时间线里，外层不再重复渲染一份结果。
 */
export function subagentLastText(details: SubagentDetails): string | null {
  for (let run = details.runs.length - 1; run >= 0; run -= 1) {
    const blocks = details.runs[run]!.blocks
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const block = blocks[index]!
      if (block.type === "text" && block.text.trim()) return block.text
    }
  }
  return null
}
