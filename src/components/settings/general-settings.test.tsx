import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

// Shared by the module mock and by `shellsResolving` below, so a test that
// re-stubs the call can vary the resolved shell without restating the rows.
// `vi.hoisted` because the `vi.mock` factory is lifted above every plain
// `const` in this file.
const shellOptions = vi.hoisted(() => [
  {
    id: "system",
    label_key: "terminalSystemDefault",
    value: null,
    exists: true,
    accepts_custom_path: false,
  },
  {
    id: "custom",
    label_key: "terminalShellCustom",
    value: null,
    exists: true,
    accepts_custom_path: true,
  },
])

vi.mock("@/lib/api", () => ({
  getSystemTerminalSettings: vi.fn(async () => ({
    default_shell: null,
    colorize_command_output: false,
  })),
  getAvailableTerminalShells: vi.fn(async () => ({
    resolved_shell: "/bin/zsh",
    options: shellOptions,
  })),
  getSystemRenderingSettings: vi.fn(async () => ({
    disable_hardware_acceleration: false,
  })),
  updateSystemRenderingSettings: vi.fn(async (v: unknown) => v),
  updateSystemTerminalSettings: vi.fn(async (v: unknown) => v),
  probeTerminalShellPath: vi.fn(async () => true),
  // 提问配置带 MCP 等待策略，读取和保存都走整条记录（默认 10 分钟 / 3 次 / 开启）。
  getQuestionSettings: vi.fn(async () => ({
    enabled: true,
    wait_timeout_minutes: 10,
    retry_count: 3,
    auto_select_first_on_timeout: true,
  })),
  updateQuestionPolicy: vi.fn(
    async (v: {
      wait_timeout_minutes: number
      retry_count: number
      auto_select_first_on_timeout: boolean
    }) => ({
      enabled: true,
      ...v,
    })
  ),
  getSystemCloseBehaviorSettings: vi.fn(async () => ({
    behavior: "ask" as const,
    tray_available: true,
  })),
  updateSystemCloseBehaviorSettings: vi.fn(async (behavior: string) => ({
    behavior,
    tray_available: true,
  })),
}))

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

// 事件订阅：把提问记录的广播处理器按事件名存下来，用例才能演"另一个窗口（agent-tools
// 面板）刚写过这条记录"。用 `vi.hoisted` 是因为 `vi.mock` 工厂会被提升到文件里每个
// 普通 `const` 之前。
const broadcasts = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>(),
  unsubscribe: vi.fn(),
  registration: null as Promise<() => void> | null,
}))
vi.mock("@/lib/platform", () => ({
  isDesktop: () => true,
  onTransportReconnect: vi.fn(() => null),
  subscribe: vi.fn((event: string, handler: (payload: unknown) => void) => {
    if (broadcasts.registration) {
      return broadcasts.registration.then((unsubscribe) => {
        broadcasts.handlers.set(event, handler)
        return unsubscribe
      })
    }
    broadcasts.handlers.set(event, handler)
    return Promise.resolve(broadcasts.unsubscribe)
  }),
}))

/** 本页订阅的提问记录广播，由用例手动触发。 */
const questionHandler = () =>
  broadcasts.handlers.get("question-settings://changed")
vi.mock("@/lib/transport", () => ({
  getActiveRemoteConnectionId: () => null,
  // Read by the desktop-notification section to decide whether permission is
  // the browser's to grant or the OS's; `false` puts it on the browser branch,
  // which is the one with visible controls to assert on.
  isDesktop: () => false,
  getShellTransport: () => ({ call: vi.fn() }),
}))
// The rendering section is gated on the host webview having an env knob to
// flip, so the platform has to be steerable per test. `vi.hoisted` because the
// `vi.mock` factory is lifted above every plain `const` in this file.
const platform = vi.hoisted(() => ({ current: "windows" as PlatformType }))
vi.mock("@/hooks/use-platform", () => ({
  usePlatform: () => ({
    platform: platform.current,
    isMac: platform.current === "macos",
    isWindows: platform.current === "windows",
    isLinux: platform.current === "linux",
  }),
}))
vi.mock("@/lib/updater", () => ({ relaunchApp: vi.fn() }))

import { toast } from "sonner"

