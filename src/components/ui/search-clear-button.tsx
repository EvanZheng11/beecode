"use client"

import { useTranslations } from "next-intl"
import { X } from "lucide-react"

export function SearchClearButton({ onClear }: { onClear?: () => void }) {
  const t = useTranslations("Tasks")

  return (
    <button
      type="button"
      aria-label={t("clearSearch")}
      title={t("clearSearch")}
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
      onMouseDown={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") event.stopPropagation()
      }}
      onClick={(event) => {
        if (onClear) onClear()
        else
          clearSearchInput(
            event.currentTarget.parentElement?.querySelector("input") ?? null
          )
      }}
    >
      <X className="size-3.5" aria-hidden />
    </button>
  )
}

export function clearSearchInput(input: HTMLInputElement | null) {
  if (!input) return
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set
  setter?.call(input, "")
  input.dispatchEvent(new Event("input", { bubbles: true }))
  input.focus()
}
