import { beforeEach, describe, expect, it } from "vitest"
import {
  conversationArchiveReason,
  setConversationsArchived,
} from "./conversation-archive"

const old = {
  id: 1,
  updated_at: "2020-01-01T00:00:00Z",
  pinned_at: null,
  status: "completed",
}
const now = Date.parse("2020-02-01T00:00:00Z")
const state = () => {
  const raw = JSON.parse(
    localStorage.getItem("workspace:archived-conversations:local") ?? "{}"
  )
  return {
    archived: new Set<number>(raw.archived ?? []),
    restored: new Set<number>(raw.restored ?? []),
  }
}
beforeEach(() => localStorage.clear())

describe("会话归档偏好", () => {
  it("超过 3 天自动归档，手动恢复可覆盖，不改会话状态", () => {
    expect(conversationArchiveReason(old, now, state())).toBe("auto")
    setConversationsArchived([1], false)
    expect(conversationArchiveReason(old, now, state())).toBeNull()
  })
  it("手动归档优先于恢复，区分自动归档", () => {
    const recent = { ...old, updated_at: "2020-01-31T12:00:00Z" }
    expect(conversationArchiveReason(recent, now, state())).toBeNull()
    setConversationsArchived([1], true)
    expect(conversationArchiveReason(recent, now, state())).toBe("manual")
    setConversationsArchived([1], false)
    expect(conversationArchiveReason(recent, now, state())).toBeNull()
  })
  it("置顶与运行中不会自动归档", () => {
    expect(
      conversationArchiveReason({ ...old, pinned_at: "x" }, now, state())
    ).toBeNull()
    expect(
      conversationArchiveReason({ ...old, status: "in_progress" }, now, state())
    ).toBeNull()
  })
})
