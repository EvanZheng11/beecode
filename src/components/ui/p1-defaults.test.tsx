import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { toast } from "sonner"

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}))

import { AppToaster } from "./app-toaster"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogTitle,
} from "./alert-dialog"
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "./dialog"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip"

// 视觉默认值（规范 §8.2/§8.8/§8.13）：只断言类名与令牌，不碰行为
describe("P1 视觉默认值", () => {
  it("Dialog 默认 35rem 宽、86dvh 高，默认内边距时底栏通栏", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>t</DialogTitle>
          <DialogFooter>f</DialogFooter>
        </DialogContent>
      </Dialog>
    )
    const content = screen.getByRole("dialog")
    expect(content).toHaveClass("max-w-[35rem]")
    expect(content.className).toContain("86dvh")
    expect(content).toHaveClass("dialog-default-padding")
    const footer = content.querySelector("[data-slot=dialog-footer]")!
    expect(footer.nextElementSibling).toHaveAttribute(
      "data-slot",
      "dialog-close"
    )
    expect(content.className).toContain(
      "[data-slot=dialog-footer]+[data-slot=dialog-close]:last-child"
    )
    expect(
      content.querySelector("[data-slot=dialog-footer]")?.className
    ).toContain("group-[.dialog-default-padding]/dialog-content:border-t")
  })

  it("调用方自带内边距或宽度时保留旧布局并覆盖默认宽度", () => {
    render(
      <Dialog open>
        <DialogContent className="p-0 sm:max-w-md">
          <DialogTitle>t</DialogTitle>
        </DialogContent>
      </Dialog>
    )
    const content = screen.getByRole("dialog")
    expect(content).not.toHaveClass("dialog-default-padding")
    expect(content).toHaveClass("p-0", "sm:max-w-md")
  })

  it("AlertDialog 默认 26.25rem，sm 尺寸保持 20rem", () => {
    const { rerender } = render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogTitle>t</AlertDialogTitle>
          <AlertDialogFooter>f</AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    )
    expect(screen.getByRole("alertdialog")).toHaveClass(
      "data-[size=default]:max-w-[26.25rem]"
    )
    rerender(
      <AlertDialog open>
        <AlertDialogContent size="sm">
          <AlertDialogTitle>t</AlertDialogTitle>
        </AlertDialogContent>
      </AlertDialog>
    )
    expect(screen.getByRole("alertdialog")).toHaveClass(
      "data-[size=sm]:max-w-xs"
    )
  })

  it("Tooltip 默认 300ms 后才出现，并带 6px 偏移", async () => {
    render(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>x</TooltipTrigger>
          <TooltipContent>hint</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
    fireEvent.pointerMove(screen.getByText("x"), { pointerType: "mouse" })
    await new Promise((r) => setTimeout(r, 100))
    expect(screen.queryByText("hint")).toBeNull()
    const [hint] = await screen.findAllByText("hint", {}, { timeout: 1000 })
    expect(
      hint.closest("[data-slot=tooltip-content]")?.getAttribute("data-side")
    ).toBeTruthy()
  })

  it("Tooltip 键盘聚焦立即出现", async () => {
    const user = userEvent.setup()
    render(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>x</TooltipTrigger>
          <TooltipContent>focus-hint</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
    await user.tab()
    expect((await screen.findAllByText("focus-hint")).length).toBeGreaterThan(0)
  })

  it("Toast：状态圆点、360px 宽、默认时长可被显式值覆盖", async () => {
    render(<AppToaster position="bottom-right" />)
    toast.success("ok")
    await screen.findByText("ok")
    const list = document.querySelector("[data-sonner-toaster]") as HTMLElement
    expect(list.style.getPropertyValue("--width")).toBe("22.5rem")
    await waitFor(() =>
      expect(
        document.querySelector("[data-icon] .bg-tone-success")
      ).not.toBeNull()
    )
    toast.loading("busy")
    await screen.findByText("busy")
    // loading 保留 sonner 自带转圈，不换成状态圆点
    expect(document.querySelector(".sonner-loading-wrapper")).not.toBeNull()
    toast.dismiss()
  })
})
