"use client"

// 静态内容夹具用于验收真实 Markdown / Mermaid 渲染；仅开发构建包含此路由。
import { useTranslations } from "next-intl"
import { MessageResponse } from "@/components/ai-elements/message"
import { PageHeader } from "@/components/ui/page-header"
import {
  StaticWorkspaceActionsProvider,
  type WorkspaceActionsValue,
} from "@/contexts/workspace-context"

const actions = new Proxy({}, { get: () => () => {} }) as WorkspaceActionsValue

const CONTENT = `# Markdown

## BeeCode

### Theme

A paragraph with **bold text**, *emphasis*, a [link](https://example.com) and \`inline code\`.

> Quoted content keeps a logical start border.

1. First item
2. Second item

- [x] Verified
- [ ] Pending

| Name | Status | Notes |
| --- | --- | --- |
| Alpha | Ready | A deliberately long table cell for scrolling and ellipsis checks |
| Beta | Pending | Text |

\`\`\`typescript
const theme = "apple"
const label = "BeeCode"
console.log(theme, label)
\`\`\`

\`\`\`
Unlabelled code block
\`\`\`

\`\`\`mermaid
flowchart LR
  A[Input] -->|Validate| B{Ready?}
  B -->|Yes| C[Result]
  B -->|No| A
  subgraph Workspace
    C --> D[Complete]
  end
\`\`\`

$$E = mc^2$$

---

العربية 中文 Deutsch English
`

export default function ContentGalleryPage() {
  const t = useTranslations("AppearanceSettings")
  return (
    <main className="app-backdrop min-h-screen px-6 py-6 text-foreground">
      <div className="mx-auto max-w-3xl">
        <PageHeader
          title={t("sectionTitle")}
          description={t("sectionDescription")}
        />
        <StaticWorkspaceActionsProvider value={actions}>
          <MessageResponse>{CONTENT}</MessageResponse>
        </StaticWorkspaceActionsProvider>
      </div>
    </main>
  )
}
