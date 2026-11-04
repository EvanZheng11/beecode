"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { getTransport } from "@/lib/transport"
import { toErrorMessage } from "@/lib/app-error"
import type {
  ResourceMonitorAction,
  ResourceMonitorHistoryPoint,
  ResourceMonitorProcess,
  ResourceMonitorSettings,
  ResourceMonitorSnapshot,
} from "@/lib/resource-monitor-types"

const INTERVAL_MS = 2000
const HISTORY_LIMIT = 60

export function useResourceMonitor() {
  const [enabled, setEnabled] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [paused, setPaused] = useState(false)
  const [snapshot, setSnapshot] = useState<ResourceMonitorSnapshot | null>(null)
  const [history, setHistory] = useState<ResourceMonitorHistoryPoint[]>([])
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionBusy, setActionBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const mounted = useRef(false)
  const epoch = useRef(0)
  const sampleInFlight = useRef(false)
  const settingsInFlight = useRef(false)
  const actionInFlight = useRef(false)
  const enabledRef = useRef(false)

  const loadSettings = useCallback(async () => {
    if (settingsInFlight.current) return
    settingsInFlight.current = true
    setLoading(true)
    setError(null)
    try {
      const settings = await getTransport().call<ResourceMonitorSettings>(
        "get_resource_monitor_settings"
      )
      if (!mounted.current) return
      enabledRef.current = settings.enabled
      setEnabled(settings.enabled)
    } catch (cause) {
      if (mounted.current) setError(toErrorMessage(cause))
    } finally {
      settingsInFlight.current = false
      if (mounted.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void loadSettings()
    return () => {
      mounted.current = false
      epoch.current += 1
    }
  }, [loadSettings])

  // 只在可见页面串行取样；跨生命周期的旧响应不能恢复已关闭的监控。
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const clear = () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    }
    const run = async (version: number) => {
      if (version !== epoch.current || !enabledRef.current || document.hidden) {
        return
      }
      if (sampleInFlight.current) {
        timer = setTimeout(() => void run(version), INTERVAL_MS)
        return
      }
      sampleInFlight.current = true
      try {
        const next = await getTransport().call<ResourceMonitorSnapshot>(
          "get_resource_monitor_snapshot"
        )
        if (version !== epoch.current || !mounted.current) return
        if (!next.enabled) {
          enabledRef.current = false
          setEnabled(false)
          setSnapshot(null)
          setHistory([])
          return
        }
        setSnapshot(next)
        setError(null)
        setHistory((current) => {
          if (current[current.length - 1]?.sampledAt === next.sampledAt) {
            return current
          }
          return [
            ...current,
            {
              sampledAt: next.sampledAt,
              cpuPercent: next.totalCpuPercent,
              memoryBytes: next.totalMemoryBytes,
            },
          ].slice(-HISTORY_LIMIT)
        })
      } catch (cause) {
        if (version === epoch.current && mounted.current) {
          setError(toErrorMessage(cause))
        }
      } finally {
        sampleInFlight.current = false
        if (
          version === epoch.current &&
          enabledRef.current &&
          !document.hidden
        ) {
          timer = setTimeout(() => void run(version), INTERVAL_MS)
        }
      }
    }
    const visibility = () => {
      clear()
      const version = ++epoch.current
      setPaused(document.hidden)
      if (enabled && !document.hidden) void run(version)
    }
    document.addEventListener("visibilitychange", visibility)
    visibility()
    return () => {
      clear()
      epoch.current += 1
      document.removeEventListener("visibilitychange", visibility)
    }
  }, [enabled, revision])

  const changeEnabled = useCallback(async (next: boolean) => {
    if (settingsInFlight.current || actionInFlight.current) return
    settingsInFlight.current = true
    setSaving(true)
    setError(null)
    // 关停不等网络响应：立即使正在返回的样本失效。
    const previous = enabledRef.current
    if (!next) {
      enabledRef.current = false
      epoch.current += 1
      setEnabled(false)
      setSnapshot(null)
      setHistory([])
    }
    try {
      const saved = await getTransport().call<ResourceMonitorSettings>(
        "set_resource_monitor_enabled",
        { enabled: next }
      )
      if (!mounted.current) return
      enabledRef.current = saved.enabled
      setEnabled(saved.enabled)
      if (!saved.enabled) {
        setSnapshot(null)
        setHistory([])
      }
    } catch (cause) {
      if (mounted.current) {
        enabledRef.current = previous
        setEnabled(previous)
        setError(toErrorMessage(cause))
      }
    } finally {
      settingsInFlight.current = false
      if (mounted.current) setSaving(false)
    }
  }, [])

  const executeAction = useCallback(
    async (process: ResourceMonitorProcess, action: ResourceMonitorAction) => {
      const allowed =
        action === "stop"
          ? process.canStop
          : action === "kill"
            ? process.canKill
            : process.canRestart
      if (
        !allowed ||
        !enabledRef.current ||
        actionInFlight.current ||
        settingsInFlight.current
      ) {
        return
      }
      actionInFlight.current = true
      setActionBusy(true)
      setActionError(null)
      try {
        await getTransport().call("resource_monitor_process_action", {
          pid: process.pid,
          startTime: process.startTime,
          action,
        })
        if (mounted.current) setRevision((value) => value + 1)
      } catch (cause) {
        if (mounted.current) setActionError(toErrorMessage(cause))
      } finally {
        actionInFlight.current = false
        if (mounted.current) setActionBusy(false)
      }
    },
    []
  )

  const retry = useCallback(() => {
    setActionError(null)
    if (enabledRef.current) setRevision((value) => value + 1)
    else void loadSettings()
  }, [loadSettings])

  return {
    enabled,
    loading,
    saving,
    paused,
    snapshot,
    history,
    error: actionError ?? error,
    actionBusy,
    changeEnabled,
    executeAction,
    retry,
  }
}
