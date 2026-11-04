"use client"

import { useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { useResourceMonitor } from "@/hooks/use-resource-monitor"
import type {
  ResourceMonitorAction,
  ResourceMonitorProcess,
} from "@/lib/resource-monitor-types"
import { ResourceMonitorView } from "./resource-monitor-view"

export function ResourceMonitorSettings() {
  const monitor = useResourceMonitor()
  const t = useTranslations("ResourceMonitor")
  const [pending, setPending] = useState<{
    process: ResourceMonitorProcess
    action: ResourceMonitorAction
  } | null>(null)
  const confirmed = useRef(false)

  return (
    <>
      <ResourceMonitorView
        {...monitor}
        onEnabledChange={(enabled) => void monitor.changeEnabled(enabled)}
        onRetry={monitor.retry}
        onRequestAction={(process, action) => {
          if (monitor.actionBusy) return
          confirmed.current = false
          setPending({ process, action })
        }}
      />
      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {pending
                ? t("confirmDescription", {
                    action: t(`action.${pending.action}`),
                    name: pending.process.name,
                    pid: pending.process.pid,
                  })
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={monitor.actionBusy || !monitor.enabled}
              onClick={() => {
                if (!pending || confirmed.current) return
                confirmed.current = true
                void monitor.executeAction(pending.process, pending.action)
                setPending(null)
              }}
            >
              {t("confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
