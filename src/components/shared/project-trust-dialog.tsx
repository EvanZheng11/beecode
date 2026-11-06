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
  // 同步防抖：`busy` 是异步 state，同一 tick 内连点两次会在它更新前都通过检查。
  const inFlight = useRef(false)

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
      if (disposed) return
      setQueue((old) => old.filter((item) => item.requestId !== requestId))
      // 上一个请求的失败提示不能残留到下一个请求的对话框里。
      setError("")
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
    // 后台 one-shot 可能使用静默 emitter；补拉不依赖当前会话或事件送达。
    // 聚焦立即检查，页面可见时每五秒兜底，确保用户有机会回答后台请求。
    const onFocus = () => void refresh()
    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh()
    }, 5_000)
    window.addEventListener("focus", onFocus)
    return () => {
      disposed = true
      window.clearInterval(poll)
      window.removeEventListener("focus", onFocus)
      unsubs.forEach((off) => off())
      offReady?.()
    }
  }, [])

  const current = queue[0]
  const decide = async (approved: boolean) => {
    if (!current || inFlight.current) return
    inFlight.current = true
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
      inFlight.current = false
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
