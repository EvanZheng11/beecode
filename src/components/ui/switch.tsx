import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-5.5 w-9.5 shrink-0 items-center rounded-full border border-transparent bg-muted-foreground/30 transition-colors outline-none focus-visible:ring-4 focus-visible:ring-ring/15 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-switch-on",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-4.5 rounded-full bg-switch-thumb shadow-sm ring-0 transition-transform data-[state=checked]:translate-x-[1.0625rem] data-[state=unchecked]:translate-x-px rtl:data-[state=checked]:-translate-x-[1.0625rem] rtl:data-[state=unchecked]:-translate-x-px"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
