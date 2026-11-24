"use client"

/**
 * A `computer://share-request`: an agent needs windows shared and asks the
 * person here, instead of leaving a "go and share it in the status bar" note
 * in the conversation.
 *
 * It lists exactly what the agent asked for — never the whole desktop, which
 * is `computer-window-picker`'s job — with what each window is shared for now
 * and the level being asked for. Nothing is ticked to begin with, because a
 * request is a question and not a consent: the person marks the ones they
 * mean, and only those are shared (`computer_share_request_decide`).
 *
 * Mounted beside the browser's confirm and not inside a status bar popover:
 * the popover is closed most of the time, and a question nobody can see is a
 * question that lapses.
 *
 * Refusing is the default in every direction — the button, Escape, the dialog
 * being dismissed. Running out of time is not an answer at all: the backend
 * holds the same deadline and refuses it there, so this side only stops
 * showing the question. The same goes for `computer://share-request-closed`
 * (answered elsewhere, lapsed, or the agent gave up): the dialog goes,
 * unanswered, and its id is never sent afterwards.
 */

import { useCallback, useEffect, useRef, useState } from "react"

import { AppWindow, Share2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { toErrorMessage } from "@/lib/app-error"
import {
  computerShareRequestCurrent,
  computerShareRequestDecide,
} from "@/lib/computer/computer-api"
import {
  COMPUTER_SHARE_REQUEST_CLOSED_EVENT,
  COMPUTER_SHARE_REQUEST_EVENT,
  type ShareRequestPayload,
  type ShareRequestSignal,
} from "@/lib/computer/types"
import { getShellTransport, isDesktop } from "@/lib/transport"

/** The windows ticked, and which question they were ticked for: a new
 *  request starts with none, without anything having to remember to clear
 *  the old ones. */
interface Selection {
  requestId: string
  ids: Set<string>
}

const NONE: Selection = { requestId: "", ids: new Set() }

/** How often the deadline is checked. The backend refuses on its own at the
 *  same moment; this only decides when to stop showing the question. */
const TICK_MS = 1000

export function ComputerShareRequestConfirm() {
  const t = useTranslations("ComputerUse.request")
  const tLevel = useTranslations("ComputerUse.level")
  const tPicker = useTranslations("ComputerUse.picker")
  const [pending, setPending] = useState<ShareRequestPayload | null>(null)
  const [selection, setSelection] = useState<Selection>(NONE)
  const [answering, setAnswering] = useState(false)
  /** Requests this window has answered, or been told are gone. A second
   *  answer for one of these — a double press, a closed event arriving late —
   *  is a stale reply. */
  const settled = useRef<Set<string>>(new Set())

  const send = useCallback(
    (requestId: string, targetIds: string[]): boolean => {
      if (settled.current.has(requestId)) return false
      settled.current.add(requestId)
      void computerShareRequestDecide(requestId, targetIds)
        .then((ok) => {
          if (!ok && targetIds.length > 0) toast.error(t("failed"))
        })
        .catch((error: unknown) => {
          // A refusal that could not be delivered is still a refusal: the
          // backend takes no answer as one. A selection that could not be
          // sent is worth reporting — the agent will not get its windows.
          if (targetIds.length > 0) {
            toast.error(t("failed"), { description: toErrorMessage(error) })
          }
        })
        .finally(() => setAnswering(false))
      return true
    },
    [t]
  )

  const refuse = useCallback(
    (requestId: string) => {
      setPending((current) =>
        current?.requestId === requestId ? null : current
      )
      setSelection(NONE)
      send(requestId, [])
    },
    [send]
  )

  const confirm = useCallback(
    (request: ShareRequestPayload, targetIds: string[]) => {
      setPending((current) =>
        current?.requestId === request.requestId ? null : current
      )
      setSelection(NONE)
      setAnswering(true)
      if (!send(request.requestId, targetIds)) setAnswering(false)
    },
    [send]
  )

  useEffect(() => {
    // The windows are this computer's: nothing to ask in a browser window,
    // and a server has no computer use to share.
    if (!isDesktop()) return
    let cancelled = false
    let unsubscribe: (() => void) | undefined
    let unsubscribeClosed: (() => void) | undefined
    void (async () => {
      // This app's own backend, as for every computer event (see
      // `computer-api.ts`): the windows an agent asks about are of this
      // computer.
      const transport = getShellTransport()
      const subClosed = await transport.subscribe<ShareRequestSignal>(
        COMPUTER_SHARE_REQUEST_CLOSED_EVENT,
        ({ requestId }) => {
          settled.current.add(requestId)
          setPending((current) =>
            current?.requestId === requestId ? null : current
          )
        }
      )
      if (cancelled) {
        subClosed()
        return
      }
      unsubscribeClosed = subClosed
      const sub = await transport.subscribe<ShareRequestSignal>(
        COMPUTER_SHARE_REQUEST_EVENT,
        ({ requestId }) => {
          // 通知只负责唤醒；标题、权限和可选项一律从本机后端读取。
          if (settled.current.has(requestId)) return
          void computerShareRequestCurrent(requestId)
            .then((request) => {
              if (
                cancelled ||
                !request ||
                request.requestId !== requestId ||
                settled.current.has(requestId) ||
                request.expiresAt <= Date.now()
              ) {
                return
              }
              setAnswering(false)
              setPending((current) =>
                current?.requestId === requestId ? current : request
              )
            })
            .catch(() => {})
        }
      )
      if (cancelled) sub()
      else unsubscribe = sub
    })().catch(() => unsubscribeClosed?.())
    return () => {
      cancelled = true
      unsubscribe?.()
      unsubscribeClosed?.()
    }
  }, [])

  // Out of time is the backend's refusal, not one of ours: it holds the same
  // deadline. This only takes the question off screen, because a dialog left
  // standing over a request nobody waits on is one somebody eventually
  // answers.
  useEffect(() => {
    if (!pending) return
    const timer = window.setInterval(() => {
      if (Date.now() < pending.expiresAt) return
      settled.current.add(pending.requestId)
      setPending((current) =>
        current?.requestId === pending.requestId ? null : current
      )
      setSelection(NONE)
    }, TICK_MS)
    return () => window.clearInterval(timer)
  }, [pending])

  if (!pending) return null
  const { requestId, requestedLevel, windows } = pending
  const level = tLevel(requestedLevel)
  const ticked = selection.requestId === requestId ? selection.ids : NONE.ids
  const chosen = windows.filter((w) => ticked.has(w.targetId))
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // Escape, or anything else that closes it: a refusal, and never a
        // silent one.
        if (!open && !answering) refuse(requestId)
      }}
    >
      <DialogContent className="max-w-lg" data-testid="share-request-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Share2 className="h-4 w-4 shrink-0 text-primary" />
            {t("title")}
          </DialogTitle>
          <DialogDescription>{t("description", { level })}</DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-72">
          <ul className="flex flex-col gap-1 pe-2">
            {windows.map((w) => {
              const id = `share-request-${w.targetId}`
              const shared =
                w.level === "none" ? tPicker("levelNone") : tLevel(w.level)
              return (
                <li key={w.targetId}>
                  <label
                    htmlFor={id}
                    className="flex cursor-pointer items-start gap-2.5 rounded-xl px-2 py-2 transition-colors hover:bg-accent/60"
                  >
                    <Checkbox
                      id={id}
                      checked={ticked.has(w.targetId)}
                      onCheckedChange={(state) => {
                        setSelection((current) => {
                          const ids = new Set(
                            current.requestId === requestId
                              ? current.ids
                              : NONE.ids
                          )
                          if (state === true) ids.add(w.targetId)
                          else ids.delete(w.targetId)
                          return { requestId, ids }
                        })
                      }}
                      className="mt-0.5"
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="flex min-w-0 items-center gap-1.5 text-sm">
                        <AppWindow className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        {/* The window's own text, shown as text: a title with
                            markup in it is a title, not markup. */}
                        <span className="truncate">
                          {w.title || tPicker("untitled")}
                        </span>
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {`${w.appName || tPicker("unnamedApp")} · ${shared}`}
                      </span>
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
        </ScrollArea>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={answering}
            onClick={() => refuse(requestId)}
          >
            {t("deny")}
          </Button>
          <Button
            disabled={answering || chosen.length === 0}
            onClick={() =>
              confirm(
                pending,
                chosen.map((w) => w.targetId)
              )
            }
          >
            {t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
