import { mermaidDiagramConfig, readMermaidThemeTokens } from "./mermaid-theme"

const light = {
  primary: "#0071e3",
  primaryText: "#005fbf",
  card: "#ffffff",
  muted: "#f5f5f7",
  border: "#e4e4e7",
  foreground: "#1d1d1f",
  mutedForeground: "#68686d",
}
const dark = {
  ...light,
  primary: "#0871db",
  primaryText: "#96c4ff",
  card: "#202023",
  muted: "#2c2c2e",
  border: "",
  foreground: "#f5f5f7",
  mutedForeground: "#a5a5aa",
}

describe("Mermaid 跟随有效主题变量", () => {
  it("浅色输出使用当前前景、卡片、分组与主色派生填充", () => {
    const config = mermaidDiagramConfig({ isDarkMode: false, tokens: light })
    expect(config.themeVariables).toMatchObject({
      primaryColor: "#e6f1fc",
      primaryTextColor: light.foreground,
      textColor: light.foreground,
      edgeLabelBackground: light.card,
      clusterBkg: light.muted,
      clusterBorder: light.border,
    })
    expect(config.themeCSS).toContain("rx: 10")
  })

  it("深色边框使用可读主色，透明分隔线转换为实色", () => {
    const config = mermaidDiagramConfig({ isDarkMode: true, tokens: dark })
    expect(config.themeVariables).toMatchObject({
      primaryBorderColor: dark.primaryText,
      primaryTextColor: dark.foreground,
      edgeLabelBackground: dark.card,
      lineColor: dark.mutedForeground,
    })
    expect(config.themeVariables?.clusterBorder).toMatch(/^#[0-9a-f]{6}$/)
  })

  it("无法解析必要变量时回落旧调色板，不抛异常", () => {
    expect(
      mermaidDiagramConfig({
        isDarkMode: true,
        tokens: { ...dark, primary: "" },
      })
    ).toEqual(mermaidDiagramConfig({ isDarkMode: true }))
  })

  it("读取已生效的自定义变量，不将不支持的值伪装成答案", () => {
    const root = document.documentElement
    root.style.setProperty("--primary", "#0071e3")
    root.style.setProperty("--card", "#ffffff")
    expect(readMermaidThemeTokens()).toMatchObject({
      primary: "#0071e3",
      card: "#ffffff",
    })
    root.style.removeProperty("--primary")
    root.style.removeProperty("--card")
    expect(readMermaidThemeTokens()).toBeUndefined()
  })
})
