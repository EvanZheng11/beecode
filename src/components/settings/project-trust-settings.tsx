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
import { ProjectTrustDirectoryTree } from "@/components/shared/project-trust-directory-tree"
import { ProjectTrustTargets } from "@/components/shared/project-trust-targets"
import { toErrorMessage } from "@/lib/app-error"
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
  const [selected, setSelected] = useState<string[]>([])
  const [targets, setTargets] = useState<ProjectTrustTarget[] | null>(null)
  const [results, setResults] = useState<ProjectTrustBatchResult[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  // 同步防抖：`busy` 是异步 state，同一 tick 内连点两次会在它更新前都通过检查。
  const inFlight = useRef(false)

  useEffect(() => {
    if (!open) return
    let live = true
    void projectTrustAgents()
      .then((items) => {
        if (!live) return
        setAgents(items)
        setAgent((current) => current || (items[0]?.agentType ?? ""))
      })
      .catch((err) => {
        if (live) setError(toErrorMessage(err))
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
    inFlight.current = false
  }

  const inspect = async () => {
    if (!agent || !selected.length || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError("")
    // 快照当前选择：审查返回前用户仍可能改动勾选，授权必须以已审快照为准。
    const snapshot = [...selected]
    try {
      const result = await inspectProjectTrust(agent, snapshot)
      const covered = new Set(result.map((item) => item.workspace))
      if (
        result.length !== snapshot.length ||
        snapshot.some((workspace) => !covered.has(workspace))
      ) {
        setError(t("incompleteInspection"))
        return
      }
      setTargets(result)
    } catch (err) {
      setError(toErrorMessage(err))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const grant = async () => {
    // 以已审 targets 的智能体与工作区为准，而不是可变的 agent/selected。
    if (!targets || inFlight.current) return
    const approvedAgent = targets[0]?.agentType
    const approvedWorkspaces = targets.map((item) => item.workspace)
    if (!approvedAgent || !approvedWorkspaces.length) return
    inFlight.current = true
    setBusy(true)
    setError("")
    try {
      const response = await grantProjectTrust(
        approvedAgent,
        approvedWorkspaces
      )
      // 后端按每个工作区返回一条结果；缺失的项不能当作授权成功显示。
      const byWorkspace = new Map(
        response.map((item) => [item.workspace, item])
      )
      setResults(
        approvedWorkspaces.map(
          (workspace) =>
            byWorkspace.get(workspace) ?? {
              workspace,
              success: false,
              error: t("missingResult"),
            }
        )
      )
    } catch (err) {
      setError(toErrorMessage(err))
    } finally {
      inFlight.current = false
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
                  className="mt-1 w-full rounded-lg border bg-background p-2 text-sm"
                  value={agent}
                  disabled={busy}
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
              <ProjectTrustDirectoryTree
                active={open}
                disabled={busy}
                selectedPaths={selected}
                onToggleSelected={(item) =>
                  setSelected((old) =>
                    old.includes(item)
                      ? old.filter((p) => p !== item)
                      : [...old, item]
                  )
                }
              />
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
                {targets.map((item) => (
                  <p className="break-all" key={item.workspace}>
                    {item.workspace}
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
