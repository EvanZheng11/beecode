import { describe, expect, it } from "vitest"
import {
  CONVERSATION_AUTO_ARCHIVE_AFTER_MS,
  isConversationAutoArchived,
} from "@/lib/conversation-auto-archive"

const now = Date.parse("2026-11-04T12:00:00.000Z")
const conversation = (updatedAt: number) => ({
  updated_at: new Date(updatedAt).toISOString(),
  pinned_at: null,
})

describe("isConversationAutoArchived", () => {
  it("仅在超过 72 小时后归档", () => {
    const threshold = now - CONVERSATION_AUTO_ARCHIVE_AFTER_MS
    expect(isConversationAutoArchived(conversation(threshold + 1), now)).toBe(
      false
    )
    expect(isConversationAutoArchived(conversation(threshold), now)).toBe(false)
    expect(isConversationAutoArchived(conversation(threshold - 1), now)).toBe(
      true
    )
    expect(isConversationAutoArchived(conversation(0), now)).toBe(true)
  })

  it("不归档运行中或置顶的旧会话", () => {
    const old = conversation(0)
    expect(isConversationAutoArchived(old, now, true)).toBe(false)
    expect(isConversationAutoArchived({ ...old, pinned_at: "" }, now)).toBe(
      false
    )
  })

  it("不归档无效或未来的日期", () => {
    expect(
      isConversationAutoArchived(
        { updated_at: "invalid", pinned_at: null },
        now
      )
    ).toBe(false)
    expect(isConversationAutoArchived(conversation(now + 1), now)).toBe(false)
  })

  it("按时间带解析更新时间", () => {
    expect(
      isConversationAutoArchived(
        { updated_at: "2026-11-01T19:59:59.999+08:00", pinned_at: null },
        now
      )
    ).toBe(true)
    expect(
      isConversationAutoArchived(
        { updated_at: "2026-11-01T20:00:00+08:00", pinned_at: null },
        now
      )
    ).toBe(false)
  })

  it("重新更新后不再归档", () => {
    const old = conversation(0)
    expect(isConversationAutoArchived(old, now)).toBe(true)
    expect(
      isConversationAutoArchived(
        { ...old, updated_at: new Date(now).toISOString() },
        now
      )
    ).toBe(false)
  })
})
