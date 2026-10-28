"use client"

import { useCallback, useEffect, useRef } from "react"
import type {
  PointerEvent as ReactPointerEvent,
  RefObject,
  TouchEvent as ReactTouchEvent,
} from "react"

/** 面板最宽占窗口的 90%，其余留作边距（与默认宽度自带的那条边距同一思路）。 */
const MAX_WIDTH_RATIO = 0.9
const HANDLE_LABEL = "拖动调整会话记录宽度"

interface Props {
  /** 侧栏面板（`DrawerContent`）的容器，宽度写在它的内联样式上。 */
  panelRef: RefObject<HTMLElement | null>
  /** 面板是否打开；关闭后拖动不再生效。 */
  open: boolean
  /** 面板内容切换（换一个子会话）时也视作一次新的打开，重置宽度。 */
  resetKey?: string | number | null
}

/** rem 的基准。应用缩放改的就是它（见 `appearance-script`），不在别处。 */
function rootFontSize(): number {
  const size = Number.parseFloat(
    getComputedStyle(document.documentElement).fontSize
  )
  // 读不到时按浏览器默认 16px：NaN 与自身永不相等，会让每次触发都当成变化。
  return Number.isFinite(size) && size > 0 ? size : 16
}

/**
 * 侧栏面板左边缘的拖动把手：拖动改变面板宽度，不落任何存储。
 *
 * 最小宽度是「本次打开后首次拖动前」量到的默认宽度——默认宽度由
 * `SIDE_PANEL_CONTENT_CLASS` 的响应式 CSS 决定，同一会话里再拖也不会把已经
 * 放大的宽度当成新的最小值。最大宽度是窗口的 90%，同时用 `max-width: 90vw`
 * 兜底，窗口变窄时面板不会停在旧的像素宽度上撑满屏幕。
 */
export function SidePanelResizeHandle({ panelRef, open, resetKey }: Props) {
  // 本次打开后的默认宽度；null 表示还没量过。
  const minWidthRef = useRef<number | null>(null)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startWidth: number
  } | null>(null)
  const handleRef = useRef<HTMLDivElement>(null)

  /** 丢掉拖出的像素宽度和量到的最小宽度，回到 CSS 默认宽度。 */
  const resetWidth = useCallback(() => {
    minWidthRef.current = null
    const drag = dragRef.current
    dragRef.current = null
    const handle = handleRef.current
    // 窗口/缩放变化可能正好落在一次手势中间：收尾时放掉指针捕获，否则后续
    // pointermove 还会被送到这根把手上。
    if (drag && handle?.hasPointerCapture(drag.pointerId)) {
      handle.releasePointerCapture(drag.pointerId)
    }
    const panel = panelRef.current
    if (!panel) return
    panel.style.width = ""
    panel.style.maxWidth = ""
  }, [panelRef])

  // 每次打开或切换子会话：丢掉上一次拖出的像素宽度，回到 CSS 默认宽度。
  useEffect(() => {
    resetWidth()
  }, [open, resetKey, resetWidth])

  // 窗口尺寸变化：默认宽度是 `100%-1rem` 与 `36rem`，像素值会变；之前拖出的
  // 像素宽度和量到的最小宽度都过期了，直接恢复默认（max 一并清掉，免得
  // 变窄后的 90vw 把默认宽度压到它下面）。
  useEffect(() => {
    if (!open) return
    window.addEventListener("resize", resetWidth)
    const visual = window.visualViewport ?? null
    visual?.addEventListener("resize", resetWidth)
    return () => {
      window.removeEventListener("resize", resetWidth)
      visual?.removeEventListener("resize", resetWidth)
    }
  }, [open, resetWidth])

  // 应用缩放只改 `:root` 的 font-size，`<html>` 自身的盒子不变，所以在它身上
  // 观察不到字号变化；用一根 1rem 宽的探针让 ResizeObserver 看到 rem 变了。
  // 回调里再读一次根字号，只认字号真的变了的触发。
  useEffect(() => {
    if (!open || typeof ResizeObserver === "undefined") return
    let fontSize = rootFontSize()
    const probe = document.createElement("div")
    probe.setAttribute("aria-hidden", "true")
    probe.style.cssText =
      "position:fixed;top:0;left:0;width:1rem;height:1px;visibility:hidden;pointer-events:none"
    document.body.appendChild(probe)
    const observer = new ResizeObserver(() => {
      const next = rootFontSize()
      if (next === fontSize) return
      fontSize = next
      resetWidth()
    })
    observer.observe(probe)
    return () => {
      observer.disconnect()
      probe.remove()
    }
  }, [open, resetWidth])

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      // 只接管主指针的左键：多指或右键都不该开始拖动。
      if (!open || !event.isPrimary || event.button !== 0) return
      const panel = panelRef.current
      if (!panel) return
      // Drawer 的右滑关闭也从这块面板开始，先把它挡掉，否则一拖就关。
      event.preventDefault()
      event.stopPropagation()
      const startWidth = panel.getBoundingClientRect().width
      const maxWidth = window.innerWidth * MAX_WIDTH_RATIO
      if (!(startWidth > 0)) return
      if (minWidthRef.current === null) {
        // 窄屏上默认宽度已经超过窗口的 90%：保持 CSS 默认宽度，不接管拖动。
        // 已经有最小宽度（本次打开拖过）时，哪怕此刻正停在最大值也要允许往回拖。
        if (startWidth >= maxWidth) return
        minWidthRef.current = startWidth
      }
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth,
      }
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [open, panelRef]
  )

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      const panel = panelRef.current
      if (!drag || !panel || event.pointerId !== drag.pointerId) return
      const minWidth = minWidthRef.current ?? drag.startWidth
      const maxWidth = window.innerWidth * MAX_WIDTH_RATIO
      // 左边缘拖得越靠左，面板越宽；夹在默认宽度与窗口 90% 之间。外层再兜一次
      // 下限：窗口刚变窄、resize 复位还没落地的那一帧里 max 可能小于默认宽度。
      const width = Math.max(
        minWidth,
        Math.min(drag.startWidth + (drag.startX - event.clientX), maxWidth)
      )
      panel.style.width = `${width}px`
      panel.style.maxWidth = `${MAX_WIDTH_RATIO * 100}vw`
    },
    [panelRef]
  )

  const endDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || event.pointerId !== drag.pointerId) return
    dragRef.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
  }, [])

  // Drawer 的手机端右滑关闭在 viewport 的 touchstart 上初始化，随后由 document
  // 上的 touchmove 接管。把手上开始的触摸在这里截断冒泡，本次调宽就不会被当成
  // 关闭手势；不 preventDefault，pointer 事件和桌面拖动都不受影响。
  const handleTouchStart = useCallback(
    (event: ReactTouchEvent<HTMLDivElement>) => {
      if (!open) return
      event.stopPropagation()
    },
    [open]
  )

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={HANDLE_LABEL}
      title={HANDLE_LABEL}
      data-slot="side-panel-resize-handle"
      ref={handleRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onTouchStart={handleTouchStart}
      // 窄屏（<640px）隐藏：默认宽度已接近满屏，没有可拖的余量。
      className="absolute inset-y-0 left-0 z-20 hidden w-3 cursor-col-resize touch-none select-none sm:block"
    />
  )
}
