import { cn } from "./utils"

describe("主题字号工具类合并", () => {
  it.each([
    "text-2xs",
    "text-3xs",
    "text-ui",
    "text-heading-sm",
    "text-heading",
    "text-page-title",
    "text-display",
  ])("%s 与语义文字颜色共存", (fontSize) => {
    expect(cn(fontSize, "text-primary-foreground")).toBe(
      `${fontSize} text-primary-foreground`
    )
    expect(cn("text-muted-foreground", fontSize)).toBe(
      `text-muted-foreground ${fontSize}`
    )
  })

  it("调用者仍可覆盖默认字号、颜色与状态字号", () => {
    expect(cn("text-ui text-primary-text", "text-sm text-foreground")).toBe(
      "text-sm text-foreground"
    )
    expect(cn("text-sm", "text-heading-sm")).toBe("text-heading-sm")
    expect(cn("hover:text-ui", "hover:text-xs")).toBe("hover:text-xs")
    expect(cn("text-ui", "text-[1.5rem]")).toBe("text-[1.5rem]")
  })

  it("不改变行为类或条件类的合并", () => {
    expect(cn("hidden sr-only pointer-events-none", { inert: true })).toBe(
      "hidden sr-only pointer-events-none inert"
    )
    expect(cn("h-9 rounded-lg", "h-7 rounded-md")).toBe("h-7 rounded-md")
  })
})
