"use client"

import { Cloud, GitBranch, Tag } from "lucide-react"
import { useTranslations } from "next-intl"

import type { GraphRow } from "@/components/layout/git-log-graph"
import type { GitLogRef } from "@/lib/types"
import { cn } from "@/lib/utils"

const LANE_WIDTH = 12
const LANE_PADDING = 7
const CURVE_HEIGHT = 14
const MAX_VISIBLE_LANES = 8
const MAX_VISIBLE_REFS = 3

const LANE_COLORS = [
  "#3b82f6",
  "#ef4444",
  "#10b981",
  "#f59e0b",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#f97316",
]

const laneColor = (color: number) => LANE_COLORS[color % LANE_COLORS.length]
const laneX = (lane: number) => LANE_PADDING + lane * LANE_WIDTH

export function graphColumnWidth(laneCount: number): number {
  const lanes = Math.min(Math.max(laneCount, 1), MAX_VISIBLE_LANES)
  return LANE_PADDING * 2 + (lanes - 1) * LANE_WIDTH
}

function VerticalLine({
  lane,
  color,
  top,
  bottom,
  height,
}: {
  lane: number
  color: number
  top: number
  bottom?: number
  height?: number
}) {
  return (
    <span
      className="absolute w-[1.5px] rounded-full"
      style={{
        left: laneX(lane) - 0.75,
        top,
        bottom: height === undefined ? (bottom ?? 0) : undefined,
        height,
        backgroundColor: laneColor(color),
      }}
    />
  )
}

/** One row of the commit graph, stretched to the full height of its row. */
export function GitLogGraphCell({
  row,
  width,
  nodeY,
  isHead,
}: {
  row: GraphRow
  width: number
  /** Vertical position of the commit node, in px from the row top. */
  nodeY: number
  isHead: boolean
}) {
  const bends = row.outgoing.filter((edge) => edge.to !== edge.from)
  return (
    <div
      className="relative shrink-0 self-stretch overflow-hidden"
      style={{ width }}
      aria-hidden
    >
      {row.passing.map(({ lane, color }) => (
        <VerticalLine key={`p${lane}`} lane={lane} color={color} top={0} />
      ))}
      {row.incoming.map((edge) => (
        <VerticalLine
          key={`i${edge.from}`}
          lane={edge.to}
          color={edge.color}
          top={0}
          height={nodeY}
        />
      ))}
      {row.outgoing.map((edge) => (
        <VerticalLine
          key={`o${edge.to}`}
          lane={edge.to}
          color={edge.color}
          top={edge.to === edge.from ? nodeY : nodeY + CURVE_HEIGHT}
        />
      ))}
      <svg
        className="absolute inset-x-0 top-0 overflow-visible"
        width={width}
        height={nodeY + CURVE_HEIGHT}
      >
        {bends.map((edge) => {
          const x1 = laneX(edge.from)
          const x2 = laneX(edge.to)
          const y2 = nodeY + CURVE_HEIGHT
          return (
            <path
              key={`b${edge.to}`}
              d={`M ${x1} ${nodeY} C ${x2} ${nodeY}, ${x2} ${nodeY}, ${x2} ${y2}`}
              fill="none"
              stroke={laneColor(edge.color)}
              strokeWidth={1.5}
            />
          )
        })}
        {isHead ? (
          <circle
            cx={laneX(row.lane)}
            cy={nodeY}
            r={4.5}
            className="fill-background"
            stroke={laneColor(row.color)}
            strokeWidth={2}
          />
        ) : (
          <circle
            cx={laneX(row.lane)}
            cy={nodeY}
            r={3.5}
            fill={laneColor(row.color)}
          />
        )}
      </svg>
    </div>
  )
}

export function isHeadCommit(refs: readonly GitLogRef[] | undefined): boolean {
  return !!refs?.some((ref) => ref.is_head || ref.kind === "head")
}

/** SourceTree-style branch / tag labels shown before the commit subject. */
export function GitLogRefBadges({ refs }: { refs: readonly GitLogRef[] }) {
  const t = useTranslations("Folder.gitLogTab")
  if (refs.length === 0) return null
  const visible = refs.slice(0, MAX_VISIBLE_REFS)
  const hidden = refs.slice(MAX_VISIBLE_REFS)
  const describe = (ref: GitLogRef) => {
    if (ref.is_head) return t("refCurrentBranch")
    if (ref.kind === "head") return t("refDetachedHead")
    if (ref.kind === "tag") return t("refTag")
    if (ref.kind === "remote") return t("refRemoteBranch")
    return t("refLocalBranch")
  }
  return (
    <>
      {visible.map((ref) => {
        const Icon =
          ref.kind === "tag" ? Tag : ref.kind === "remote" ? Cloud : GitBranch
        const current = ref.is_head || ref.kind === "head"
        return (
          <span
            key={`${ref.kind}:${ref.name}`}
            title={`${describe(ref)}: ${ref.name}`}
            className={cn(
              "inline-flex max-w-32 shrink-0 items-center gap-0.5 rounded border px-1 text-3xs font-medium leading-4",
              current
                ? "border-primary bg-primary text-primary-foreground"
                : ref.kind === "tag"
                  ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                  : ref.kind === "remote"
                    ? "border-border bg-muted text-muted-foreground"
                    : "border-primary/40 bg-primary/10 text-primary"
            )}
          >
            <Icon className="size-2.5 shrink-0" aria-hidden />
            <span className="truncate">{ref.name}</span>
          </span>
        )
      })}
      {hidden.length > 0 ? (
        <span
          className="shrink-0 rounded border border-border px-1 text-3xs leading-4 text-muted-foreground"
          title={hidden
            .map((ref) => `${describe(ref)}: ${ref.name}`)
            .join("\n")}
        >
          +{hidden.length}
        </span>
      ) : null}
    </>
  )
}
