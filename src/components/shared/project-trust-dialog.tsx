"use client"

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ProjectTrustTargets } from "./project-trust-targets"
import { onTransportReady, subscribe } from "@/lib/platform"
import {
  pendingProjectTrust,
  resolveProjectTrust,
  type ProjectTrustRequest,
} from "@/lib/project-trust"

export function ProjectTrustDialog() {
  const t = useTranslations("ProjectTrust")
  const [queue, setQueue] = useState<ProjectTrustRequest[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const resolved = useRef(new Set<string>())

  useEffect(() => {
    let disposed = false
    let revision = 0
    let readSequence = 0
    const receivedAt = new Map<string, number>()
    const unsubs: (() => void)[] = []
    const add = (items: ProjectTrustRequest[]) => {
      if (disposed) return
      setQueue((old) => {
        const seen = new Set(old.map((item) => item.requestId))
        return [
          ...old,
          ...items.filter((item) => {
            if (
              seen.has(item.requestId) ||
              resolved.current.has(item.requestId)
            )
              return false
            seen.add(item.requestId)
            return true
          }),
        ]
      })
    }
    const remove = (requestId: string) => {
      resolved.current.add(requestId)
      if (!disposed)
        setQueue((old) => old.filter((item) => item.requestId !== requestId))
    }
    const refresh = async () => {
      const startedAt = revision
      const sequence = ++readSequence
      try {
        const pending = await pendingProjectTrust()
        if (disposed || sequence !== readSequence) return
        const ids = new Set(pending.map((item) => item.requestId))
        setQueue((old) =>
          old.filter(
            (item) =>
              ids.has(item.requestId) ||
              (receivedAt.get(item.requestId) ?? 0) > startedAt
          )
        )
        add(pending)
      } catch (err) {
        console.error("[ProjectTrust] pending:", err)
      }
    }
    void (async () => {
      try {
        for (const [event, handler] of [
          [
            "project-trust-requested",
            (value: ProjectTrustRequest) => {
              receivedAt.set(value.requestId, ++revision)
              add([value])
            },
          ],
          [
            "project-trust-resolved",
            (value: { requestId: string }) => remove(value.requestId),
          ],
        ] as const) {
          const off = await subscribe(event, handler as (value: never) => void)
          if (disposed) off()
          else unsubs.push(off)
        }
      } catch (err) {
        console.error("[ProjectTrust] subscribe:", err)
      }
      if (!disposed) void refresh()
    })()
    const offReady = onTransportReady(() => void refresh())
    return () => {
      disposed = true
      unsubs.forEach((off) => off())
      offReady?.()
    }
  }, [])

  const current = queue[0]
  const decide = async (approved: boolean) => {
    if (!current || busy) return
    setBusy(true)
    setError("")
    try {
      await resolveProjectTrust(current.requestId, approved)
      resolved.current.add(current.requestId)
      setQueue((old) =>
        old.filter((item) => item.requestId !== current.requestId)
      )
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={!!current}>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t("requestTitle")}</DialogTitle>
          <DialogDescription>{t("requestDescription")}</DialogDescription>
        </DialogHeader>
        {current && <ProjectTrustTargets targets={current.targets} />}
        {error && (
          <p role="alert" className="break-all text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void decide(false)}
          >
            {t("deny")}
          </Button>
          <Button disabled={busy} onClick={() => void decide(true)}>
            {t("allow")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