import {
  getAvailableTerminalShells,
  getQuestionSettings,
  getSystemTerminalSettings,
  updateQuestionPolicy,
  updateSystemTerminalSettings,
} from "@/lib/api"
import { GeneralSettings } from "./general-settings"
import type { PlatformType } from "@/hooks/use-platform"
import enMessages from "@/i18n/messages/en.json"

function renderSettings() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <GeneralSettings />
    </NextIntlClientProvider>
  )
}

/** The options list as the backend returns it, resolving to `path`. */
function shellsResolving(path: string) {
  return { resolved_shell: path, options: shellOptions }
}

/**
 * The page is a stack of sections rendered through the shared
 * `SettingsSection` / `SettingCard` / `SettingRow` grammar, so what is worth
 * pinning is the wiring that grammar carries: every row's label resolves to the
 * control it names (a `SettingRow` with the `htmlFor` left off still looks
 * right and silently loses the association), and each section actually mounts.
 */
describe("GeneralSettings", () => {
  beforeEach(() => {
    platform.current = "windows"
    vi.mocked(getQuestionSettings).mockClear()
    vi.mocked(getQuestionSettings).mockImplementation(async () => ({
      enabled: true,
      wait_timeout_minutes: 10,
      retry_count: 3,
      auto_select_first_on_timeout: true,
    }))
    vi.mocked(updateQuestionPolicy).mockClear()
    vi.mocked(updateQuestionPolicy).mockImplementation(async (v) => ({
      enabled: true,
      ...v,
    }))
    // 处理器属于已经卸载的那次渲染，不该留给下一个用例。
    broadcasts.handlers.clear()
    broadcasts.registration = null
  })

  it("mounts every section and wires each row's label to its control", async () => {
    renderSettings()

    // Terminal section: the heading itself names the picker.
    const shell = await screen.findByLabelText("Default Terminal")
    expect(shell).toBeInTheDocument()
    expect(screen.getByText("Currently using: /bin/zsh")).toBeInTheDocument()

    // Rendering section: checkbox → Switch.
    const hwAccel = screen.getByLabelText("Disable hardware acceleration")
    expect(hwAccel).toHaveAttribute("role", "switch")
    expect(hwAccel).toHaveAttribute("data-state", "unchecked")
    fireEvent.click(hwAccel)
    await waitFor(() =>
      expect(hwAccel).toHaveAttribute("data-state", "checked")
    )

    // Every child section mounted. A section that is one option is titled by
    // that option, so these double as the labels asserted above.
    for (const heading of [
      "Default Terminal",
      "Colorize command output",
      "Disable hardware acceleration",
      "Question timeouts",
      "Mention panel",
      "Desktop notifications",
      "Notification sounds",
    ]) {
      expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument()
    }

    // Moved out to their own pages (`collaboration-settings.test.tsx`,
    // `browser-settings.test.tsx`), which is the whole point of the split:
    // "general" now names what the page holds.
    for (const heading of [
      "Multi-Agent Collaboration",
      "In-conversation tools",
      "Built-in browser",
    ]) {
      expect(
        screen.queryByRole("heading", { name: heading })
      ).not.toBeInTheDocument()
    }
  })

  /**
   * The command-color switch ships OFF and has to stay that way — forcing
   * color on the agent breaks machine parsing of everything the agent runs, so
   * an accidental default flip is the regression worth catching. The save also
   * has to carry `default_shell` back unchanged: both settings share one stored
   * row, so a payload missing it would wipe the user's shell choice.
   */
  it("defaults command color off and preserves the shell when toggling it", async () => {
    renderSettings()

    const colorize = await screen.findByLabelText("Colorize command output")
    expect(colorize).toHaveAttribute("data-state", "unchecked")

    fireEvent.click(colorize)

    await waitFor(() =>
      expect(colorize).toHaveAttribute("data-state", "checked")
    )
    expect(vi.mocked(updateSystemTerminalSettings)).toHaveBeenCalledWith({
      default_shell: null,
      colorize_command_output: true,
    })
  })

  /**
   * A failed load is the one state where the switch must not be operable. The
   * save replaces the whole stored row, so a toggle made before the row was
   * read would send `default_shell: null` — indistinguishable from "the user
   * picked the system shell" — and quietly discard a configured shell path.
   * The picker is already inert here; the switch has to be too.
   */
  it("keeps the command-color switch inert when the settings fail to load", async () => {
    vi.mocked(updateSystemTerminalSettings).mockClear()
    vi.mocked(getSystemTerminalSettings).mockRejectedValueOnce(
      new Error("backend unreachable")
    )

    renderSettings()

    const colorize = await screen.findByLabelText("Colorize command output")
    expect(colorize).toBeDisabled()

    fireEvent.click(colorize)

    await waitFor(() =>
      expect(
        screen.getByText(/Load failed: backend unreachable/)
      ).toBeInTheDocument()
    )
    expect(vi.mocked(updateSystemTerminalSettings)).not.toHaveBeenCalled()
    expect(colorize).toHaveAttribute("data-state", "unchecked")
  })

  /**
   * The other end of the same coupling: once a shell save has landed, the
   * color toggle has to echo the NEW shell back. The save is followed by a
   * fallible options refresh, and a failure there used to leave the remembered
   * shell one revision behind — so the next toggle would faithfully resend the
   * superseded value and undo a save the user watched succeed.
   */
  it("keeps a just-saved shell when the options refresh fails", async () => {
    vi.mocked(updateSystemTerminalSettings).mockClear()
    vi.mocked(toast.error).mockClear()
    // A stored path outside the option list renders the custom-path row, which
    // is the save route that needs no Select interaction.
    vi.mocked(getSystemTerminalSettings).mockResolvedValueOnce({
      default_shell: "/opt/fish",
      colorize_command_output: false,
    })

    renderSettings()

    const path = await screen.findByLabelText("Shell path")
    fireEvent.change(path, { target: { value: "/opt/fish2" } })

    // The save lands; only the refresh that follows it fails.
    vi.mocked(getAvailableTerminalShells).mockRejectedValueOnce(
      new Error("options unavailable")
    )
    // Several sections have a "Save"; this one sits in the input's own row.
    const shellRow = path.parentElement as HTMLElement
    fireEvent.click(within(shellRow).getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(vi.mocked(updateSystemTerminalSettings)).toHaveBeenCalledWith({
        default_shell: "/opt/fish2",
        colorize_command_output: false,
      })
    )

    // ...and the user is not told the save failed. It didn't: the row is
    // written, the shell is already live. Reporting the refresh as a failed
    // save sends them to re-save a setting that is already stored.
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()

    const colorize = screen.getByLabelText("Colorize command output")
    await waitFor(() => expect(colorize).toBeEnabled())
    fireEvent.click(colorize)

    await waitFor(() =>
      expect(vi.mocked(updateSystemTerminalSettings)).toHaveBeenLastCalledWith({
        default_shell: "/opt/fish2",
        colorize_command_output: true,
      })
    )
  })

  /**
   * The picker moves ahead of the save so it feels immediate, which makes a
   * REJECTED save the one state where it can name a shell nothing uses — not
   * the line under it, not a new terminal tab, not an agent's command. The
   * toast that said so scrolls away; the wrong selection does not.
   */
  it("puts the picker back when the save is rejected", async () => {
    vi.mocked(getSystemTerminalSettings).mockResolvedValueOnce({
      default_shell: "/opt/fish",
      colorize_command_output: false,
    })
    vi.mocked(getAvailableTerminalShells).mockResolvedValueOnce(
      shellsResolving("/opt/fish")
    )
    vi.mocked(updateSystemTerminalSettings).mockRejectedValueOnce(
      new Error("disk full")
    )

    renderSettings()

    // A stored path outside the option list selects the custom row, so there
    // is a second option to switch away to.
    const picker = await screen.findByLabelText("Default Terminal")
    expect(picker).toHaveTextContent("Custom path")

    fireEvent.keyDown(picker, { key: "Enter" })
    fireEvent.click(await screen.findByText("System default"))

    await waitFor(() =>
      expect(vi.mocked(updateSystemTerminalSettings)).toHaveBeenLastCalledWith({
        default_shell: null,
        colorize_command_output: false,
      })
    )
    await waitFor(() => expect(picker).toHaveTextContent("Custom path"))
    // The stored shell is untouched, so the line under the picker keeps
    // naming it — picker and line agree again.
    expect(screen.getByText("Currently using: /opt/fish")).toBeInTheDocument()
  })

  /**
   * "Currently using" is the only place the page says what the choice actually
   * resolves to, and the backend answers that per selection — so the page has
   * to re-read it after every save. Leaving the first answer on screen is what
   * made the line read as a constant (always the host's `COMSPEC`/`SHELL`)
   * however the picker was set, which reads as "this setting does nothing".
   */
  it("re-reads the resolved shell after a save", async () => {
    vi.mocked(getSystemTerminalSettings).mockResolvedValueOnce({
      default_shell: "/opt/fish",
      colorize_command_output: false,
    })
    vi.mocked(getAvailableTerminalShells).mockResolvedValueOnce(
      shellsResolving("/opt/fish")
    )

    renderSettings()

    expect(
      await screen.findByText("Currently using: /opt/fish")
    ).toBeInTheDocument()

    const path = screen.getByLabelText("Shell path")
    fireEvent.change(path, { target: { value: "/opt/fish2" } })
    vi.mocked(getAvailableTerminalShells).mockResolvedValueOnce(
      shellsResolving("/opt/fish2")
    )
    const shellRow = path.parentElement as HTMLElement
    fireEvent.click(within(shellRow).getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(
        screen.getByText("Currently using: /opt/fish2")
      ).toBeInTheDocument()
    )
  })

  // The switch only means something where the backend has an env knob to flip
  // at startup: `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` on Windows,
  // `WEBKIT_DISABLE_*` on Linux. WKWebView has neither.
  it("offers the rendering toggle on Linux too", async () => {
    platform.current = "linux"
    renderSettings()

    await screen.findByLabelText("Default Terminal")
    expect(
      screen.getByLabelText("Disable hardware acceleration")
    ).toBeInTheDocument()
  })

  it("hides the rendering toggle on macOS", async () => {
    platform.current = "macos"
    renderSettings()

    await screen.findByLabelText("Default Terminal")
    expect(
      screen.queryByLabelText("Disable hardware acceleration")
    ).not.toBeInTheDocument()
  })

  /**
   * 提问配置读取时带回三个策略字段；页面编辑策略时只提交这三个字段。
   * 默认值和 Rust 端 `QuestionSettings::default()` 一致（10 分钟 / 3 次 / 开启），
   * 页面必须原样显示，不能自己另起一套默认。
   */
  it("加载并保存提问 MCP（Question MCP）超时配置", async () => {
    renderSettings()

    const timeout = await screen.findByLabelText("Question MCP wait time")
    expect(timeout).toHaveValue(10)
    expect(screen.getByLabelText("Question MCP retries")).toHaveValue(3)

    fireEvent.change(timeout, { target: { value: "20" } })
    // 三项策略一起提交，后端会在当前开关上合并这条策略补丁。
    fireEvent.click(
      screen.getByLabelText("Auto-select the first option after timeout")
    )

    await waitFor(() =>
      expect(vi.mocked(updateQuestionPolicy)).toHaveBeenCalledWith({
        wait_timeout_minutes: 20,
        retry_count: 3,
        auto_select_first_on_timeout: false,
      })
    )
  })

  /**
   * 这条记录有两个编辑者：本页写等待策略三项，开关（`enabled`）的编辑器是
   * agent-tools 面板。另一窗口把开关关掉后，本页保存等待时长必须跟着广播走 ——
   * 拿着加载时的旧值整条写回，就是把别处刚关掉的开关又打开，而这个字段在本页
   * 根本不显示，用户看不到任何回退。反过来，广播不得改写本页正在编辑的三项策略。
   */
  it("保存等待策略时跟随广播的提问 MCP（Question MCP）开关", async () => {
    renderSettings()

    const timeout = await screen.findByLabelText("Question MCP wait time")
    await waitFor(() => expect(questionHandler()).toBeDefined())

    // 另一个窗口关掉提问开关，顺带带着它手里的等待策略一起广播。
    act(() =>
      questionHandler()?.({
        enabled: false,
        wait_timeout_minutes: 30,
        retry_count: 9,
        auto_select_first_on_timeout: false,
      })
    )
    // 三项策略是本页的：广播带来的 30 分钟 / 9 次不跟着跳。
    expect(timeout).toHaveValue(10)
    expect(screen.getByLabelText("Question MCP retries")).toHaveValue(3)

    fireEvent.change(timeout, { target: { value: "20" } })
    fireEvent.blur(timeout)

    await waitFor(() =>
      expect(vi.mocked(updateQuestionPolicy)).toHaveBeenCalledWith({
        wait_timeout_minutes: 20,
        retry_count: 3,
        auto_select_first_on_timeout: true,
      })
    )
  })

  it("订阅注册后重新读取权威提问配置且保留用户策略编辑", async () => {
    let releaseRegistration: (unsubscribe: () => void) => void = () => {}
    broadcasts.registration = new Promise((resolve) => {
      releaseRegistration = resolve
    })
    const firstRead = {
      enabled: true,
      wait_timeout_minutes: 10,
      retry_count: 3,
      auto_select_first_on_timeout: true,
    }
    const authoritativeRead = {
      enabled: false,
      wait_timeout_minutes: 30,
      retry_count: 9,
      auto_select_first_on_timeout: false,
    }
    let reads = 0
    vi.mocked(getQuestionSettings).mockImplementation(async () =>
      reads++ === 0 ? firstRead : authoritativeRead
    )

    renderSettings()
    const timeout = await screen.findByLabelText("Question MCP wait time")
    fireEvent.change(timeout, { target: { value: "20" } })

    // 广播在订阅注册前发生，因此本页收不到它；注册完成后必须重新读取权威记录。
    await act(async () => {
      releaseRegistration(broadcasts.unsubscribe)
    })
    await waitFor(() =>
      expect(vi.mocked(getQuestionSettings)).toHaveBeenCalledTimes(2)
    )

    // 权威重读只协调本页不编辑的 enabled，不能顶掉正在编辑的三个策略字段。
    expect(timeout).toHaveValue(20)
    expect(screen.getByLabelText("Question MCP retries")).toHaveValue(3)
    expect(
      screen.getByLabelText("Auto-select the first option after timeout")
    ).toBeChecked()
  })

  /** 关闭自动选择就是无限等待：MCP 侧一直等到有人回答为止。此时等待时长和
   *  重提次数不再起作用，两个输入框停用，并在区块里说明原因；值留在原处，
   *  重新打开开关时原样恢复，不必重填。 */
  it("关闭自动选择时显示提问 MCP（Question MCP）无限等待说明", async () => {
    renderSettings()

    const timeout = await screen.findByLabelText("Question MCP wait time")
    const retries = screen.getByLabelText("Question MCP retries")
    fireEvent.change(timeout, { target: { value: "20" } })

    fireEvent.click(
      screen.getByLabelText("Auto-select the first option after timeout")
    )

    expect(await screen.findByText(/wait indefinitely/i)).toBeInTheDocument()
    expect(timeout).toBeDisabled()
    expect(retries).toBeDisabled()
    // 值没有被清掉：再次打开自动选择时，屏幕上还是用户填的那个数。
    expect(timeout).toHaveValue(20)
  })

  /** 输入框允许越界，落到后端的值不允许：后端会收敛，界面也要显示收敛后的值，
   *  否则屏幕上的数字和真正生效的策略对不上。 */
  it("把提问 MCP（Question MCP）等待时长收敛到后端区间", async () => {
    renderSettings()

    const timeout = await screen.findByLabelText("Question MCP wait time")
    fireEvent.change(timeout, { target: { value: "99999" } })
    fireEvent.blur(timeout)

    await waitFor(() =>
      expect(vi.mocked(updateQuestionPolicy)).toHaveBeenLastCalledWith({
        wait_timeout_minutes: 1440,
        retry_count: 3,
        auto_select_first_on_timeout: true,
      })
    )
    await waitFor(() => expect(timeout).toHaveValue(1440))
  })

  /**
   * 保存失败时界面必须退回最近一次成功的值，并说明失败原因：停在后端没接受
   * 的状态，用户会以为策略已经生效——等待时长这种"看不见"的配置尤其危险，
   * 下一次提问超时才知道没生效。
   */
  it("保存失败时恢复提问 MCP（Question MCP）配置并提示错误", async () => {
    vi.mocked(toast.error).mockClear()
    vi.mocked(updateQuestionPolicy).mockRejectedValueOnce(
      new Error("disk full")
    )

    renderSettings()

    const timeout = await screen.findByLabelText("Question MCP wait time")
    fireEvent.change(timeout, { target: { value: "20" } })
    fireEvent.blur(timeout)

    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        expect.stringContaining("disk full")
      )
    )
    await waitFor(() => expect(timeout).toHaveValue(10))
  })
})
