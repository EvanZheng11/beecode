import * as React from "react"
import { cn } from "@/lib/utils"

type PageHeaderProps = Omit<React.ComponentProps<"header">, "title"> & {
  title: React.ReactNode
  eyebrow?: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
}

function PageHeader({
  title,
  eyebrow,
  description,
  actions,
  className,
  children,
  ...props
}: PageHeaderProps) {
  return (
    <header
      data-slot="page-header"
      className={cn("anim-fade-up mb-6 space-y-4", className)}
      {...props}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          {eyebrow && (
            <p className="mb-1 text-xs font-medium text-primary-text">
              {eyebrow}
            </p>
          )}
          <h1 className="text-page-title font-semibold tracking-[-0.02em] break-words">
            {title}
          </h1>
          {description && (
            <p className="mt-1.5 max-w-3xl text-sm text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {actions && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {actions}
          </div>
        )}
      </div>
      {children}
    </header>
  )
}

export { PageHeader, type PageHeaderProps }
