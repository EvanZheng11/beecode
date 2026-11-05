import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "border-input bg-card/80 focus-visible:border-ring focus-visible:ring-ring/15 aria-invalid:ring-destructive/10 aria-invalid:border-destructive resize-none rounded-lg border px-3 py-2 text-base transition-colors focus-visible:ring-4 aria-invalid:ring-4 md:text-ui placeholder:text-muted-foreground flex field-sizing-content min-h-16 w-full outline-none disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
