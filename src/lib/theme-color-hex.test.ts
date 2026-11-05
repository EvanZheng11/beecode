import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { THEME_COLORS } from "./theme-presets"
import { themeColorHex } from "./theme-color-hex"
import { editorAccent } from "./monaco-themes"

const css = readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8")

describe("第三方主题色转换", () => {
  it("无 Canvas 时准确转换预设 OKLCH 与十六进制", () => {
    expect(themeColorHex("oklch(1 0 0)")).toBe("#ffffff")
    expect(themeColorHex("oklch(0 0 0)")).toBe("#000000")
    // 规范 OKLCH 保留三位小数，回转时红通道有 1/255 的舍入差。
    expect(themeColorHex("oklch(0.563 0.193 256.2)")).toBe("#0171e3")
    expect(themeColorHex("#abc")).toBe("#aabbcc")
    expect(themeColorHex("")).toBeNull()
  })

  it.each(THEME_COLORS)("%s 光标主色与 CSS 明暗预设对账", (color) => {
    for (const dark of [false, true]) {
      const selector = `[data-theme="${color}"]${dark ? ".dark" : ""}`
      const start = css.indexOf(`\n${selector} {`)
      expect(start).toBeGreaterThan(-1)
      const body = css.slice(start, css.indexOf("\n}", start))
      const primary = body.match(/--primary:\s*([^;]+);/)?.[1]
      expect(primary).toBeTruthy()
      expect(editorAccent(color, dark)).toBe(themeColorHex(primary!))
    }
  })
})
