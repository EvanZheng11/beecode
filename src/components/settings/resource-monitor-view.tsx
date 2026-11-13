"use client"

/**
 * 设置 - 监控的纯展示组件：开关、实时指标、CPU/内存趋势、进程表格和
 * 一键优化入口。不含 API、计时器或业务状态；危险动作只通过
 * onRequestAction 上报，二次确认由上层负责。
 */

import { useId, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  Activity,
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  FolderTree,
  Loader2,
  Pause,
  Sparkles,
} from "lucide-react"

import { SettingsSection } from "@/components/shared/settings-section"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableContent,
  DataTableHeader,
  DataTableRow,
} from "@/components/ui/data-table"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import {
  DEFAULT_RESOURCE_MONITOR_SORT,
  ariaSortFor,
  groupProcessesByDirectory,
  normalizeDirectory,
  sortProcesses,
  toggleSort,
  type ResourceMonitorSortKey,
  type ResourceMonitorSortState,
} from "@/lib/resource-monitor-table"
import type {
  ResourceMonitorAction,
  ResourceMonitorHistoryPoint,
  ResourceMonitorOptimizeResult,
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
  optimizeBusy: boolean
  optimizeResult: ResourceMonitorOptimizeResult | null
  optimizeError: string | null
  onEnabledChange: (enabled: boolean) => void
  onRequestAction: (
    process: ResourceMonitorProcess,
    action: ResourceMonitorAction
  ) => void
  onOptimize: () => void
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
  optimizeBusy,
  optimizeResult,
  optimizeError,
  onEnabledChange,
  onRequestAction,
  onOptimize,
  onRetry,
}: ResourceMonitorViewProps) {
  const t = useTranslations("ResourceMonitor")
  const switchId = useId()
  const showData = enabled && snapshot !== null
  const nothingReclaimed =
    optimizeResult !== null &&
    optimizeResult.clearedCacheEntries === 0 &&
    optimizeResult.reclaimedMemoryBytes === 0 &&
    optimizeResult.reclaimedDiskBytes === 0

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

      {/* 一键优化独立于监控开关：关闭监控时也始终可用。 */}
      <SettingsSection
        icon={Sparkles}
        title={t("optimize.title")}
        description={t("optimize.description")}
        control={
          <Button size="sm" onClick={onOptimize} disabled={optimizeBusy}>
            {optimizeBusy ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles className="size-3.5" aria-hidden="true" />
            )}
            {optimizeBusy ? t("optimize.busy") : t("optimize.button")}
          </Button>
        }
      >
        <div className="flex flex-col gap-2">
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("optimize.note")}
          </p>
          {optimizeError ? (
            <p
              role="alert"
              className="break-words rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-sm text-destructive"
            >
              {optimizeError}
            </p>
          ) : null}
          {optimizeResult ? (
            <div
              role="status"
              className="rounded-lg border border-border/70 bg-muted/40 p-2.5 text-sm"
            >
              <dl className="grid grid-cols-1 gap-1 sm:grid-cols-3">
                {(
                  [
                    [
                      t("optimize.cacheEntries"),
                      String(optimizeResult.clearedCacheEntries),
                    ],
                    [
                      t("optimize.memory"),
                      formatBytes(optimizeResult.reclaimedMemoryBytes),
                    ],
                    [
                      t("optimize.disk"),
                      formatBytes(optimizeResult.reclaimedDiskBytes),
                    ],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label} className="min-w-0">
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd className="tabular-nums">{value}</dd>
                  </div>
                ))}
              </dl>
              {nothingReclaimed ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("optimize.nothing")}
                </p>
              ) : null}
              {optimizeResult.warnings.length > 0 ? (
                <div className="mt-2">
                  <p className="text-xs font-medium">
                    {t("optimize.warnings")}
                  </p>
                  <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-xs break-words text-muted-foreground">
                    {optimizeResult.warnings.map((warning, index) => (
                      <li key={`${index}-${warning}`}>{warning}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </SettingsSection>

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
            <ProcessTable
              processes={snapshot.processes}
              actionBusy={actionBusy}
              onRequestAction={onRequestAction}
            />
          </SettingsSection>
        </>
      )}
    </div>
  )
}

const COLUMN_COUNT = 7

/**
 * 进程表格：活动监视器风格（斑马行、数字右对齐、表头吸顶、小屏横向滚动）。
 * 排序与分组是纯函数（`@/lib/resource-monitor-table`），这里只保存 UI 状态。
 */
function ProcessTable({
  processes,
  actionBusy,
  onRequestAction,
}: {
  processes: ResourceMonitorProcess[]
  actionBusy: boolean
  onRequestAction: ResourceMonitorViewProps["onRequestAction"]
}) {
  const t = useTranslations("ResourceMonitor")
  const [sort, setSort] = useState<ResourceMonitorSortState>(
    DEFAULT_RESOURCE_MONITOR_SORT
  )
  const [grouped, setGrouped] = useState(false)
  const rows = useMemo(() => sortProcesses(processes, sort), [processes, sort])
  const groups = useMemo(
    () => groupProcessesByDirectory(processes, sort),
    [processes, sort]
  )
  const onSort = (key: ResourceMonitorSortKey) =>
    setSort((current) => toggleSort(current, key))

  if (processes.length === 0) {
    return (
      <p className="p-4 text-center text-sm text-muted-foreground">
        {t("empty")}
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          size="sm"
          variant={grouped ? "secondary" : "outline"}
          aria-pressed={grouped}
          onClick={() => setGrouped((value) => !value)}
        >
          <FolderTree className="size-3.5" aria-hidden="true" />
          {t("groupByDirectory")}
        </Button>
      </div>
      {/* 限高 + 内部滚动，表头吸顶才真正生效；小屏由表格自身横向滚动。 */}
      <DataTable aria-busy={actionBusy} className="flex max-h-[32rem] flex-col">
        <DataTableContent className="min-w-[46rem]">
          <caption className="sr-only">{t("processList")}</caption>
          <DataTableHeader>
            <tr>
              <SortHeader
                column="name"
                label={t("columns.name")}
                sort={sort}
                onSort={onSort}
                className="w-[24%]"
              />
              <SortHeader
                column="pid"
                label={t("columns.pid")}
                sort={sort}
                onSort={onSort}
                className="w-20"
              />
              <SortHeader
                column="directory"
                label={t("columns.directory")}
                sort={sort}
                onSort={onSort}
                className="w-[24%]"
              />
              <SortHeader
                column="cpu"
                label={t("cpu")}
                sort={sort}
                onSort={onSort}
                className="w-24"
                align="end"
              />
              <SortHeader
                column="memory"
                label={t("memory")}
                sort={sort}
                onSort={onSort}
                className="w-28"
                align="end"
              />
              <SortHeader
                column="uptime"
                label={t("columns.uptimeStatus")}
                sort={sort}
                onSort={onSort}
                className="w-32"
              />
              <th scope="col" className="px-3.5 py-2.5 font-medium">
                {t("columns.actions")}
              </th>
            </tr>
          </DataTableHeader>
          {grouped ? (
            groups.map((group) => (
              <DataTableBody key={group.directory ?? "unknown-directory"}>
                <tr className="border-b border-border bg-muted/60">
                  <th
                    scope="rowgroup"
                    colSpan={COLUMN_COUNT}
                    className="px-3.5 py-2 text-start font-medium"
                  >
                    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                      <FolderTree
                        className="size-3.5 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <span
                        className="min-w-0 truncate font-mono text-xs"
                        title={group.directory ?? undefined}
                      >
                        {group.directory ?? t("unknownDirectory")}
                      </span>
                      <span className="text-2xs text-muted-foreground">
                        {t("groupCount", { count: group.processCount })}
                      </span>
                      <span className="text-2xs tabular-nums text-muted-foreground">
                        {t("cpu")} {pct(group.totalCpuPercent)}
                      </span>
                      <span className="text-2xs tabular-nums text-muted-foreground">
                        {t("memory")} {formatBytes(group.totalMemoryBytes)}
                      </span>
                    </div>
                  </th>
                </tr>
                {group.processes.map((p) => (
                  <ProcessRow
                    key={`${p.pid}-${p.startTime}`}
                    process={p}
                    actionBusy={actionBusy}
                    onRequestAction={onRequestAction}
                  />
                ))}
              </DataTableBody>
            ))
          ) : (
            <DataTableBody>
              {rows.map((p) => (
                <ProcessRow
                  key={`${p.pid}-${p.startTime}`}
                  process={p}
                  actionBusy={actionBusy}
                  onRequestAction={onRequestAction}
                />
              ))}
            </DataTableBody>
          )}
        </DataTableContent>
      </DataTable>
    </div>
  )
}

function SortHeader({
  column,
  label,
  sort,
  onSort,
  className,
  align = "start",
}: {
  column: ResourceMonitorSortKey
  label: string
  sort: ResourceMonitorSortState
  onSort: (key: ResourceMonitorSortKey) => void
  className?: string
  align?: "start" | "end"
}) {
  const t = useTranslations("ResourceMonitor")
  const active = sort.key === column
  const Icon = active
    ? sort.direction === "asc"
      ? ArrowUp
      : ArrowDown
    : ChevronsUpDown
  return (
    <th scope="col" aria-sort={ariaSortFor(sort, column)} className={className}>
      <div className={align === "end" ? "flex justify-end" : "flex"}>
        <button
          type="button"
          title={t("sortBy", { column: label })}
          onClick={() => onSort(column)}
          className="inline-flex min-w-0 items-center gap-1 rounded-md outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30"
        >
          <span className="truncate">{label}</span>
          <Icon
            className={cn("size-3 shrink-0", !active && "opacity-40")}
            aria-hidden="true"
          />
        </button>
      </div>
    </th>
  )
}

function ProcessRow({
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
  const directory = normalizeDirectory(p.launchDirectory)
  const uptime = formatUptime(p.uptimeSeconds)
  return (
    <DataTableRow className="odd:bg-muted/25">
      <td className="min-w-0 px-3.5 py-1.5 align-middle">
        <span className="block truncate text-ui font-medium" title={p.name}>
          {p.name}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
          <Badge variant="secondary">{t(`category.${p.category}`)}</Badge>
          {p.ownerLabel ? (
            <span className="truncate" title={p.ownerLabel}>
              {p.ownerLabel}
            </span>
          ) : null}
        </span>
      </td>
      <DataTableCell
        className="tabular-nums text-muted-foreground"
        title={p.parentPid !== null ? `PPID ${p.parentPid}` : undefined}
      >
        {p.pid}
      </DataTableCell>
      <DataTableCell
        className="font-mono text-xs"
        title={directory ?? t("unknownDirectory")}
      >
        {directory ?? (
          <span className="font-sans text-muted-foreground">
            {t("unknownDirectory")}
          </span>
        )}
      </DataTableCell>
      <DataTableCell className="text-end tabular-nums">
        {pct(p.cpuPercent)}
      </DataTableCell>
      <DataTableCell className="text-end tabular-nums">
        {formatBytes(p.memoryBytes)}
      </DataTableCell>
      <DataTableCell
        className="text-muted-foreground"
        title={`${uptime} · ${p.status}`}
      >
        <span className="tabular-nums">{uptime}</span> · {p.status}
      </DataTableCell>
      {/* 动作列不加 truncate：被禁用时要在行内说明原因。 */}
      <td className="px-3.5 py-1.5 align-middle">
        <div className="flex flex-wrap gap-1.5">
          {ACTIONS.map((a) => (
            <Button
              key={a}
              size="xs"
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
          <p id={reasonId} className="mt-1 text-2xs text-muted-foreground">
            {reason}
          </p>
        ) : null}
      </td>
    </DataTableRow>
  )
}
