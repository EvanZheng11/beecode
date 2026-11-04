"use client"

import * as React from "react"
import { Input } from "@/components/ui/input"
import {
  SearchClearButton,
  clearSearchInput,
} from "@/components/ui/search-clear-button"
import { cn } from "@/lib/utils"

export function SearchInput({
  className,
  wrapperClassName,
  ref,
  ...props
}: React.ComponentProps<"input"> & { wrapperClassName?: string }) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  return (
    <div className={cn("relative min-w-0 w-full", wrapperClassName)}>
      <Input
        {...props}
        ref={(node) => {
          inputRef.current = node
          if (typeof ref === "function") ref(node)
          else if (ref) ref.current = node
        }}
        className={cn(
          className,
          "!pe-9 [&::-webkit-search-cancel-button]:hidden"
        )}
      />
      {props.value && !props.disabled && !props.readOnly ? (
        <div className="absolute end-1 top-1/2 -translate-y-1/2">
          <SearchClearButton
            onClear={() => clearSearchInput(inputRef.current)}
          />
        </div>
      ) : null}
    </div>
  )
}
