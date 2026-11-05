"use client"

/**
 * 设置 - 监控的纯展示组件：开关、实时指标、CPU/内存趋势和进程列表。
 * 不含 API、计时器或业务状态；危险动作只通过 onRequestAction 上报，
 * 二次确认由上层负责。
 */

import { useId } from "react"
import { useTranslations } from "next-intl"
import { Activity, AlertCircle, Loader2, Pause } from "lucide-react"

import { SettingsSection } from "@/components/shared/settings-section"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import type {
  ResourceMonitorAction,
  ResourceMonitorHistoryPoint,
  ResourceMonitorProcess,
  ResourceMonitorSnapshot,
} from "@/lib/resource-monitor-types"

export interface ResourceMonitorViewProps {
  enabled: boolean
  loading: boolean
  saving: boolean
  paused: boolean
  snapshot: ResourceMonitorSnapshot | null
  history: ResourceMonitorHistoryPoint[]
  error: string | null
  actionBusy: boolean
  onEnabledChange: (enabled: boolean) => void
  onRequestAction: (
    process: ResourceMonitorProcess,
    action: ResourceMonitorAction
  ) => void
  onRetry: () => void
}

const MAX_POINTS = 60
const ACTIONS: ResourceMonitorAction[] = ["stop", "kill", "restart"]

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "-"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function formatUptime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "-"
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${Math.floor(s)}s`
}

const pct = (n: number) => `${(Number.isFinite(n) ? n : 0).toFixed(1)}%`

function Trend({
  title,
  values,
  current,
  min,
  tone,
}: {
  title: string
  values: number[]
  current: string
  /** 纵轴最小上限，避免空闲时噪声被放大。 */
  min: number
  tone: string
}) {
  const t = useTranslations("ResourceMonitor")
  const pts = values.slice(-MAX_POINTS)
  const max = Math.max(min, ...pts)
  const W = 300
  const H = 80
  const step = pts.length > 1 ? W / (MAX_POINTS - 1) : 0
  const x0 = W - (pts.length - 1) * step
  const coords = pts.map(
    (v, i) =>
      `${(x0 + i * step).toFixed(1)},${(H - 2 - (v / max) * (H - 4)).toFixed(1)}`
  )
  return (
    <div className="min-w-0 rounded-xl border border-border/70 bg-muted/40 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-sm tabular-nums text-muted-foreground">
          {current}
        </span>
      </div>
      {pts.length < 2 ? (
        <p className="flex h-20 items-center justify-center text-xs text-muted-foreground">
          {t("chartEmpty")}
        </p>
      ) : (
        <svg
          role="img"
          aria-label={t("chartLabel", { title, count: pts.length })}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className={`mt-2 h-20 w-full ${tone}`}
        >
          <line
            x1="0"
            y1={H - 1}
            x2={W}
            y2={H - 1}
            stroke="currentColor"
            strokeOpacity="0.2"
          />
          <polyline
            points={`${x0.toFixed(1)},${H - 1} ${coords.join(" ")} ${W},${H - 1}`}
            fill="currentColor"
            fillOpacity="0.12"
          />
          <polyline
            points={coords.join(" ")}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="surface-glass min-w-0 rounded-2xl p-4">
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 truncate text-2xl font-semibold tabular-nums">
        {value}
      </dd>
    </div>
  )
}

export function ResourceMonitorView({
  enabled,
  loading,
  saving,
  paused,
  snapshot,
  history,
  error,
  actionBusy,
  onEnabledChange,
  onRequestAction,
  onRetry,
}: ResourceMonitorViewProps) {
  const t = useTranslations("ResourceMonitor")
  const switchId = useId()
  const showData = enabled && snapshot !== null

  return (
    <div className="mx-auto flex w-full max-w-[80rem] flex-col gap-4">
      <SettingsSection
        icon={Activity}
        title={t("title")}
        description={t("enableDescription")}
        htmlFor={switchId}
        control={
          <div className="flex items-center gap-2">
            {saving ? (
              <Loader2
                className="size-4 animate-spin text-muted-foreground"
                aria-label={t("saving")}
              />
            ) : null}
            <Switch
              id={switchId}
              checked={enabled}
              disabled={loading || saving}
              onCheckedChange={onEnabledChange}
            />
          </div>
        }
      >
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("overheadNote")}
        </p>
      </SettingsSection>

      {error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <Button size="sm" variant="outline" onClick={onRetry}>
            {t("retry")}
          </Button>
        </div>
      ) : null}

      {!enabled ? (
        <p className="rounded-xl border border-dashed border-border/70 p-6 text-center text-sm text-muted-foreground">
          {t("disabledHint")}
        </p>
      ) : !showData ? (
        <p
          role="status"
          className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-border/70 p-6 text-sm text-muted-foreground"
        >
          {loading ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              {t("loading")}
            </>
          ) : (
            t("noData")
          )}
        </p>
      ) : (
        <>
          {paused ? (
            <p
              role="status"
              className="flex items-center gap-2 rounded-xl border border-border/70 bg-muted/40 p-3 text-sm text-muted-foreground"
            >
              <Pause className="size-4 shrink-0" aria-hidden="true" />
              {t("paused")}
            </p>
          ) : null}

          <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Metric label={t("cpu")} value={pct(snapshot.totalCpuPercent)} />
            <Metric
              label={t("memory")}
              value={formatBytes(snapshot.totalMemoryBytes)}
            />
            <Metric
              label={t("processes")}
              value={String(snapshot.activeProcessCount)}
            />
            <Metric
              label={t("collection")}
              value={`${Math.round(snapshot.collectionDurationMs)} ms`}
            />
          </dl>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("cpuNote")} {t("memoryNote")}
          </p>

          {snapshot.warnings.length > 0 ? (
            <div
              role="status"
              className="rounded-xl border border-tone-warning/40 bg-tone-warning/10 p-3 text-sm"
            >
              <p className="font-medium">{t("warnings")}</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 break-words">
                {snapshot.warnings.map((w, i) => (
                  <li key={`${i}-${w}`}>{w}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="grid gap-3 md:grid-cols-2">
            <Trend
              title={t("cpuTrend")}
              values={history.map((p) => p.cpuPercent)}
              current={pct(snapshot.totalCpuPercent)}
              min={100}
              tone="text-tone-info"
            />
            <Trend
              title={t("memoryTrend")}
              values={history.map((p) => p.memoryBytes)}
              current={formatBytes(snapshot.totalMemoryBytes)}
              min={1}
              tone="text-tone-success"
            />
          </div>

          <SettingsSection title={t("processList")}>
            {snapshot.processes.length === 0 ? (
              <p className="p-4 text-center text-sm text-muted-foreground">
                {t("empty")}
              </p>
            ) : (
              <ul className="flex flex-col gap-2" aria-busy={actionBusy}>
                {snapshot.processes.map((p) => (
                  <ProcessItem
                    key={`${p.pid}-${p.startTime}`}
                    process={p}
                    actionBusy={actionBusy}
                    onRequestAction={onRequestAction}
                  />
                ))}
              </ul>
            )}
          </SettingsSection>
        </>
      )}
    </div>
  )
}

function ProcessItem({
  process: p,
  actionBusy,
  onRequestAction,
}: {
  process: ResourceMonitorProcess
  actionBusy: boolean
  onRequestAction: ResourceMonitorViewProps["onRequestAction"]
}) {
  const t = useTranslations("ResourceMonitor")
  const can = { stop: p.canStop, kill: p.canKill, restart: p.canRestart }
  const reasonId = `rm-reason-${p.pid}-${p.startTime}`
  const anyBlocked = ACTIONS.some((a) => !can[a])
  const reason = actionBusy
    ? t("actionBusy")
    : anyBlocked
      ? p.actionUnavailableReason
      : null
  return (
    <li className="min-w-0 rounded-xl border border-border/70 bg-muted/40 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium" title={p.name}>
            {p.name}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            PID {p.pid}
            {p.parentPid !== null ? ` · PPID ${p.parentPid}` : ""}
            {p.ownerLabel ? ` · ${p.ownerLabel}` : ""}
          </p>
        </div>
        <Badge variant="secondary">{t(`category.${p.category}`)}</Badge>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs sm:grid-cols-4">
        {(
          [
            ["cpu", pct(p.cpuPercent)],
            ["memory", formatBytes(p.memoryBytes)],
            ["status", p.status],
            ["uptime", formatUptime(p.uptimeSeconds)],
          ] as const
        ).map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="text-muted-foreground">{t(k)}</dt>
            <dd className="truncate tabular-nums" title={v}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-3 flex flex-wrap gap-2">
        {ACTIONS.map((a) => (
          <Button
            key={a}
            size="sm"
            variant={a === "kill" ? "destructive" : "outline"}
            disabled={!can[a] || actionBusy}
            aria-describedby={reason ? reasonId : undefined}
            onClick={() => onRequestAction(p, a)}
          >
            {t(`action.${a}`)}
          </Button>
        ))}
      </div>
      {reason ? (
        <p id={reasonId} className="mt-2 text-xs text-muted-foreground">
          {reason}
        </p>
      ) : null}
    </li>
  )
}
