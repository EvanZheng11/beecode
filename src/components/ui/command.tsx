"use client"

import * as React from "react"
import { Command as CommandPrimitive, useCommandState } from "cmdk"
import { Search } from "lucide-react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { VisuallyHidden } from "radix-ui"
import {
  SearchClearButton,
  clearSearchInput,
} from "@/components/ui/search-clear-button"

function Command({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        "bg-popover text-popover-foreground flex h-full w-full flex-col overflow-hidden rounded-md",
        className
      )}
      {...props}
    />
  )
}

function CommandDialog({
  title = "Command",
  children,
  shouldFilter,
  onOpenAutoFocus,
  ...props
}: React.ComponentProps<typeof Dialog> &
  Pick<React.ComponentProps<typeof DialogContent>, "onOpenAutoFocus"> & {
    title?: string
    shouldFilter?: boolean
  }) {
  return (
    <Dialog {...props}>
      <DialogContent
        className="overflow-hidden p-0 rounded-3xl max-w-lg md:max-w-xl lg:max-w-2xl"
        closeButtonClassName="top-1.5 z-10"
        onOpenAutoFocus={onOpenAutoFocus}
      >
        <VisuallyHidden.Root>
          <DialogTitle>{title}</DialogTitle>
        </VisuallyHidden.Root>
        <Command
          shouldFilter={shouldFilter}
          className="bg-transparent [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group]]:px-2 [&_[cmdk-input-wrapper]]:pe-10 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3"
        >
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  )
}

function CommandInput({
  className,
  ref,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  const search = useCommandState((state) => state.search)
  const inputRef = React.useRef<HTMLInputElement>(null)
  return (
    <div className="flex items-center border-b px-3" cmdk-input-wrapper="">
      <Search className="me-2 h-4 w-4 shrink-0 opacity-50" />
      <CommandPrimitive.Input
        ref={(node) => {
          inputRef.current = node
          if (typeof ref === "function") ref(node)
          else if (ref) ref.current = node
        }}
        data-slot="command-input"
        className={cn(
          "placeholder:text-muted-foreground flex h-10 min-w-0 w-full rounded-md bg-transparent py-3 text-ui outline-none disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        {...props}
      />
      {(props.value ?? search) && !props.disabled && !props.readOnly ? (
        <SearchClearButton onClear={() => clearSearchInput(inputRef.current)} />
      ) : null}
    </div>
  )
}

function CommandList({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        "max-h-[18.75rem] overflow-y-auto overflow-x-hidden",
        className
      )}
      {...props}
    />
  )
}

function CommandEmpty({
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className="py-6 text-center text-ui"
      {...props}
    />
  )
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "text-foreground [&_[cmdk-group-heading]]:text-muted-foreground overflow-hidden p-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium",
        className
      )}
      {...props}
    />
  )
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn("bg-border -mx-1 h-px", className)}
      {...props}
    />
  )
}

function CommandItem({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground in-data-[theme=apple]:data-[selected=true]:bg-primary in-data-[theme=apple]:data-[selected=true]:text-primary-foreground in-data-[theme=apple]:data-[selected=true]:**:text-primary-foreground relative flex cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-ui outline-none select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        className
      )}
      {...props}
    />
  )
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandSeparator,
  CommandItem,
}
