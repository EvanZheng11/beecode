import { act, cleanup, renderHook } from "@testing-library/react"
import { NextIntlClientProvider, useTranslations } from "next-intl"
import type { Locale } from "next-intl"
import type { ReactNode } from "react"
import { afterEach, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn().mockResolvedValue(undefined),
  status: null as string | null,
}))
vi.mock("@/contexts/acp-connections-context", () => {
  // 生命周期卸载清理会调用 `releaseActiveKey`（use-connection-lifecycle.ts:448），
  // 缺它会抛 "not a function" 并使 afterEach 的 cleanup 中断，连带污染下一条用例的
  // connect 调用计数。
  const actions = {
    setActiveKey: vi.fn(),
    releaseActiveKey: vi.fn(),
    touchActivity: vi.fn(),
  }
  return { useAcpActions: () => actions }
})
vi.mock("@/contexts/task-context", () => {
  const actions = {
    addTask: vi.fn(),
    updateTask: vi.fn(),
    removeTask: vi.fn(),
  }
  return { useTaskContext: () => actions }
})
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }))
vi.mock("@/lib/custom-agents", () => ({ getAgentLabel: () => "OpenCode" }))
vi.mock("@/hooks/use-connection", () => ({
  useConnection: () => ({
    status: h.status,
    agentType: "open_code",
    connectError: null,
    selectorsReady: true,
    hasCachedSelectors: false,
    connect: h.connect,
    disconnect: h.disconnect,
    modes: null,
    configOptions: null,
    isViewer: false,
    backgroundOutstanding: 0,
    // `isConnectionBusy`（src/lib/connection-teardown.ts）按 `ConnectionWork`
    // 全量判定卸载是否可断开，这三项缺一会让卸载清理抛错，故按真实契约给空值。
    asyncTasks: [],
    remoteControl: null,
    delegatedChildren: [],
  }),
}))

import { useConnectionLifecycle } from "./use-connection-lifecycle"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  h.connect.mockReset()
  h.disconnect.mockClear()
})

it.each([
  [new Error("fixture-error"), "fixture-error", "fixture-error"],
  [{ unexpected: "not-for-display" }, "Connection failed", "连接失败"],
])(
  "切换语言只更新错误文案，不重试连接 %#",
  async (error, initial, translated) => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    h.status = null
    h.connect.mockRejectedValue(error)
    // `Locale` 是 next-intl 的 AppConfig 收窄联合类型（见 src/i18n/global.d.ts），
    // 显式标注避免 `let` 推导成 string 后赋给 provider 的 locale 触发 TS2322。
    let locale: Locale = "en"
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <NextIntlClientProvider
          locale={locale}
          messages={{
            Folder: {
              chat: {
                connectionLifecycle: {
                  errors: {
                    connectionFailed:
                      locale === "en" ? "Connection failed" : "连接失败",
                  },
                },
              },
            },
          }}
          timeZone="UTC"
        >
          {children}
        </NextIntlClientProvider>
      )
    }
    const { result, rerender } = renderHook(
      () => ({
        t: useTranslations("Folder.chat.connectionLifecycle"),
        lifecycle: useConnectionLifecycle({
          contextKey: "locale-fixture",
          agentType: "open_code",
          workingDir: "/tmp/locale-fixture",
          isActive: true,
        }),
      }),
      { wrapper: Wrapper }
    )
    await act(async () => {})
    expect(result.current.lifecycle.autoConnectError).toBe(initial)
    expect(h.connect).toHaveBeenCalledTimes(1)
    const firstT = result.current.t
    locale = "zh-CN"
    h.status = "error"
    rerender()
    await act(async () => {})
    expect(result.current.t).not.toBe(firstT)
    expect(result.current.lifecycle.autoConnectError).toBe(translated)
    expect(h.connect).toHaveBeenCalledTimes(1)
    expect(h.disconnect).not.toHaveBeenCalled()
  }
)
