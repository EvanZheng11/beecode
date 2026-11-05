"use client"

import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

/** A one-line notice at the top of a settings tab, with an optional way to act
 *  on it. The glyph sits in a box one text line tall, so it centres on the
 *  first line however the message wraps (the trick `SettingNote` uses). */
export function PanelNotice({
  tone,
  icon,
  action,
  children,
}: {
  tone: "warning" | "muted"
  icon: ReactNode
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-5",
        tone === "warning"
          ? "border-tone-warning/30 bg-tone-warning/5 text-tone-warning"
          : "border-border/70 bg-muted/40 text-muted-foreground"
      )}
    >
      <span className="flex h-5 w-3.5 shrink-0 items-center justify-center">
        {icon}
      </span>
      <p className="min-w-0 flex-1">{children}</p>
      {action ? <div className="shrink-0 self-center">{action}</div> : null}
    </div>
  )
}
