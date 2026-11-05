import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { THEME_COLORS } from "@/lib/theme-presets"

const globalsCss = readFileSync(
  resolve(process.cwd(), "src/app/globals.css"),
  "utf8"
)

/** 取 `selector {` 起到下一个 `\n}` 的变量表（只取第一次出现的块）。 */
function vars(selector: string): Record<string, string> {
  const start = globalsCss.indexOf(`\n${selector} {`)
  expect(start).toBeGreaterThan(-1)
  const body = globalsCss.slice(start, globalsCss.indexOf("\n}", start))
  const out: Record<string, string> = {}
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    out[m[1]!] = m[2]!.trim()
  }
  return out
}

function oklchToLinear(value: string): [number, number, number] {
  const m = value.match(/^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/)
  expect(m, `不是不透明 oklch：${value}`).not.toBeNull()
  const [L, C, h] = [
    Number(m![1]),
    Number(m![2]),
    (Number(m![3]) * Math.PI) / 180,
  ]
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const clamp = (x: number) => Math.min(1, Math.max(0, x))
  return [
    clamp(4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s),
    clamp(-1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s),
    clamp(-0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s),
  ]
}

function luminance(value: string): number {
  const [r, g, b] = oklchToLinear(value)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(fg: string, bg: string): number {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x)
  return (a! + 0.05) / (b! + 0.05)
}

// 规范 §13：文字对比度 ≥ 4.5:1。前景/背景、次要文字/muted 底、主色按钮、危险色。
const PAIRS: [string, string][] = [
  ["--foreground", "--background"],
  ["--muted-foreground", "--muted"],
  ["--primary-foreground", "--primary"],
  ["--destructive", "--background"],
]

describe.each([
  ["light", `[data-theme="apple"]`],
  ["dark", `[data-theme="apple"].dark`],
])("apple %s 关键文字对比度", (_mode, selector) => {
  const t = vars(selector)
  it.each(PAIRS)("%s on %s ≥ 4.5:1", (fg, bg) => {
    expect(contrast(t[fg]!, t[bg]!)).toBeGreaterThanOrEqual(4.5)
  })
})

describe("危险操作实心态的共享前景", () => {
  it.each(THEME_COLORS)("%s 明暗模式均达到 4.5:1", (preset) => {
    const light = vars(`[data-theme="${preset}"]`)
    const dark = vars(`[data-theme="${preset}"].dark`)
    expect(
      contrast("oklch(1 0 0)", light["--destructive"]!)
    ).toBeGreaterThanOrEqual(4.5)
    expect(
      contrast(dark["--background"]!, dark["--destructive"]!)
    ).toBeGreaterThanOrEqual(4.5)
  })

  it("把专用前景注册为令牌，不依赖各预设的主色前景", () => {
    expect(globalsCss).toContain("--destructive-foreground: oklch(1 0 0)")
    expect(globalsCss).toContain("--destructive-foreground: var(--background)")
    expect(globalsCss).toContain(
      "--color-destructive-foreground: var(--destructive-foreground)"
    )
  })
})
