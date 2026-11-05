import * as React from "react"
import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

type EmptyStateProps = React.ComponentProps<"div"> & {
  icon?: LucideIcon
  description: React.ReactNode
  action?: React.ReactNode
}

function EmptyState({
  icon: Icon,
  description,
  action,
  className,
  children,
  ...props
}: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-4 py-8 text-center",
        className
      )}
      {...props}
    >
      {Icon && (
        <Icon
          className="size-7 text-muted-foreground/60"
          strokeWidth={1.4}
          aria-hidden="true"
        />
      )}
      <p className="max-w-md text-ui text-muted-foreground">{description}</p>
      {children}
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}

export { EmptyState, type EmptyStateProps }
