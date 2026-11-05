import * as React from "react"
import { cn } from "@/lib/utils"

// 只提供语义表格与分页外壳；排序、筛选和数据加载由业务页面负责。
function DataTable({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="data-table"
      className={cn(
        "overflow-hidden rounded-2xl border border-border bg-card",
        className
      )}
      {...props}
    />
  )
}

function DataTableContent({
  className,
  ...props
}: React.ComponentProps<"table">) {
  return (
    <div data-slot="data-table-scroll" className="overflow-auto">
      <table
        data-slot="data-table-content"
        className={cn("w-full table-fixed text-start text-ui", className)}
        {...props}
      />
    </div>
  )
}

function DataTableHeader({
  className,
  ...props
}: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="data-table-header"
      className={cn(
        "sticky top-0 z-10 bg-card/95 text-muted-foreground [&_th]:border-b [&_th]:px-3.5 [&_th]:py-2.5 [&_th]:text-start [&_th]:font-medium",
        className
      )}
      {...props}
    />
  )
}

function DataTableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="data-table-body"
      className={cn("[&_tr:last-child]:border-b-0", className)}
      {...props}
    />
  )
}

function DataTableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="data-table-row"
      className={cn(
        "h-11 border-b border-foreground/5 transition-colors duration-150 hover:bg-primary/4",
        className
      )}
      {...props}
    />
  )
}

function DataTableCell({
  className,
  children,
  title,
  ...props
}: React.ComponentProps<"td">) {
  const label =
    title ??
    (typeof children === "string" || typeof children === "number"
      ? String(children)
      : undefined)
  return (
    <td
      data-slot="data-table-cell"
      title={label}
      className={cn("truncate px-3.5 py-2 text-start", className)}
      {...props}
    >
      {children}
    </td>
  )
}

function DataTableEmpty({
  children,
  className,
  ...props
}: React.ComponentProps<"td">) {
  return (
    <tr data-slot="data-table-empty">
      <td
        className={cn("h-40 px-4 text-center text-muted-foreground", className)}
        {...props}
      >
        {children}
      </td>
    </tr>
  )
}

function DataTableFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="data-table-footer"
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 border-t px-5 py-3 text-xs text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  DataTable,
  DataTableContent,
  DataTableHeader,
  DataTableBody,
  DataTableRow,
  DataTableCell,
  DataTableEmpty,
  DataTableFooter,
}
