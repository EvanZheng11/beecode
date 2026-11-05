import { readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * 设置页/会话侧栏的 UI 规范守卫（docs/design/ui-style-guide.md §8.5、§9、§14）。
 * 只做源码级断言：页面级组件走 80rem 内容容器，范围内不再出现像素字号、
 * 调色板色阶类和 rounded-4xl。
 */
const root = process.cwd()
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8")

// 设置子页入口组件（app/settings/*/page.tsx 渲染的页面级布局）
const PAGE_FILES = [
  "acp-agent-settings",
  "appearance-settings",
  "browser-settings",
  "chat-channel-settings",
  "collaboration-settings",
  "computer-use-settings",
  "general-settings",
  "logs-settings",
  "mcp-settings",
  "model-provider-settings",
  "quick-messages-settings",
  "resource-monitor-view",
  "shortcut-settings",
  "skill-packs-settings",
  "skills-settings",
  "system-network-settings",
  "version-control-settings",
  "web-service-settings",
]

function sources(dir: string): Array<[string, string]> {
  return readdirSync(resolve(root, dir))
    .filter((f) => f.endsWith(".tsx") && !f.includes(".test."))
    .map((f) => [`${dir}/${f}`, read(`${dir}/${f}`)])
}

describe("设置页布局规范", () => {
  it.each(PAGE_FILES)("%s 使用 max-w-[80rem] 内容容器", (name) => {
    expect(read(`src/components/settings/${name}.tsx`)).toContain(
      "max-w-[80rem]"
    )
  })

  it("设置壳导航：apple 实心主色激活项、逻辑属性边框", () => {
    const shell = read("src/components/settings/settings-shell.tsx")
    expect(shell).toContain("in-data-[theme=apple]:bg-primary")
    expect(shell).toContain("in-data-[theme=apple]:text-primary-foreground")
    expect(shell).toContain("border-e")
    expect(shell).not.toMatch(/\bborder-r\b/)
  })

  it("分组卡使用 surface-glass rounded-2xl", () => {
    const section = read("src/components/shared/settings-section.tsx")
    expect(section).toContain("surface-glass rounded-2xl")
  })
})

describe("范围内无硬编码样式", () => {
  const files = [
    ...sources("src/components/settings"),
    ...sources("src/components/conversations"),
  ]
  const PALETTE =
    /\b(bg|text|border|ring)-(amber|red|green|blue|yellow|orange|emerald|sky|rose)-\d{2,3}\b/

  it.each(files)("%s 不含像素字号 / 调色板色阶 / rounded-4xl", (_f, src) => {
    expect(src).not.toMatch(/text-\[\d+(\.\d+)?px\]/)
    expect(src).not.toMatch(PALETTE)
    expect(src).not.toContain("rounded-4xl")
  })
})
