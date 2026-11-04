"use client"

import { useSyncExternalStore } from "react"

const KEY = "workspace:show-quick-messages"
const listeners = new Set<() => void>()
let unstored: boolean | undefined

function read(): boolean {
  if (unstored !== undefined) return unstored
  if (typeof window === "undefined") return false
  try {
    return window.localStorage.getItem(KEY) === "true"
  } catch {
    return false
  }
}

function notify() {
  for (const listener of listeners) listener()
}

function onStorage(event: StorageEvent) {
  if (event.key !== null && event.key !== KEY) return
  unstored = undefined
  notify()
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) window.addEventListener("storage", onStorage)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) window.removeEventListener("storage", onStorage)
  }
}

/** 同步当前窗口的输入框，并记住显示偏好。 */
export function saveQuickMessagesVisible(visible: boolean) {
  try {
    window.localStorage.setItem(KEY, String(visible))
    unstored = undefined
  } catch {
    unstored = visible
  }
  notify()
}

export function useQuickMessagesVisible(): boolean {
  return useSyncExternalStore(subscribe, read, () => false)
}
