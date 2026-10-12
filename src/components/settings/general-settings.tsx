"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  CheckCheck,
  Cpu,
  FolderCog,
  Infinity as InfinityIcon,
  Loader2,
  MessageCircleQuestion,
  Palette,
  RefreshCw,
  RotateCcw,
  SquareTerminal,
  Timer,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import {
  SettingCard,
  SettingNote,
  SettingRow,
} from "@/components/shared/setting-card"
import {
  SettingsError,
  SettingsSection,
} from "@/components/shared/settings-section"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  getAvailableTerminalShells,
  getQuestionSettings,
  getSystemRenderingSettings,
  getSystemTerminalSettings,
  probeTerminalShellPath,
  updateQuestionPolicy,
  updateSystemRenderingSettings,
  updateSystemTerminalSettings,
  type QuestionSettings,
} from "@/lib/api"
import { isDesktop, onTransportReconnect, subscribe } from "@/lib/platform"
import { getActiveRemoteConnectionId } from "@/lib/transport"
import {
  QUESTION_SETTINGS_CHANGED_EVENT,
  type AvailableTerminalShells,
  type TerminalShellOption,
} from "@/lib/types"
import { usePlatform } from "@/hooks/use-platform"
import { relaunchApp } from "@/lib/updater"
import { toErrorMessage } from "@/lib/app-error"
import { CloseBehaviorSettingsSection } from "@/components/settings/close-behavior-settings"
import { DesktopNotificationSettingsSection } from "@/components/settings/desktop-notification-settings"
import { NotificationSoundSettingsSection } from "@/components/settings/notification-sound-settings"

const TERMINAL_SHELL_OPTION_SYSTEM = "system"
const TERMINAL_SHELL_OPTION_CUSTOM = "custom"

// 提问的 MCP 等待策略：单次等待 1–1440 分钟，超时后最多重提 10 次（0 表示不重提）。
// 后端保存和读取走同一套边界（`QuestionSettings::normalized`），这里先收敛一次，
// 免得屏幕上显示的数字和真正生效的值对不上。
const QUESTION_WAIT_MINUTES_MIN = 1
const QUESTION_WAIT_MINUTES_MAX = 1440
const QUESTION_RETRY_COUNT_MIN = 0
const QUESTION_RETRY_COUNT_MAX = 10

/// 输入框里的数字收敛到后端接受的区间。空输入（NaN）回退到已保存的值：那一位
/// 用户没打算改，把空的输入框当成 0 会静默改掉一个他没碰过的设置。
function clampQuestionNumber(
  raw: number,
  fallback: number,
  min: number,
  max: number
): number {
  if (!Number.isFinite(raw)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(raw)))
}

/// Pick which dropdown row matches a stored `default_shell` value:
/// - null  → "system"
/// - matches a predefined option's `value` → that option's id
/// - anything else → "custom" (user-supplied path)
function resolveSelectedShellId(
  storedShell: string | null,
  options: TerminalShellOption[]
): string {
  if (!storedShell) return TERMINAL_SHELL_OPTION_SYSTEM
  const matched = options.find(
    (opt) => opt.value !== null && opt.value === storedShell
  )
  return matched?.id ?? TERMINAL_SHELL_OPTION_CUSTOM
}

// Captured the first time the rendering section loads: represents the value
// the running webview process was launched with. Survives settings-shell
// remounts so the "Restart now" banner doesn't vanish if the user navigates
// away and back without restarting.
let processStartDisableHwAccel: boolean | null = null

