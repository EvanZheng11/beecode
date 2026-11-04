import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  saveQuickMessagesVisible,
  useQuickMessagesVisible,
} from "./quick-messages-prefs"

beforeEach(() => {
  window.localStorage.clear()
  saveQuickMessagesVisible(false)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  saveQuickMessagesVisible(false)
})

describe("快捷消息显示偏好", () => {
  it("默认关闭，切换同步多个输入框并持久保存", () => {
    const first = renderHook(useQuickMessagesVisible)
    const second = renderHook(useQuickMessagesVisible)
    expect(first.result.current).toBe(false)
    act(() => saveQuickMessagesVisible(true))
    expect(first.result.current).toBe(true)
    expect(second.result.current).toBe(true)
    expect(window.localStorage.getItem("workspace:show-quick-messages")).toBe(
      "true"
    )
    first.unmount()
    expect(renderHook(useQuickMessagesVisible).result.current).toBe(true)
  })

  it("响应其他窗口修改与清空", () => {
    const { result } = renderHook(useQuickMessagesVisible)
    act(() => {
      window.localStorage.setItem("workspace:show-quick-messages", "true")
      window.dispatchEvent(
        new StorageEvent("storage", { key: "workspace:show-quick-messages" })
      )
    })
    expect(result.current).toBe(true)
    act(() => {
      window.localStorage.clear()
      window.dispatchEvent(new StorageEvent("storage", { key: null }))
    })
    expect(result.current).toBe(false)
  })

  it("存储不可用时仍能在当前窗口切换", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("不可写")
    })
    const { result } = renderHook(useQuickMessagesVisible)
    act(() => saveQuickMessagesVisible(true))
    expect(result.current).toBe(true)
    act(() => saveQuickMessagesVisible(false))
    expect(result.current).toBe(false)
  })
})
