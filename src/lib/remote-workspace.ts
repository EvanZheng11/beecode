import { getShellTransport } from "@/lib/transport"
import type {
  RemoteWorkspaceConnection,
  RemoteWorkspaceConnectionInput,
} from "@/lib/types"

export async function listRemoteWorkspaceConnections(): Promise<
  RemoteWorkspaceConnection[]
> {
  return getShellTransport().call("list_remote_workspace_connections")
}

export async function getRemoteWorkspaceConnection(
  id: number
): Promise<RemoteWorkspaceConnection> {
  return getShellTransport().call("get_remote_workspace_connection", { id })
}

export async function testRemoteWorkspaceConnection(
  input: RemoteWorkspaceConnectionInput
): Promise<void> {
  return getShellTransport().call("test_remote_workspace_connection", { input })
}

export async function createRemoteWorkspaceConnection(
  input: RemoteWorkspaceConnectionInput
): Promise<RemoteWorkspaceConnection> {
  return getShellTransport().call("create_remote_workspace_connection", {
    input,
  })
}

export async function updateRemoteWorkspaceConnection(
  id: number,
  input: RemoteWorkspaceConnectionInput
): Promise<RemoteWorkspaceConnection> {
  return getShellTransport().call("update_remote_workspace_connection", {
    id,
    input,
  })
}

export async function deleteRemoteWorkspaceConnection(
  id: number
): Promise<void> {
  return getShellTransport().call("delete_remote_workspace_connection", { id })
}

export async function reorderRemoteWorkspaceConnections(
  ids: number[]
): Promise<void> {
  return getShellTransport().call("reorder_remote_workspace_connections", {
    ids,
  })
}

/**
 * 打开（或聚焦已打开的）某个远程连接的工作区窗口。
 *
 * `target.conversationId` 是**远程**会话 id：远程委派卡片「查看会话」用它定位
 * 到具体会话。目前 `open_remote_workspace` 命令只接受 `id`，额外的
 * `conversationId` 参数不会被它读取（后端已按「连接 id → 窗口」聚焦），所以
 * 这里照常把目标传下去，等后端支持时无需再改前端调用方；后端仍需把该参数接到
 * 窗口 URL（`workspace?remoteConnectionId=…&conversationId=…`）上。
 */
export async function openRemoteWorkspace(
  id: number,
  target?: { conversationId?: number | null }
): Promise<void> {
  const conversationId = target?.conversationId ?? null
  if (conversationId === null) {
    return getShellTransport().call("open_remote_workspace", { id })
  }
  try {
    await getShellTransport().call("open_remote_workspace", {
      id,
      conversationId,
    })
  } catch {
    // 旧后端不认识 `conversationId` 时退化为「只打开/聚焦窗口」：跳转至少把远程
    // 工作区带到前台，不会因为多了个参数整条跳转失败。
    await getShellTransport().call("open_remote_workspace", { id })
  }
}

export async function openLocalWorkspace(): Promise<void> {
  return getShellTransport().call("open_local_workspace")
}

/**
 * 让本机 broker 重新同步一个处于 `unreachable` 的远程委派任务。
 *
 * 后端接入点尚未落地（RM01/RM03 的跟踪协程只在启动时自动重试）：命令名先按
 * `remote_delegation_resync` 约定调用，失败由调用方提示，不会影响已有的任务
 * 状态展示。
 */
export async function resyncRemoteDelegation(
  taskId: string,
  connectionId?: number | null
): Promise<void> {
  await getShellTransport().call("remote_delegation_resync", {
    taskId,
    connectionId: connectionId ?? null,
  })
}
