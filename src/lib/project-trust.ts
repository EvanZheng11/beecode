import { getTransport } from "@/lib/transport"

export type ProjectTrustTarget = {
  agentType: string
  workspace: string
  resources: { path: string; kind: string; executesCode: boolean }[]
  warning: string
  trustFile?: string
}

export type ProjectTrustRequest = {
  requestId: string
  targets: ProjectTrustTarget[]
  createdAt: string
}

export type ProjectTrustAgent = {
  agentType: string
  displayName: string
  description: string
}

export type ProjectTrustBatchResult = {
  workspace: string
  success: boolean
  error?: string
}

export const pendingProjectTrust = () =>
  getTransport().call<ProjectTrustRequest[]>("project_trust_pending")
export const resolveProjectTrust = (requestId: string, approved: boolean) =>
  getTransport().call<void>("project_trust_resolve", { requestId, approved })
export const inspectProjectTrust = (agentType: string, workspaces: string[]) =>
  getTransport().call<ProjectTrustTarget[]>("project_trust_inspect", {
    agentType,
    workspaces,
  })
export const grantProjectTrust = (agentType: string, workspaces: string[]) =>
  getTransport().call<ProjectTrustBatchResult[]>("project_trust_grant_batch", {
    agentType,
    workspaces,
  })
export const projectTrustAgents = () =>
  getTransport().call<ProjectTrustAgent[]>("project_trust_agents")
