import { act, fireEvent, render, screen } from "@testing-library/react"
import { useRef } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer"
import { SidePanelResizeHandle } from "./side-panel-resize"

const WINDOW_WIDTH = 1024
const MAX_WIDTH = WINDOW_WIDTH * 0.9

/** jsdom 没有布局：让面板的 rect 宽度跟内联 `width` 走（真实浏览器里就是这样）。 */
function box(width: number): DOMRect {
  return {
    left: WINDOW_WIDTH - width,
    width,
    right: WINDOW_WIDTH,
    top: 0,
    bottom: 600,
    height: 600,
    x: WINDOW_WIDTH - width,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect
}

interface HarnessProps {
  open?: boolean
  resetKey?: string | number
  defaultWidth?: number
  onParentPointerDown?: () => void
}

function Harness({
  open = true,
  resetKey = 1,
  defaultWidth = 576,
  onParentPointerDown,
}: HarnessProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  return (
    <div onPointerDown={onParentPointerDown}>
      <div
        data-testid="panel"
        ref={(node) => {
          panelRef.current = node
          if (!node) return
          node.getBoundingClientRect = () =>
            box(
              node.style.width
                ? Number.parseFloat(node.style.width)
                : defaultWidth
            )
        }}
      >
        <SidePanelResizeHandle
          panelRef={panelRef}
          open={open}
          resetKey={resetKey}
        />
      </div>
    </div>
  )
}

const panel = () => screen.getByTestId("panel")
const handle = () => screen.getByRole("separator")

/** jsdom 没有 ResizeObserver：拽住组件的回调，模拟浏览器通知一次尺寸变化。 */
let resizeCallbacks: ResizeObserverCallback[] = []
class FakeResizeObserver {
  private callback: ResizeObserverCallback
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    resizeCallbacks.push(callback)
  }
  observe() {}
  unobserve() {}
  disconnect() {
    resizeCallbacks = resizeCallbacks.filter((cb) => cb !== this.callback)
  }
}

function notifyResize() {
  act(() => {
    for (const callback of [...resizeCallbacks]) {
      callback([], {} as ResizeObserver)
    }
  })
}

/** 真实的 `Drawer`，用来验证 Base UI 自己的触摸右滑关闭链路。 */
function DrawerHarness() {
  const panelRef = useRef<HTMLDivElement>(null)
  return (
    <Drawer open swipeDirection="right">
      <DrawerContent ref={panelRef}>
        <DrawerTitle>子会话</DrawerTitle>
        <SidePanelResizeHandle panelRef={panelRef} open />
        <div data-testid="drawer-body">正文</div>
      </DrawerContent>
    </Drawer>
  )
}

/** jsdom 没有 `TouchEvent`；补上 Base UI 读取的 `touches`。 */
function touch(target: EventTarget, type: string, clientX: number) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, "touches", {
    value: type === "touchend" ? [] : [{ clientX, clientY: 10 }],
  })
  target.dispatchEvent(event)
  return event
}

/**
 * jsdom 没有 `PointerEvent`；鼠标事件挂上 pointer 事件名，再补上组件读取的
 * `pointerId` / `isPrimary`（同样的做法见 chat-width-handles.test.tsx）。
 */
function firePointer(
  target: Element,
  type: string,
  {
    clientX = 0,
    button = 0,
    pointerId = 1,
    isPrimary = true,
  }: {
    clientX?: number
    button?: number
    pointerId?: number
    isPrimary?: boolean
  } = {}
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    button,
  })
  Object.defineProperty(event, "pointerId", { value: pointerId })
  Object.defineProperty(event, "isPrimary", { value: isPrimary })
  return fireEvent(target, event)
}

/** 一次完整手势：按下 → 移到 `toX` → 松开。返回按下时是否被 preventDefault。 */
function drag(fromX: number, toX: number) {
  const started = firePointer(handle(), "pointerdown", { clientX: fromX })
  firePointer(handle(), "pointermove", { clientX: toX })
  firePointer(handle(), "pointerup", { clientX: toX })
  return started
}

const width = () => panel().style.width

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: WINDOW_WIDTH,
  })
  resizeCallbacks = []
  vi.stubGlobal("ResizeObserver", FakeResizeObserver)
})

afterEach(() => {
  document.documentElement.style.fontSize = ""
  vi.unstubAllGlobals()
})

