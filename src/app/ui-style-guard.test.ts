import { readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import ts from "typescript"

const root = resolve(process.cwd(), "src")

// 这些颜色不是界面主题：保留外部品牌、任意拾色器和 Git 图的多分支身份色。
// 白名单按“路径+准确颜色”登记；新增颜色不能靠扩大整文件豁免绕过守卫。
const exceptions: Record<string, Set<string>> = {
  "components/vscode-icon.tsx": new Set(["#2196f3"]),
  // 预水合前的深色兜底必须独立于尚未应用的主题属性；保留历史防闪色值。
  "app/layout.tsx": new Set(["#09090b"]),
  // Windows 原生关闭按钮的系统交互色，不是应用主题装饰色。
  "components/layout/window-controls.tsx": new Set(["#e81123", "#c50f1f"]),
  // 第三方 Mermaid 在变量解析失败时必须保留已验证的固定调色板。
  "components/ai-elements/mermaid-theme.ts": new Set([
    "#dbeafe",
    "#60a5fa",
    "#1e293b",
    "#94a3b8",
    "#334155",
    "#eef2f7",
    "#f8fafc",
    "#cbd5e1",
    "#475569",
    "#e2e8f0",
    "#1e3a5f",
    "#e2e8f0",
    "#64748b",
  ]),
  "components/agent-icon.tsx": new Set([
    "#1e1e2e",
    "#ee4d5d",
    "#b381dd",
    "#207cfe",
    "#ff4d4d",
    "#050810",
    "#00e5cc",
    "#991b1b",
    "#b1a7ff",
    "#7a9dff",
    "#3941ff",
    "#d97757",
    "#000000",
    "#ffffff",
    "#1783ff",
    "#4d6bfe",
    "#151718",
    "#9046ff",
    "#32f08c",
    "#f23f5d",
  ]),
  "components/conversations/conversation-tag-form-dialog.tsx": new Set([
    "#000000",
    "#cf222e",
    "#9a6700",
    "#1a7f37",
    "#0f766e",
    "#0969da",
    "#8250df",
    "#bf3989",
  ]),
  "components/settings/custom-style-section.tsx": new Set(["#000000"]),
  "components/layout/git-log-graph-cell.tsx": new Set([
    "#3b82f6",
    "#ef4444",
    "#10b981",
    "#f59e0b",
    "#8b5cf6",
    "#ec4899",
    "#14b8a6",
    "#f97316",
  ]),
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name)
    if (entry.name === "node_modules" || entry.name === ".DS_Store") return []
    if (entry.isDirectory()) return sourceFiles(file)
    return /\.tsx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)
      ? [file]
      : []
  })
}

it("界面源码禁止新增硬编码颜色和固定像素字号", () => {
  const failures: string[] = []
  const files = [
    ...sourceFiles(join(root, "components")),
    ...sourceFiles(join(root, "app")),
  ]
  for (const file of files) {
    const name = relative(root, file).split("\\").join("/")
    const text = readFileSync(file, "utf8")
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const check = (node: ts.Node) => {
      // AST 字符串避免把任务 ID（#abcdef12）、注释与模板文档误认成颜色。
      if (
        ts.isStringLiteralLike(node) ||
        (ts.isJsxAttribute(node) &&
          node.initializer &&
          ts.isStringLiteral(node.initializer))
      ) {
        const value = ts.isStringLiteralLike(node)
          ? node.text
          : (node as ts.JsxAttribute).initializer!.getText(source)
        const line =
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
        if (/text-\[\d+(?:\.\d+)?px\]/.test(value)) {
          failures.push(`${name}:${line} 固定像素字号`)
        }
        for (const match of value.matchAll(
          /#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})(?![\da-f])/gi
        )) {
          const color = match[0].toLowerCase()
          // 只检查颜色语法位置；字符串里的提交哈希/片段标识不是 CSS 颜色。
          const before = value.slice(0, match.index)
          const after = value.slice(match.index! + color.length)
          const looksLikeColor =
            /^#[\da-f]+$/i.test(value) ||
            /(?:\[|\(|,|:|\s)$/.test(before) ||
            /^[\])\s,;]/.test(after)
          if (looksLikeColor && !exceptions[name]?.has(color)) {
            failures.push(`${name}:${line} 未登记颜色 ${color}`)
          }
        }
      }
      ts.forEachChild(node, check)
    }
    check(source)
  }
  expect([...new Set(failures)]).toEqual([])
})
