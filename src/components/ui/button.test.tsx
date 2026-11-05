import { fireEvent, render, screen } from "@testing-library/react"
import { Button, buttonVariants } from "./button"
import {
  ButtonGroup,
  ButtonGroupSeparator,
  ButtonGroupText,
} from "./button-group"

describe("Apple 按钮族", () => {
  it("保持事件与测试锚点，并应用舒适密度", () => {
    const onClick = vi.fn()
    render(<Button onClick={onClick}>保存</Button>)
    const button = screen.getByRole("button", { name: "保存" })
    expect(button).toHaveAttribute("data-slot", "button")
    expect(button).toHaveAttribute("data-variant", "default")
    expect(button).toHaveAttribute("data-size", "default")
    expect(button).toHaveClass("rounded-full", "text-ui", "h-[2.125rem]")
    expect(button).toHaveClass("active:not-aria-[haspopup]:scale-[0.97]")
    expect(button).not.toHaveClass("active:not-aria-[haspopup]:translate-y-px")
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["xs", "h-6"],
    ["sm", "h-7"],
    ["lg", "h-11"],
    ["icon", "size-8"],
    ["icon-xs", "size-6"],
    ["icon-sm", "size-7"],
    ["icon-lg", "size-10"],
  ] as const)("保留 %s 尺寸入口", (size, expectedClass) => {
    render(
      <Button size={size} aria-label="操作">
        <svg aria-hidden="true" />
      </Button>
    )
    expect(screen.getByRole("button", { name: "操作" })).toHaveClass(
      expectedClass
    )
  })

  it("保留所有旧变体并允许调用者覆盖紧凑尺寸", () => {
    for (const variant of [
      "default",
      "outline",
      "secondary",
      "ghost",
      "destructive",
      "link",
    ] as const) {
      expect(buttonVariants({ variant })).toContain("group/button")
    }
    render(
      <Button className="h-8 rounded-md" aria-haspopup="menu">
        菜单
      </Button>
    )
    const button = screen.getByRole("button", { name: "菜单" })
    expect(button).toHaveAttribute("aria-haspopup", "menu")
    expect(button).toHaveClass("h-8", "rounded-md")
    expect(button).not.toHaveClass("h-[2.125rem]", "rounded-full")
  })

  it("禁用按钮不响应点击，asChild 保留子元素语义", () => {
    const onClick = vi.fn()
    const { rerender } = render(
      <Button disabled onClick={onClick}>
        保存
      </Button>
    )
    fireEvent.click(screen.getByRole("button", { name: "保存" }))
    expect(onClick).not.toHaveBeenCalled()
    rerender(
      <Button asChild variant="link">
        <a href="#section">查看</a>
      </Button>
    )
    const link = screen.getByRole("link", { name: "查看" })
    expect(link).toHaveAttribute("href", "#section")
    expect(link).toHaveAttribute("data-slot", "button")
    expect(link).toHaveClass("text-primary-text")
  })

  it("按钮组保持方向、分隔线与子元素语义，水平边使用逻辑属性", () => {
    const { rerender } = render(
      <ButtonGroup aria-label="编辑操作" orientation="horizontal">
        <ButtonGroupText>编辑</ButtonGroupText>
        <Button variant="outline">撤销</Button>
        <ButtonGroupSeparator />
        <Button variant="outline">重做</Button>
      </ButtonGroup>
    )
    const group = screen.getByRole("group", { name: "编辑操作" })
    expect(group).toHaveAttribute("data-orientation", "horizontal")
    expect(group).toHaveClass("[&>*:not(:first-child)]:border-s-0")
    expect(group).not.toHaveClass("[&>*:not(:first-child)]:border-l-0")
    expect(screen.getByText("编辑")).toHaveClass("rounded-lg", "text-ui")
    expect(
      group.querySelector('[data-slot="button-group-separator"]')
    ).toBeTruthy()
    rerender(
      <ButtonGroup aria-label="编辑操作" orientation="vertical">
        <Button>撤销</Button>
        <Button>重做</Button>
      </ButtonGroup>
    )
    expect(screen.getByRole("group")).toHaveClass("flex-col")
  })
})