describe("SidePanelResizeHandle", () => {
  it("默认不写内联宽度，首次拖动从默认宽度放大", () => {
    render(<Harness defaultWidth={576} />)
    expect(width()).toBe("")

    const started = drag(1000, 900)

    // 按下必须被拦下，否则 Drawer 会把它当成右滑关闭手势。
    expect(started).toBe(false)
    expect(width()).toBe("676px")
    expect(panel().style.maxWidth).toBe("90vw")
  })

  it("第一次手势之后，第二次手势仍以默认宽度为下限", () => {
    render(<Harness defaultWidth={576} />)

    drag(1000, 900)
    expect(width()).toBe("676px")

    // 第二次从当前 676px 起拖，向右拖回时不能停在 676px。
    drag(1000, 1400)
    expect(width()).toBe("576px")
  })

  it("宽度上限是窗口的 90%", () => {
    render(<Harness defaultWidth={576} />)

    drag(1000, -10000)
    expect(Number.parseFloat(width())).toBe(MAX_WIDTH)
    expect(panel().style.maxWidth).toBe("90vw")
  })

  it("拖到 90% 上限后仍能拖回来，且不会窄于默认宽度", () => {
    render(<Harness defaultWidth={576} />)

    drag(1000, -10000)
    expect(Number.parseFloat(width())).toBe(MAX_WIDTH)

    // 上限不是新的下限：第二次手势从最大值起也能缩回默认宽度。
    drag(1000, 9999)
    expect(width()).toBe("576px")

    // 默认宽度仍是下限，再往右也压不下去。
    drag(1000, 9999)
    expect(width()).toBe("576px")
  })

  it("默认宽度已经超过窗口 90% 时维持默认宽度", () => {
    render(<Harness defaultWidth={950} />)

    drag(1000, 300)
    expect(width()).toBe("")
  })

  it("关闭后再打开恢复默认宽度", () => {
    const view = render(<Harness open defaultWidth={576} />)
    drag(1000, 900)
    expect(width()).toBe("676px")

    view.rerender(<Harness open={false} defaultWidth={576} />)
    view.rerender(<Harness open defaultWidth={576} />)
    expect(width()).toBe("")
    expect(panel().style.maxWidth).toBe("")

    // 重新打开后的第一次拖动又按默认宽度计算。
    drag(1000, 950)
    expect(width()).toBe("626px")
  })

  it("切换到另一个子会话也恢复默认宽度", () => {
    const view = render(<Harness open resetKey={1} defaultWidth={576} />)
    drag(1000, 900)
    expect(width()).toBe("676px")

    view.rerender(<Harness open resetKey={2} defaultWidth={576} />)
    expect(width()).toBe("")
  })

  it("窗口变窄时恢复默认宽度，不被 90vw 压到默认以下", () => {
    render(<Harness defaultWidth={584} />)
    drag(1000, 900)
    expect(width()).toBe("684px")

    // 600px 宽的窗口：90vw = 540px 已小于默认宽度 584px。
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 600,
    })
    fireEvent(window, new Event("resize"))

    expect(width()).toBe("")
    expect(panel().style.maxWidth).toBe("")

    // 窗口恢复后仍可正常拖动，最小宽度重新量一遍。
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: WINDOW_WIDTH,
    })
    fireEvent(window, new Event("resize"))
    drag(1000, 900)
    expect(width()).toBe("684px")
  })

  it("窗口变化打断进行中的手势时释放指针捕获", () => {
    render(<Harness defaultWidth={576} />)
    const el = handle() as HTMLDivElement
    const captured = new Set<number>()
    el.setPointerCapture = (id) => captured.add(id)
    el.hasPointerCapture = (id) => captured.has(id)
    const release = vi.fn((id: number) => captured.delete(id))
    el.releasePointerCapture = release

    firePointer(el, "pointerdown", { clientX: 1000 })
    firePointer(el, "pointermove", { clientX: 900 })
    expect(width()).toBe("676px")

    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 600,
    })
    fireEvent(window, new Event("resize"))

    expect(release).toHaveBeenCalledWith(1)
    expect(width()).toBe("")

    // 手势已经结束：后续 move 不再改宽度。
    firePointer(el, "pointermove", { clientX: 700 })
    expect(width()).toBe("")
  })

  it("应用缩放（根字号）变化时恢复默认宽度", () => {
    render(<Harness defaultWidth={576} />)
    drag(1000, 900)
    expect(width()).toBe("676px")

    // 观察器触发但字号没变：不该动已拖出的宽度。
    notifyResize()
    expect(width()).toBe("676px")

    document.documentElement.style.fontSize = "32px" // 应用缩放 200%
    notifyResize()
    expect(width()).toBe("")
    expect(panel().style.maxWidth).toBe("")
  })

  it("真实 Drawer：从正文开始的触摸会被右滑关闭链路接管（对照）", () => {
    render(<DrawerHarness />)

    touch(screen.getByTestId("drawer-body"), "touchstart", 500)
    const move = touch(document, "touchmove", 600)

    expect(move.defaultPrevented).toBe(true)
  })

  it("真实 Drawer：把手上开始的触摸不会进入右滑关闭链路", () => {
    render(<DrawerHarness />)

    touch(handle(), "touchstart", 500)
    const move = touch(document, "touchmove", 600)

    expect(move.defaultPrevented).toBe(false)
  })

  it("pointercancel 结束拖动，之后的移动不再改宽度", () => {
    render(<Harness defaultWidth={576} />)

    firePointer(handle(), "pointerdown", { clientX: 1000 })
    firePointer(handle(), "pointermove", { clientX: 900 })
    expect(width()).toBe("676px")
    firePointer(handle(), "pointercancel", { clientX: 900 })

    firePointer(handle(), "pointermove", { clientX: 700 })
    expect(width()).toBe("676px")

    // 下一次按下重新开始一次手势：从当前 676px 再向右 50px。
    drag(1000, 950)
    expect(width()).toBe("726px")
  })

  it("非主指针或右键不会开始拖动", () => {
    render(<Harness defaultWidth={576} />)

    firePointer(handle(), "pointerdown", { clientX: 1000, isPrimary: false })
    firePointer(handle(), "pointermove", { clientX: 900 })
    expect(width()).toBe("")

    firePointer(handle(), "pointerdown", { clientX: 1000, button: 2 })
    firePointer(handle(), "pointermove", { clientX: 900 })
    expect(width()).toBe("")
  })

  it("拖动不会把按下事件冒泡给 Drawer", () => {
    const onParentPointerDown = vi.fn()
    render(<Harness onParentPointerDown={onParentPointerDown} />)

    firePointer(handle(), "pointerdown", { clientX: 1000 })
    expect(onParentPointerDown).not.toHaveBeenCalled()
  })
})