export function GeneralSettings() {
  const t = useTranslations("GeneralSettings")
  // Backend-driven shell label keys are dynamic strings, so widen `t`
  // for that single call site rather than casting at every use.
  const tDynamic = t as unknown as (key: string) => string
  const { isWindows, isLinux } = usePlatform()

  // Rendering settings are a local Tauri preference (preferences.json). They
  // are only meaningful when the active transport is the local Tauri shell —
  // remote workspace windows route every API call to a remote web server,
  // which deliberately does not expose this endpoint.
  const renderingSettingsLoadable =
    isDesktop() && getActiveRemoteConnectionId() === null
  // Windows (WebView2) and Linux (WebKitGTK) each expose an env knob the
  // backend can flip at startup. macOS (WKWebView) exposes none, so showing a
  // switch that cannot do anything there would be a lie.
  const renderingSectionVisible =
    renderingSettingsLoadable && (isWindows || isLinux)

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [savingTerminal, setSavingTerminal] = useState(false)
  const [availableShells, setAvailableShells] =
    useState<AvailableTerminalShells | null>(null)
  const [selectedShellId, setSelectedShellId] = useState<string>(
    TERMINAL_SHELL_OPTION_SYSTEM
  )
  const [customShellPath, setCustomShellPath] = useState<string>("")
  const [customPathExists, setCustomPathExists] = useState<boolean | null>(null)
  // The last persisted `default_shell`, kept verbatim. Both terminal settings
  // share one stored row, so saving the color toggle has to send the shell
  // back unchanged — and `selectedShellId`/`customShellPath` can't reconstruct
  // it (the custom row is cleared until the user presses Save).
  //
  // Tri-state, and the third state carries weight: `undefined` means the load
  // never landed, which is NOT the same as `null` ("use the system shell").
  // Sending `null` for an unknown shell would persist "system" over whatever
  // the user had chosen, so the color toggle stays inert until this is known.
  const [storedDefaultShell, setStoredDefaultShell] = useState<
    string | null | undefined
  >(undefined)
  const [colorizeCommandOutput, setColorizeCommandOutput] = useState(false)

  // 提问配置（MCP 等待策略）是一整条记录：等待时长、重提次数、超时后是否自动
  // 选第一个选项随开关一起读写。读取失败时保持 null —— 三个控件都不可操作，
  // 免得用一个臆测的整条配置覆盖掉用户已经存好的策略。
  const [questionDraft, setQuestionDraft] = useState<QuestionSettings | null>(
    null
  )
  /// 最近一次读到、保存成功或从广播收到的提问配置（整条），保存失败时用它把控件
  /// 收回去。
  const questionSettingsRef = useRef<QuestionSettings | null>(null)
  /// 广播计数：别的设置窗口写这条记录时递增。初次加载先采样一份，读回来时比对 ——
  /// 加载期间落地的广播比那次读取新。
  const questionRemoteGenRef = useRef(0)
  const [savingQuestion, setSavingQuestion] = useState(false)

  const [disableHwAccel, setDisableHwAccel] = useState(false)
  const [savingRendering, setSavingRendering] = useState(false)
  const [persistedDisableHwAccel, setPersistedDisableHwAccel] = useState(false)
  const [processStartLoaded, setProcessStartLoaded] = useState(
    processStartDisableHwAccel !== null
  )
  const renderingDirty =
    processStartLoaded && persistedDisableHwAccel !== processStartDisableHwAccel

  const loadSettings = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    // 这次读取可能比广播旧：先记下广播计数，读回来时再比一次。
    const questionGen = questionRemoteGenRef.current

    try {
      const [terminalSettings, terminalShells, renderingSettings, question] =
        await Promise.all([
          getSystemTerminalSettings(),
          getAvailableTerminalShells(),
          renderingSettingsLoadable
            ? getSystemRenderingSettings()
            : Promise.resolve(null),
          getQuestionSettings(),
        ])

      // `enabled` 本页没有编辑器（开关在 agent-tools 面板上），整条记录因此跟着广播
      // 走：加载期间已有广播落地，就以那条记录为准，而不是这次读到的旧值 —— 否则
      // 下一次保存等待策略会把别处刚关掉的开关又打开。三个策略字段显示的仍是本页
      // 读到的值。
      const questionRecord =
        questionRemoteGenRef.current === questionGen
          ? question
          : (questionSettingsRef.current ?? question)
      questionSettingsRef.current = questionRecord
      setQuestionDraft({ ...question, enabled: questionRecord.enabled })
      setAvailableShells(terminalShells)
      setStoredDefaultShell(terminalSettings.default_shell)
      setColorizeCommandOutput(terminalSettings.colorize_command_output)
      const initialId = resolveSelectedShellId(
        terminalSettings.default_shell,
        terminalShells.options
      )
      setSelectedShellId(initialId)
      if (initialId === TERMINAL_SHELL_OPTION_CUSTOM) {
        setCustomShellPath(terminalSettings.default_shell ?? "")
        setCustomPathExists(
          terminalSettings.default_shell
            ? await probeTerminalShellPath(terminalSettings.default_shell)
            : null
        )
      } else {
        setCustomShellPath("")
        setCustomPathExists(null)
      }

      if (renderingSettings) {
        const value = renderingSettings.disable_hardware_acceleration
        setDisableHwAccel(value)
        setPersistedDisableHwAccel(value)
        if (processStartDisableHwAccel === null) {
          processStartDisableHwAccel = value
          setProcessStartLoaded(true)
        }
      }
    } catch (err) {
      const message = toErrorMessage(err)
      setLoadError(message)
      console.error("[Settings] load general settings failed:", err)
    } finally {
      setLoading(false)
    }
  }, [renderingSettingsLoadable])

  const reconcileQuestionSettings = useCallback(async () => {
    const questionGen = questionRemoteGenRef.current
    try {
      const remote = await getQuestionSettings()
      if (questionRemoteGenRef.current !== questionGen) return
      questionSettingsRef.current = remote
      // 权威重读只协调本页不编辑的开关，保留三个策略输入框里的用户编辑。
      setQuestionDraft((prev) =>
        prev ? { ...prev, enabled: remote.enabled } : prev
      )
    } catch (err) {
      console.error("[Settings] refresh question settings failed:", err)
    }
  }, [])

  useEffect(() => {
    loadSettings().catch((err) => {
      console.error("[Settings] load general settings failed:", err)
    })
  }, [loadSettings])

  /**
   * 提问记录有两个编辑者：本页写等待策略三项，agent-tools 面板的开关写 `enabled`。
   * 两边都整条记录写回，所以保存等待策略时 `enabled` 必须跟着广播走 —— 这个字段
   * 在本页没有编辑器，拿加载时的旧值写回等于把别处刚关掉的开关又打开，而用户在本
   * 页看不到任何回退（开关根本不在这块界面上）。
   *
   * 反过来，广播不改写本页正在编辑的三个策略字段：它们是这块界面的字段，广播带来的
   * 版本会顶掉用户还没保存的输入。
   */
  useEffect(() => {
    let disposed = false
    let unsubscribe: (() => void) | undefined
    void subscribe<QuestionSettings>(
      QUESTION_SETTINGS_CHANGED_EVENT,
      (remote) => {
        questionRemoteGenRef.current += 1
        // 整条以广播为准存进 ref：保存时 `enabled` 取自它，空输入框的兜底值也取自它。
        questionSettingsRef.current = remote
        // 界面上只跟开关（本页不编辑它）；读取失败时保持 null，三个控件照旧不渲染。
        setQuestionDraft((prev) =>
          prev ? { ...prev, enabled: remote.enabled } : prev
        )
      }
    )
      .then((fn) => {
        if (disposed) fn()
        else {
          unsubscribe = fn
          // 初次读取可能早于订阅注册；注册完成后重新读取一次权威记录。
          void reconcileQuestionSettings()
        }
      })
      // 传输层没就绪不该弄坏这块表单：那只是说本窗口继续用它自己读到的值。
      .catch(() => {})
    const stopReconnect = onTransportReconnect(() => {
      void reconcileQuestionSettings()
    })
    return () => {
      disposed = true
      unsubscribe?.()
      stopReconnect?.()
    }
  }, [reconcileQuestionSettings])

  /// Resolves to whether the row was actually written, so the caller can put
  /// back whatever it moved ahead of the save.
  const persistTerminalShell = useCallback(
    async (defaultShell: string | null): Promise<boolean> => {
      setSavingTerminal(true)
      try {
        const result = await updateSystemTerminalSettings({
          default_shell: defaultShell,
          // Sent back unchanged — the save replaces the whole stored row, so
          // omitting it would silently reset the color opt-in.
          colorize_command_output: colorizeCommandOutput,
        })
        // Record the persisted shell BEFORE anything else that can throw. The
        // row is already written at this point, so every later failure is
        // cosmetic — except leaving this stale, which would have the color
        // toggle send the superseded shell back and undo the save that just
        // succeeded.
        setStoredDefaultShell(result.default_shell)

        // Everything below only refreshes what is on screen. It is scoped
        // separately because a failure here is NOT a failed save: reporting it
        // as one sends the user to re-save a setting that is already stored.
        try {
          // Re-fetch options to refresh `exists` flags (e.g. user just
          // installed pwsh, or backend filter dropped a cross-platform stale
          // value) and the shell the new selection resolves to.
          const refreshedShells = await getAvailableTerminalShells()
          setAvailableShells(refreshedShells)
          const nextSelectedId = resolveSelectedShellId(
            result.default_shell,
            refreshedShells.options
          )
          setSelectedShellId(nextSelectedId)
          if (nextSelectedId === TERMINAL_SHELL_OPTION_CUSTOM) {
            setCustomShellPath(result.default_shell ?? "")
            setCustomPathExists(
              result.default_shell
                ? await probeTerminalShellPath(result.default_shell)
                : null
            )
          } else {
            setCustomShellPath("")
            setCustomPathExists(null)
          }
        } catch (err) {
          // The stored row is correct and already in effect; only the line
          // under the picker is a revision behind until the page is reopened.
          console.error("[Settings] refresh terminal shells failed:", err)
        }
        return true
      } catch (err) {
        const message = toErrorMessage(err)
        toast.error(t("terminalSaveFailed", { message }))
        return false
      } finally {
        setSavingTerminal(false)
      }
    },
    [colorizeCommandOutput, t]
  )

  // Persist the command-color opt-in, sending the current shell back
  // unchanged. Reverts the switch on failure so it never shows a state the
  // backend rejected.
  const persistColorizeCommandOutput = useCallback(
    async (next: boolean, prev: boolean) => {
      // The switch is disabled in this state; the guard is here too because a
      // save that guessed at `default_shell` would overwrite a setting the
      // user never touched, and that is not something to leave to one prop.
      if (storedDefaultShell === undefined) {
        setColorizeCommandOutput(prev)
        return
      }
      setSavingTerminal(true)
      try {
        const result = await updateSystemTerminalSettings({
          default_shell: storedDefaultShell,
          colorize_command_output: next,
        })
        setColorizeCommandOutput(result.colorize_command_output)
      } catch (err) {
        setColorizeCommandOutput(prev)
        const message = toErrorMessage(err)
        toast.error(t("terminalSaveFailed", { message }))
      } finally {
        setSavingTerminal(false)
      }
    },
    [storedDefaultShell, t]
  )

  /// 保存整条提问配置。四个字段一起写，所以输入框里的数字先转成整数并收敛到
  /// 后端区间；成功后以后端返回的记录为准（界面显示的就是真正生效的值），失败
  /// 则退回最近一次成功的值并说明原因 —— 停在后端没接受的状态，用户会以为等待
  /// 策略已经生效，下一次提问超时才知道没有。
  const persistQuestionSettings = useCallback(
    async (next: QuestionSettings) => {
      const stored = questionSettingsRef.current
      // 还没读到过整条配置（读取失败）：不写，避免用臆测的值覆盖。
      if (!stored) return
      const payload: QuestionSettings = {
        enabled: next.enabled,
        wait_timeout_minutes: clampQuestionNumber(
          next.wait_timeout_minutes,
          stored.wait_timeout_minutes,
          QUESTION_WAIT_MINUTES_MIN,
          QUESTION_WAIT_MINUTES_MAX
        ),
        retry_count: clampQuestionNumber(
          next.retry_count,
          stored.retry_count,
          QUESTION_RETRY_COUNT_MIN,
          QUESTION_RETRY_COUNT_MAX
        ),
        auto_select_first_on_timeout: next.auto_select_first_on_timeout,
      }
      setSavingQuestion(true)
      try {
        const applied = await updateQuestionPolicy({
          wait_timeout_minutes: payload.wait_timeout_minutes,
          retry_count: payload.retry_count,
          auto_select_first_on_timeout: payload.auto_select_first_on_timeout,
        })
        questionSettingsRef.current = applied
        setQuestionDraft(applied)
      } catch (err) {
        setQuestionDraft(stored)
        const message = toErrorMessage(err)
        toast.error(t("questionMcpSaveFailed", { message }))
      } finally {
        setSavingQuestion(false)
      }
    },
    [t]
  )

  const onShellSelectChange = useCallback(
    (nextId: string) => {
      const previousId = selectedShellId
      setSelectedShellId(nextId)
      if (nextId === TERMINAL_SHELL_OPTION_CUSTOM) {
        // Don't persist yet — wait for user to type a path and press Save.
        setCustomShellPath("")
        setCustomPathExists(null)
        return
      }
      const matched = availableShells?.options.find((opt) => opt.id === nextId)
      void persistTerminalShell(matched?.value ?? null).then((saved) => {
        // The row moves ahead of the save so the picker feels immediate; a
        // rejected save has to put it back. Left alone it would name a shell
        // that nothing uses — not the line under it, not a new terminal tab,
        // not an agent's command — while the toast that said so scrolls away.
        if (!saved) setSelectedShellId(previousId)
      })
    },
    [availableShells, persistTerminalShell, selectedShellId]
  )

  const onCustomPathSave = useCallback(() => {
    const trimmed = customShellPath.trim()
    if (!trimmed) return
    void persistTerminalShell(trimmed)
  }, [customShellPath, persistTerminalShell])

  const saveRenderingSettings = useCallback(
    async (next: boolean, prev: boolean) => {
      setSavingRendering(true)
      try {
        const result = await updateSystemRenderingSettings({
          disable_hardware_acceleration: next,
        })
        setDisableHwAccel(result.disable_hardware_acceleration)
        setPersistedDisableHwAccel(result.disable_hardware_acceleration)
      } catch (err) {
        setDisableHwAccel(prev)
        const message = toErrorMessage(err)
        toast.error(t("renderingSaveFailed", { message }))
      } finally {
        setSavingRendering(false)
      }
    },
    [t]
  )

  const restartNow = useCallback(async () => {
    try {
      await relaunchApp()
    } catch (err) {
      const message = toErrorMessage(err)
      toast.error(t("restartFailed", { message }))
    }
  }, [t])

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("loading")}
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div className="w-full space-y-4 p-3 md:p-4">
        <section className="space-y-1">
          <h1 className="text-sm font-semibold">{t("sectionTitle")}</h1>
          <p className="text-xs text-muted-foreground">
            {t("sectionDescription")}
          </p>
        </section>

        {loadError && (
          <SettingsError>
            {t("loadFailed", { message: loadError })}
          </SettingsError>
        )}

        {/* The section is the picker: heading, purpose and control on one line,
            with what the shell currently resolves to under them. A card holding
            a single row would only say the heading back one line lower. */}
        <SettingsSection
          icon={SquareTerminal}
          title={t("terminalTitle")}
          description={
            <>
              {t("terminalDescription")}
              {availableShells ? (
                <span className="mt-1 block">
                  {t("terminalCurrentShell", {
                    path: availableShells.resolved_shell,
                  })}
                </span>
              ) : null}
            </>
          }
          htmlFor="terminal-default-shell"
          control={
            <Select
              value={selectedShellId}
              onValueChange={onShellSelectChange}
              disabled={savingTerminal || !availableShells}
            >
              {/* `size` rather than a bare `h-8`: the trigger's height is
                  gated on `data-size`, which outranks an ungated utility
                  in the class list. */}
              <SelectTrigger
                id="terminal-default-shell"
                size="sm"
                className="w-52 bg-background text-xs"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {availableShells?.options.map((opt) => (
                  <SelectItem key={opt.id} value={opt.id}>
                    <span className="flex items-center gap-2">
                      <span>{tDynamic(opt.label_key)}</span>
                      {!opt.exists && !opt.accepts_custom_path && (
                        <span className="text-3xs text-muted-foreground">
                          ({t("terminalShellNotInstalled")})
                        </span>
                      )}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        >
          {selectedShellId === TERMINAL_SHELL_OPTION_CUSTOM && (
            <SettingCard>
              <SettingRow
                icon={FolderCog}
                title={t("terminalShellCustomPath")}
                description={t("terminalShellCustomHint")}
                htmlFor="terminal-custom-shell"
              >
                <div className="flex gap-2">
                  <Input
                    id="terminal-custom-shell"
                    value={customShellPath}
                    onChange={(event) => {
                      setCustomShellPath(event.target.value)
                      setCustomPathExists(null)
                    }}
                    placeholder={t("terminalShellCustomPlaceholder")}
                    disabled={savingTerminal}
                    className="h-8 flex-1 bg-background font-mono text-xs"
                  />
                  <Button
                    type="button"
                    size="sm"
                    onClick={onCustomPathSave}
                    disabled={savingTerminal || !customShellPath.trim()}
                  >
                    {t("terminalShellCustomSave")}
                  </Button>
                </div>
                {customPathExists === false && customShellPath.trim() && (
                  <p className="text-2xs text-amber-500">
                    {t("terminalShellNotFoundWarning")}
                  </p>
                )}
              </SettingRow>
            </SettingCard>
          )}
        </SettingsSection>

        {/* Titled by the option rather than by "Color": the switch forces color
            ON for every command an agent runs, so the heading has to say what
            it does, not which category it files under. */}
        <SettingsSection
          icon={Palette}
          title={t("colorizeCommandOutput")}
          description={t("colorizeCommandOutputDescription")}
          htmlFor="colorize-command-output"
          control={
            <Switch
              id="colorize-command-output"
              checked={colorizeCommandOutput}
              // Inert until the persisted row has been read: the save replaces
              // the whole row, so toggling on a failed load would write the
              // shell field back as "system" and silently drop the user's
              // choice. The shell picker above is gated the same way.
              disabled={savingTerminal || storedDefaultShell === undefined}
              onCheckedChange={(next) => {
                const prev = colorizeCommandOutput
                setColorizeCommandOutput(next)
                void persistColorizeCommandOutput(next, prev)
              }}
            />
          }
        />

        {renderingSectionVisible && (
          // Titled by the option, not by the category it belongs to: the switch
          // turns acceleration *off*, so labelling it "Rendering" would read as
          // the opposite of what it does.
          <SettingsSection
            icon={Cpu}
            title={t("disableHardwareAcceleration")}
            description={t("renderingDescription")}
            htmlFor="disable-hardware-acceleration"
            control={
              <Switch
                id="disable-hardware-acceleration"
                checked={disableHwAccel}
                disabled={savingRendering}
                onCheckedChange={(next) => {
                  const prev = disableHwAccel
                  setDisableHwAccel(next)
                  void saveRenderingSettings(next, prev)
                }}
              />
            }
          >
            {renderingDirty && (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-muted/40 px-3 py-2 text-xs">
                <span className="min-w-0 text-muted-foreground">
                  {t("restartRequired")}
                </span>
                <Button
                  type="button"
                  size="sm"
                  className="shrink-0"
                  onClick={() => void restartNow()}
                  disabled={savingRendering}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  {t("restartNow")}
                </Button>
              </div>
            )}
          </SettingsSection>
        )}

        {/* 提问在 MCP 侧等多久：先按等待时长等，超时后重提，等待和重提都用尽
            时才看要不要自动选第一个选项。关闭自动选择等于无限等待，时长和次数
            随之失效 —— 但值留在控件里，重新打开时原样恢复。 */}
        <SettingsSection
          icon={MessageCircleQuestion}
          title={t("questionMcpTitle")}
          description={t("questionMcpDescription")}
        >
          {questionDraft ? (
            <SettingCard>
              <SettingRow
                icon={Timer}
                title={t("questionMcpWaitMinutes")}
                description={t("questionMcpWaitHint")}
                htmlFor="question-mcp-wait-minutes"
                control={
                  <Input
                    id="question-mcp-wait-minutes"
                    type="number"
                    min={QUESTION_WAIT_MINUTES_MIN}
                    max={QUESTION_WAIT_MINUTES_MAX}
                    value={
                      Number.isNaN(questionDraft.wait_timeout_minutes)
                        ? ""
                        : questionDraft.wait_timeout_minutes
                    }
                    onChange={(event) =>
                      setQuestionDraft({
                        ...questionDraft,
                        // 空输入存 NaN：离开输入框时回退到已保存的值，把 ""
                        // 当成 0 会静默改成 1 分钟，用户没改过的那位也一起动。
                        wait_timeout_minutes:
                          event.target.value === ""
                            ? NaN
                            : Number(event.target.value),
                      })
                    }
                    onBlur={() => void persistQuestionSettings(questionDraft)}
                    disabled={
                      savingQuestion ||
                      !questionDraft.auto_select_first_on_timeout
                    }
                    className="h-8 w-24 bg-background text-xs"
                  />
                }
              />
              <SettingRow
                icon={RotateCcw}
                title={t("questionMcpRetryCount")}
                description={t("questionMcpRetryHint")}
                htmlFor="question-mcp-retry-count"
                control={
                  <Input
                    id="question-mcp-retry-count"
                    type="number"
                    min={QUESTION_RETRY_COUNT_MIN}
                    max={QUESTION_RETRY_COUNT_MAX}
                    value={
                      Number.isNaN(questionDraft.retry_count)
                        ? ""
                        : questionDraft.retry_count
                    }
                    onChange={(event) =>
                      setQuestionDraft({
                        ...questionDraft,
                        retry_count:
                          event.target.value === ""
                            ? NaN
                            : Number(event.target.value),
                      })
                    }
                    onBlur={() => void persistQuestionSettings(questionDraft)}
                    disabled={
                      savingQuestion ||
                      !questionDraft.auto_select_first_on_timeout
                    }
                    className="h-8 w-24 bg-background text-xs"
                  />
                }
              />
              <SettingRow
                icon={CheckCheck}
                title={t("questionMcpAutoSelect")}
                description={t("questionMcpAutoSelectHint")}
                htmlFor="question-mcp-auto-select"
                control={
                  <Switch
                    id="question-mcp-auto-select"
                    checked={questionDraft.auto_select_first_on_timeout}
                    disabled={savingQuestion}
                    onCheckedChange={(next) => {
                      // 开关的保存带上没提交的输入框：改完时长直接点开关是
                      // 一次操作，不该丢掉刚填的数字。
                      const draft = {
                        ...questionDraft,
                        auto_select_first_on_timeout: next,
                      }
                      setQuestionDraft(draft)
                      void persistQuestionSettings(draft)
                    }}
                  />
                }
              />
            </SettingCard>
          ) : null}
          {questionDraft && !questionDraft.auto_select_first_on_timeout ? (
            <SettingNote icon={InfinityIcon}>
              {t("questionMcpInfiniteWait")}
            </SettingNote>
          ) : null}
        </SettingsSection>

        <CloseBehaviorSettingsSection />

        {/* The two halves of "how Codeg gets my attention", adjacent on
            purpose: one leaves the window, one does not. */}
        <DesktopNotificationSettingsSection />

        <NotificationSoundSettingsSection />
      </div>
    </ScrollArea>
  )
}
