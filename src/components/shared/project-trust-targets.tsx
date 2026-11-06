"use client"

import { useTranslations } from "next-intl"
import type { ProjectTrustTarget } from "@/lib/project-trust"

export function ProjectTrustTargets({
  targets,
}: {
  targets: ProjectTrustTarget[]
}) {
  const t = useTranslations("ProjectTrust")
  return (
    <div className="max-h-80 space-y-4 overflow-auto text-sm">
      {targets.map((target, index) => (
        <section
          key={`${target.agentType}:${target.workspace}:${index}`}
          className="space-y-1 border-b pb-3"
        >
          <div className="font-medium break-all">
            {target.agentType}: {target.workspace}
          </div>
          {target.warning && (
            <p className="text-tone-warning">{target.warning}</p>
          )}
          {target.trustFile && (
            <p className="break-all">
              {t("trustFile")}: {target.trustFile}
            </p>
          )}
          {target.resources.map((resource, i) => (
            <p
              key={`${resource.path}:${i}`}
              className="break-all text-muted-foreground"
            >
              {resource.path} ({resource.kind}
              {resource.executesCode ? `, ${t("executesCode")}` : ""})
            </p>
          ))}
        </section>
      ))}
    </div>
  )
}
