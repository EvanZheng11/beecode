/** MCP ask_user_question 的等待期限工具：解析后端 RFC3339 时间并渲染分:秒。 */

/** 解析后端的 `expires_at`。缺失、空串或非法时间都视为“没有期限”，
 *  这样原生 agent 的提问和旧版后端不会显示倒计时。 */
export function questionDeadlineMs(
  expiresAt: string | null | undefined
): number | null {
  if (!expiresAt) return null
  const ms = Date.parse(expiresAt)
  return Number.isFinite(ms) ? ms : null
}

/** 把剩余毫秒渲染成 `mm:ss`；超过 99 分钟时分钟位自然变长，不截断。
 *  使用 floor 让最后一秒显示 00:00，与“已经到期”的视觉边界一致。 */
export function formatQuestionCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}
