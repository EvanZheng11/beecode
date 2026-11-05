import * as React from "react"
import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

type StatCardProps = React.ComponentProps<"div"> & {
  label: React.ReactNode
  value: React.ReactNode
  icon?: LucideIcon
  description?: React.ReactNode
}

function StatCard({
  label,
  value,
  icon: Icon,
  description,
  className,
  ...props
}: StatCardProps) {
  return (
    <div
      data-slot="stat-card"
      className={cn("surface-glass rounded-2xl p-5", className)}
      {...props}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="mt-2 text-page-title font-semibold tabular-nums">
            {value}
          </p>
        </div>
        {Icon && (
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary-text">
            <Icon className="size-4" aria-hidden="true" />
          </span>
        )}
      </div>
      {description && (
        <p className="mt-2 text-xs text-muted-foreground">{description}</p>
      )}
    </div>
  )
}

export { StatCard, type StatCardProps }
