"use client"

import { useEffect, useState } from "react"
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
import { DirectoryBrowser } from "@/components/shared/directory-browser"
import { ProjectTrustTargets } from "@/components/shared/project-trust-targets"
import {
  grantProjectTrust,
  inspectProjectTrust,
  projectTrustAgents,
  type ProjectTrustAgent,
  type ProjectTrustBatchResult,
  type ProjectTrustTarget,
} from "@/lib/project-trust"

export function ProjectTrustSettings() {
  const t = useTranslations("ProjectTrust")
  const [open, setOpen] = useState(false)
  const [agents, setAgents] = useState<ProjectTrustAgent[]>([])
  const [agent, setAgent] = useState("")
  const [path, setPath] = useState("")
  const [selected, setSelected] = useState<string[]>([])
  const [targets, setTargets] = useState<ProjectTrustTarget[] | null>(null)
  const [results, setResults] = useState<ProjectTrustBatchResult[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!open) return
    let live = true
    void projectTrustAgents()
      .then((items) => {
        if (!live) return
        setAgents(items)
        setAgent(items[0]?.agentType ?? "")
      })
      .catch((err) => {
        if (live) setError(String(err))
      })
    return () => {
      live = false
    }
  }, [open])

  const close = () => {
    setOpen(false)
    setSelected([])
    setTargets(null)
    setResults(null)
    setError("")
  }
  const inspect = async () => {
    if (!agent || !selected.length || busy) return
    setBusy(true)
    setError("")
    try {
      const result = await inspectProjectTrust(agent, selected)
      if (result.length !== selected.length) {
        setError(t("incompleteInspection"))
        return
      }
      setTargets(result)
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }
  const grant = async () => {
    if (!targets || busy) return
    setBusy(true)
    setError("")
    try {
      const response = await grantProjectTrust(agent, selected)
      setResults(response)
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        {t("batchTitle")}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!value && !busy) close()
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("batchTitle")}</DialogTitle>
            <DialogDescription>{t("inheritance")}</DialogDescription>
          </DialogHeader>
          {!targets ? (
            <div className="space-y-3">
              <label className="block text-sm">
                {t("agent")}
                <select
                  className="mt-1 w-full rounded-md border bg-background p-2"
                  value={agent}
                  onChange={(event) => setAgent(event.target.value)}
                >
                  {agents.map((item) => (
                    <option key={item.agentType} value={item.agentType}>
                      {item.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-xs text-muted-foreground">
                {agents.find((item) => item.agentType === agent)?.description}
              </p>
              <DirectoryBrowser
                active={open}
                value={path}
                onValueChange={setPath}
                multiple
                selectedPaths={selected}
                onToggleSelected={(item) =>
                  setSelected((old) =>
                    old.includes(item)
                      ? old.filter((p) => p !== item)
                      : [...old, item]
                  )
                }
              />
              {path && (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.includes(path)}
                    onChange={() =>
                      setSelected((old) =>
                        old.includes(path)
                          ? old.filter((p) => p !== path)
                          : [...old, path]
                      )
                    }
                  />
                  {t("selectCurrent")}:{" "}
                  <span className="break-all">{path}</span>
                </label>
              )}
              <div className="max-h-24 overflow-auto text-xs">
                {selected.map((item) => (
                  <p className="break-all" key={item}>
                    {item}
                  </p>
                ))}
              </div>
            </div>
          ) : results ? (
            <div role="status" className="max-h-80 overflow-auto text-sm">
              {results.map((result, index) => (
                <p key={`${result.workspace}:${index}`} className="break-all">
                  {result.workspace}:{" "}
                  {result.success
                    ? t("granted")
                    : `${t("failed")}: ${result.error ?? ""}`}
                </p>
              ))}
            </div>
          ) : (
            <>
              <p className="text-sm">{t("confirmDescription")}</p>
              <div className="max-h-24 overflow-auto text-sm">
                {selected.map((item) => (
                  <p className="break-all" key={item}>
                    {item}
                  </p>
                ))}
              </div>
              <ProjectTrustTargets targets={targets} />
            </>
          )}
          {error && (
            <p role="alert" className="break-all text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                if (results) close()
                else if (targets) setTargets(null)
                else close()
              }}
            >
              {results ? t("done") : targets ? t("back") : t("cancel")}
            </Button>
            {results ? null : targets ? (
              <Button disabled={busy} onClick={() => void grant()}>
                {t("allowAll")}
              </Button>
            ) : (
              <Button
                disabled={busy || !agent || !selected.length}
                onClick={() => void inspect()}
              >
                {t("review")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
