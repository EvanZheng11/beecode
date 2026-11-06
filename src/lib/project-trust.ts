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

/** 信任目录树的一级条目；`path` 是后端返回的真实绝对路径。 */
export type ProjectTrustDirectory = {
  name: string
  path: string
  hasChildren: boolean
}

/**
 * 只读枚举本机目录，用于批量信任时逐层勾选。
 *
 * `path` 缺失或为 `null` 时返回本机根节点（Unix 根 `/`，Windows 全部可用盘符）；
 * 传入绝对目录时返回其一级子目录（含隐藏目录，已排除 `.DS_Store`）。
 * 该调用只读枚举，不会自动授信任何目录。
 */
export const projectTrustDirectories = (path?: string | null) =>
  getTransport().call<ProjectTrustDirectory[]>("project_trust_directories", {
    path: path ?? null,
  })

export const pendingProjectTrust = () =>
  getTransport().call<ProjectTrustRequest[]>("project_trust_pending")
export const resolveProjectTrust = (requestId: string, approved: boolean) =>
  getTransport().call<void>("project_trust_resolve", { requestId, approved })
export const inspectProjectTrust = (agentType: string, workspaces: string[]) =>
  getTransport().call<ProjectTrustTarget[]>("project_trust_inspect", {
    agentType,
    workspaces,
  })
export const grantProjectTrust = (targets: ProjectTrustTarget[]) =>
  getTransport().call<ProjectTrustBatchResult[]>("project_trust_grant_batch", {
    targets,
  })
export const projectTrustAgents = () =>
  getTransport().call<ProjectTrustAgent[]>("project_trust_agents")
