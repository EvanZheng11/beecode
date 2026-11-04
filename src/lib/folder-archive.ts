"use client"

import { useSyncExternalStore } from "react"
import { getActiveRemoteConnectionId } from "@/lib/transport"
import type { FolderDetail } from "@/lib/types"

const EVENT = "workspace:folder-archive-changed"
const EMPTY: readonly string[] = []
let cachedRaw: string | null = null
let cached: readonly string[] = EMPTY

function key() {
  return `workspace:archived-folders:${getActiveRemoteConnectionId() ?? "local"}`
}

function snapshot(): readonly string[] {
  if (typeof window === "undefined") return EMPTY
  let raw: string | null
  try {
    raw = localStorage.getItem(key())
  } catch {
    return EMPTY
  }
  if (raw === cachedRaw) return cached
  cachedRaw = raw
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : []
    cached = Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : EMPTY
  } catch {
    cached = EMPTY
  }
  return cached
}

function subscribe(callback: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === key() || event.key === null) callback()
  }
  window.addEventListener(EVENT, callback)
  window.addEventListener("storage", onStorage)
  return () => {
    window.removeEventListener(EVENT, callback)
    window.removeEventListener("storage", onStorage)
  }
}

/** 归档是当前设备的目录显示偏好，按后端和路径隔离，不删除会话或磁盘内容。 */
export function useArchivedFolderPaths() {
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY)
}

export function setFoldersArchived(
  paths: readonly string[],
  archived: boolean
) {
  const next = new Set(snapshot())
  for (const path of paths) {
    if (archived) next.add(path)
    else next.delete(path)
  }
  localStorage.setItem(key(), JSON.stringify([...next]))
  window.dispatchEvent(new Event(EVENT))
}

export function excludeArchivedFolders(
  folders: readonly FolderDetail[],
  archivedPaths: readonly string[]
): FolderDetail[] {
  const paths = new Set(archivedPaths)
  const ids = new Set(folders.filter((f) => paths.has(f.path)).map((f) => f.id))
  return folders.filter(
    (f) => !ids.has(f.id) && (f.parent_id == null || !ids.has(f.parent_id))
  )
}
