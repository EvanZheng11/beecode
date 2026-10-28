import { describe, expect, it } from "vitest"

import {
  formatQuestionCountdown,
  questionDeadlineMs,
} from "@/lib/question-deadline"

describe("questionDeadlineMs", () => {
  it("解析后端 RFC3339 UTC 时间", () => {
    expect(questionDeadlineMs("2026-01-01T00:05:00Z")).toBe(
      Date.UTC(2026, 0, 1, 0, 5, 0)
    )
  })

  it("缺失、空串和非法时间都视为没有期限", () => {
    // 原生 agent 的提问不带 expires_at，绝不能因此显示倒计时。
    expect(questionDeadlineMs(undefined)).toBeNull()
    expect(questionDeadlineMs(null)).toBeNull()
    expect(questionDeadlineMs("")).toBeNull()
    expect(questionDeadlineMs("not-a-date")).toBeNull()
  })
})

describe("formatQuestionCountdown", () => {
  it("按分:秒补零，与设计稿的 04:32 一致", () => {
    expect(formatQuestionCountdown(4 * 60_000 + 32_000)).toBe("04:32")
    expect(formatQuestionCountdown(59_000)).toBe("00:59")
  })

  it("向下取整，负数按 00:00 处理", () => {
    expect(formatQuestionCountdown(1_500)).toBe("00:01")
    expect(formatQuestionCountdown(-5_000)).toBe("00:00")
  })

  it("超过 99 分钟不截断分钟位", () => {
    expect(formatQuestionCountdown(100 * 60_000)).toBe("100:00")
  })
})
