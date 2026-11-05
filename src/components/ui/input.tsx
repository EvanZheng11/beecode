import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "bg-card/80 border-input focus-visible:border-ring focus-visible:ring-ring/15 aria-invalid:ring-destructive/10 aria-invalid:border-destructive h-9 rounded-lg border px-3 py-1 text-base transition-colors file:h-7 file:text-sm file:font-medium focus-visible:ring-4 aria-invalid:ring-4 md:text-ui file:text-foreground placeholder:text-muted-foreground w-full min-w-0 outline-none file:inline-flex file:border-0 file:bg-transparent disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 read-only:bg-muted/40 read-only:text-muted-foreground read-only:cursor-default",
        className
      )}
      {...props}
    />
  )
}

export { Input }
