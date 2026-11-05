"use client"

import { FolderOpen } from "lucide-react"
import { useTranslations } from "next-intl"

export function AuxPanelNoFolderEmpty() {
  const t = useTranslations("Folder.auxPanel")
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-8 text-center">
      <FolderOpen
        className="size-7 text-muted-foreground/60"
        strokeWidth={1.4}
        aria-hidden
      />
      <p className="text-ui font-medium">{t("noFolderTitle")}</p>
      <p className="text-xs text-muted-foreground">{t("noFolderHint")}</p>
    </div>
  )
}
