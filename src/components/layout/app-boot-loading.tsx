"use client"

import { Loader2 } from "lucide-react"

export function AppBootLoading() {
  return (
    <div className="app-backdrop flex min-h-screen items-center justify-center text-foreground">
      <div className="flex items-center gap-3 px-2 py-1">
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
        <span className="text-sm font-medium tracking-tight">BeeCode</span>
      </div>
    </div>
  )
}
