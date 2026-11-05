"use client"

import * as React from "react"
import { ToggleGroup } from "radix-ui"
import { cn } from "@/lib/utils"

function Segmented({
  className,
  ...props
}: React.ComponentProps<typeof ToggleGroup.Root>) {
  return (
    <ToggleGroup.Root
      data-slot="segmented"
      className={cn(
        "inline-flex w-fit items-center gap-0.5 rounded-lg bg-muted p-[0.1875rem]",
        className
      )}
      {...props}
    />
  )
}

function SegmentedItem({
  className,
  ...props
}: React.ComponentProps<typeof ToggleGroup.Item>) {
  return (
    <ToggleGroup.Item
      data-slot="segmented-item"
      className={cn(
        "inline-flex h-7 items-center justify-center gap-1.5 rounded-md px-3 text-ui font-medium text-foreground/70 outline-none transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-40 data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-sm [&_svg]:size-4",
        className
      )}
      {...props}
    />
  )
}

export { Segmented, SegmentedItem }
