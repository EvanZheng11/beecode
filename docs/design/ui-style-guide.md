# BeeCode UI 样式规范（Apple 风格）

> 版本：v1（2026-11-05）
> 来源：`/Users/andyzheng/git/ai-coding-project/platform`（AI Coding 平台前端，React + Radix + Tailwind 4）中的 `src/styles.css`、`src/components/ui.tsx`、`src/layout/Layout.tsx` 及各页面的用法。
> 适用范围：`src/` 下全部前端界面。改造计划见 `docs/superpowers/plans/2026-11-05-apple-ui-refresh.md`。

参考平台的视觉语言可以概括为：白底和浅灰画布，系统蓝作唯一强调色，半透明毛玻璃浮层，胶囊按钮和大圆角卡片，克制的阴影，短促的缓动动画。本规范把它翻译成本项目的令牌体系（shadcn 变量 + Tailwind v4 `@theme inline`），并补上参考平台没有的深色模式、高密度工作区、缩放和多主题预设。

## 1. 总则

1. **令牌优先**。组件里只用语义令牌（`bg-primary`、`text-muted-foreground`、`shadow-glass` 等）。禁止在组件中写十六进制、`rgb()`、`oklch()` 字面量，第三方库要求十六进制时（Monaco、xterm）走现有的转换函数。
2. **所有预设都要好看**。新增的 `apple` 预设是默认主题，但其余 12 套预设（neutral、zinc、slate、stone、gray、red、rose、orange、green、blue、yellow、violet）继续可选。组件改造只能依赖每套预设都会定义的变量，不能假设主色一定是蓝色。
3. **字号用 rem**。缩放档位（80%–300%）改的是 `<html>` 的 `font-size`，`text-[13px]` 这类像素值不会跟着放大。需要非标准字号时用第 4 节的工具类，不要写像素任意值。
4. **方向用逻辑属性**。阿拉伯语是 RTL，间距和定位用 `ms-*`、`me-*`、`ps-*`、`pe-*`、`start-*`、`end-*`、`text-start`。
5. **文案走 next-intl**。参考平台把中文写死在组件里，本项目不照搬；新增文案同时补齐 10 个语言文件。
6. **不改行为**。样式改造不改组件 props、事件、`data-slot`、`data-testid`、`aria-*`、`role`、portal 容器和层级逻辑（`OverlayPortalContainerProvider`、`useNestedLayerDismissGuard`、`acquireNativeSurfaceOcclusion*`）。

## 2. 颜色

### 2.1 Apple 预设变量（`[data-theme="apple"]`）

参考平台的颜色已换算成 OKLCH。对比度按 WCAG 2.1 计算，凡是参考值达不到 AA 的都做了微调，并在“说明”列注明。

| 变量 | 浅色 | 深色 | 说明 |
| --- | --- | --- | --- |
| `--background` | `oklch(0.989 0.003 286.4)` | `oklch(0.201 0.004 286)` | 浅色取参考背景渐变顶端 `#fbfbfd`；深色 `#161618` |
| `--foreground` | `oklch(0.232 0.004 286.1)` | `oklch(0.971 0.003 286.4)` | 参考 `ink #1d1d1f` |
| `--card` / `--popover` | `oklch(1 0 0)` | `oklch(0.241 0.006 286)` | 玻璃层在此基础上取透明度，见 2.3 |
| `--card-foreground` / `--popover-foreground` | 同 `--foreground` | 同 `--foreground` | |
| `--primary` | `oklch(0.563 0.193 256.2)` | `oklch(0.56 0.18 256)` | 系统蓝 `#0071e3`。白字对比 4.7:1；深色白字 4.72:1 |
| `--primary-foreground` | `oklch(1 0 0)` | `oklch(1 0 0)` | |
| `--secondary` / `--muted` | `oklch(0.955 0.003 286.3)` | `oklch(0.294 0.004 286.2)` | 参考 `fill-2`（灰 8%）的实色化 |
| `--secondary-foreground` | 同 `--foreground` | 同 `--foreground` | |
| `--muted-foreground` | `oklch(0.52 0.008 286.1)` | `oklch(0.72 0.007 286.2)` | 参考 `mute #6e6e73`（L=0.54）在 muted 底上只有 4.44:1，压到 0.52 得 4.84:1；深色 5.61:1 |
| `--accent` | `oklch(0.945 0.004 286.3)` | `oklch(0.32 0.005 286.2)` | 中性悬停底，对应参考 `hover:bg-black/[0.04]` |
| `--accent-foreground` | 同 `--foreground` | 同 `--foreground` | |
| `--destructive` | `oklch(0.553 0.225 27.3)` | `oklch(0.707 0.185 25.9)` | 参考 `bad #e5383b` 白底只有 4.23:1，改用 `#d70015`（5.38:1）；深色 `#ff6961` |
| `--border` | `oklch(0.925 0.004 286.3)` | `oklch(1 0 0 / 10%)` | 参考 `line` 为黑 8% |
| `--input` | `oklch(0.905 0.004 286.3)` | `oklch(1 0 0 / 15%)` | 参考输入框边框黑 10% |
| `--ring` | 同 `--primary` | `oklch(0.62 0.2 255.5)` | 聚焦环在组件上再取 15%–20% 透明度 |
| `--chart-1…5` | 蓝 `oklch(0.563 0.193 256.2)`、青 `oklch(0.602 0.101 197.4)`、天蓝 `oklch(0.695 0.125 231.2)`、绿 `oklch(0.640 0.175 146.7)`、亮蓝 `oklch(0.669 0.181 251.8)` | `oklch(0.669 0.181 251.8)`、`oklch(0.771 0.118 212)`、`oklch(0.817 0.119 227.7)`、`oklch(0.756 0.208 147)`、`oklch(0.705 0.159 252.4)` | 参考平台禁用紫、品红、橙 |
| `--sidebar` | `oklch(0.971 0.003 286.4)` | `oklch(0.227 0.004 286.1)` | 参考画布 `#f5f5f7`；深色 `#1c1c1e` |
| `--sidebar-foreground` | 同 `--foreground` | 同 `--foreground` | |
| `--sidebar-primary` / `-foreground` | 同 `--primary` / 白 | 同 `--primary` / 白 | 主导航激活项实心主色 |
| `--sidebar-accent` | `oklch(0.935 0.004 286.3)` | `oklch(0.28 0.004 286.2)` | |
| `--sidebar-accent-foreground` | 同 `--foreground` | 同 `--foreground` | |
| `--sidebar-border` | `oklch(0.92 0.004 286.3)` | `oklch(1 0 0 / 10%)` | |
| `--sidebar-ring` | 同 `--ring` | 同 `--ring` | |
| `--activity-accent` | `oklch(0.5 0.172 256.2)` | `oklch(0.8 0.102 255.5)` | 必须等于 `THEME_COLOR_TITLE.apple`，由 `globals-activity-accent.test.ts` 对账 |

`THEME_COLOR_PREVIEW.apple = "oklch(0.563 0.193 256.2)"`。

### 2.2 新增的全局令牌（所有预设共用）

这些令牌写在 `:root` / `.dark`，靠 `var(--primary)` 等派生，因此在任何预设下都成立。apple 预设只覆盖阴影色调和开关颜色。

| 令牌 | 定义 | 用途 |
| --- | --- | --- |
| `--primary-soft` | 浅色 `color-mix(in oklab, var(--primary) 10%, var(--background))`；深色 18% | 参考 `brand-soft`：选中行、徽标底、强调卡片底 |
| `--primary-text` | `var(--activity-accent)` | 主色文字（链接、编号、Ghost 按钮）。直接用 `text-primary` 时黄、绿、橙预设在白底上达不到 3:1，这个令牌已按预设压到可读明度 |
| `--shadow-tint` | 默认 `0 0 0`；apple 预设 `0 32 96` | 阴影色相，写成 RGB 三元组 |
| `--shadow-glass` | `0 1px 1px rgb(0 0 0 / 0.02), 0 8px 28px rgb(var(--shadow-tint) / 0.06)`；深色把两层透明度提到 0.2 / 0.35 | 卡片、侧栏 |
| `--shadow-pop` | `0 12px 48px rgb(var(--shadow-tint) / 0.16), 0 2px 6px rgb(0 0 0 / 0.05)`；深色 0.5 / 0.3 | 浮层、对话框、可点击卡片悬停 |
| `--switch-on` | 默认 `var(--primary)`；apple 预设 `var(--tone-success)` | 参考平台开关打开是绿色（iOS 习惯），只在 apple 预设生效 |
| `--switch-thumb` | `oklch(1 0 0)`，明暗相同 | 开关滑块，不借用会随明暗变化的背景色 |
| `--destructive-foreground` | 浅色白色，深色 `var(--background)` | 危险操作实心态；避免借用黄、绿预设的主色前景。13 套预设明暗对比度已覆盖测试 |
| `--scrim` / `--drawer-scrim` / `--image-scrim` | 黑色；对话框浅色 20% / 深色 50%，抽屉 10%，图片灯箱 80% | 遮罩使用独立令牌，不用会变成浅色的 `foreground` 代替黑色 |
| `--glass-alpha` / `--glass-strong-alpha` | 浅色 0.72 / 0.95；深色 0.68 / 0.92 | 玻璃层不透明度 |

在 `@theme inline` 里注册为 `--color-primary-soft`、`--color-primary-text`、`--color-switch-on`、`--shadow-glass`、`--shadow-pop`，组件就能写 `bg-primary-soft`、`text-primary-text`、`shadow-glass`。

### 2.3 状态色

现有的 `--tone-success`、`--tone-warning`、`--tone-danger`、`--tone-info` 已经过 12 套预设的对比度校验，继续沿用，不按预设覆盖。参考平台的七种徽标色调映射如下：

| 参考 Tone | 本项目 | 浅底写法 |
| --- | --- | --- |
| gray | `muted` + `muted-foreground` | `bg-muted text-muted-foreground` |
| blue | `primary` | `bg-primary-soft text-primary-text` |
| sky / teal | `tone-info` | `bg-tone-info/12 text-tone-info` |
| green | `tone-success` | `bg-tone-success/12 text-tone-success` |
| yellow | `tone-warning` | `bg-tone-warning/12 text-tone-warning` |
| red | `tone-danger` | `bg-tone-danger/10 text-tone-danger` |

### 2.4 背景与玻璃

- **应用背景**（参考 `.app-backdrop`）：两团柔光加竖向渐变，颜色用 `color-mix` 从 `--primary` 派生，所以其他预设会带各自的色调。只用于全屏页面底层（工作区根、设置页、登录页）。`data-workspace-bg="on"` 时不画，让背景图接管。
- **玻璃层**：提供 `surface-glass`（`--glass-alpha`，`saturate(180%) blur(24px)`，`shadow-glass`）和 `surface-glass-strong`（`--glass-strong-alpha`，`blur(40px)`，`shadow-pop`）两个 `@utility`。浅色描边用白 70%，深色用 `--border`。
- **玻璃的使用范围**：只给浮层（菜单、下拉、弹出框、对话框、抽屉、提示、Toast、全局搜索）、侧栏、标题栏和页面卡片。会话消息列表、虚拟滚动列表、编辑器、终端内部不加 `backdrop-filter`，WKWebView 和 WebKitGTK 在大面积滚动区上开模糊会掉帧。
- **降级**：`@supports not (background: color-mix(...))` 和 `@media (prefers-reduced-transparency: reduce)` 下都回落到不透明的 `bg-card` / `bg-popover`，并去掉 `backdrop-filter`。
- **与背景图功能共存**：结构面板继续使用现有 `ws-surface*`、`ws-msg-*`、`ws-chrome-border` 类，它们在开图时负责半透明。玻璃工具类不得覆盖这些类的开图规则。

## 3. 圆角

沿用现有乘法式刻度（`--radius: 0.625rem` = 10px），apple 预设不改 `--radius`，用户的圆角滑块继续生效。

| 刻度 | 默认值 | 参考平台对应 | 用在 |
| --- | --- | --- | --- |
| `rounded-sm` | 6px | 复选框 5px | 复选框、紧凑标签 |
| `rounded-md` | 8px | 分段控件内项 8px | 紧凑列表行、树节点、工具栏图标按钮 |
| `rounded-lg` | 10px | 输入框、导航项、分段控件 10px | 输入框、选择器、文本域、侧栏导航项 |
| `rounded-xl` | 14px | 菜单、下拉 12px | 菜单、下拉面板、弹出框、小卡片 |
| `rounded-2xl` | 18px | 卡片 `radius-apple` 18px | 卡片、看板列、代码块、表格容器 |
| `rounded-3xl` | 22px | 对话框、抽屉、侧栏 22px | 对话框、抽屉、浮动侧栏 |
| `rounded-full` | 胶囊 | 按钮、徽标、开关、头像 | 按钮、徽标、开关、头像、搜索框 |

现状差异：radix-maia 把输入框、选择器、按钮组都做成了 `rounded-4xl` 胶囊。按参考平台，**按钮保持胶囊，输入类控件改为 `rounded-lg`**。

## 4. 字体与字号

- **界面字体**：apple 预设对应系统字体（macOS 上是 SF Pro，Windows 上是 Segoe UI，中文回落到苹方 / 微软雅黑），即现有的 `system-ui` 字体预设，并把它设为新用户的默认字体。已保存字体选择的用户不变。等宽字体沿用现有设置。
- **字重**：正文 400；标签、按钮、表头 500；标题 600。
- **字距**：标题 `tracking-tight`（大标题 `-0.02em`）。正文不加全局负字距，中文在 -0.01em 下会显得挤。
- **数字**：统计值、计数、时间、进度用 `tabular-nums`。
- **字号工具类**（rem，随缩放）。参考平台的 11.5px、12.5px、13.5px 半像素字号统一取整：

| 工具类 | 100% 下 | 用途 |
| --- | --- | --- |
| `text-3xs` | 10px | 已有，不再新增使用 |
| `text-2xs` | 11px | 元信息、计数角标、分组小标题 |
| `text-xs` | 12px | 次要说明、表单提示与错误、徽标 |
| `text-ui`（新增，0.8125rem） | 13px | 舒适密度下的正文、表格、菜单项、输入框、按钮 |
| `text-sm` | 14px | 会话消息正文、Markdown 正文 |
| `text-heading-sm`（新增，0.9375rem） | 15px | 卡片标题、区块标题 |
| `text-heading`（新增，1.0625rem） | 17px | 对话框标题 |
| `text-xl` / `text-2xl` | 20 / 24px | 设置页标题、登录卡片标题 |
| `text-page-title`（新增，1.75rem） | 28px | 页面主标题（`PageHeader`） |
| `text-display`（新增，2.75rem） | 44px | 只用于登录页主视觉 |

## 5. 间距与密度

参考平台是后台管理风格，信息密度低。本项目的工作区（侧栏、标签条、会话时间线、文件树、Git 面板、终端、状态栏）需要高密度，因此定义两档密度。两档的颜色、圆角体系、悬停与选中语义、动效完全一致，只缩尺寸。

| 元素 | 舒适（页面级） | 紧凑（工作区） |
| --- | --- | --- |
| 适用 | 设置、登录、项目启动、导入、自动化、任务看板、对话框、抽屉 | 侧栏会话列表、标签条、辅助面板、文件树、Git、状态栏、会话消息区、输入框工具条 |
| 页面边距 / 最大宽度 | `px-6`，内容区 `max-w-[1280px]` 居中 | 贴边，由分栏决定 |
| 页头 | 60px（`h-15`），页面标题 28px，下边距 24px | 标签条 / 面板头 40px（`h-10`，与现状一致） |
| 卡片内边距 | 20px（`p-5`），头部 `px-5 pt-4 pb-3` | 12px（`p-3`） |
| 区块间距 | 20–24px | 8–12px |
| 列表 / 表格行 | 44px | 32px；树节点和文件行保持现有高度（≤28px），不放大 |
| 按钮 | `lg` 44 / `default` 34 / `sm` 28 | `xs` 24 / `sm` 28 |
| 图标按钮 | 32px | 24–28px |
| 输入框 / 选择器 | 36px（`h-9`） | 28–32px |
| 正文字号 | 13px（`text-ui`） | 13px；元信息 11–12px；会话正文 14px |
| 图标尺寸 | 16px | 14px（行内），12px（徽标内） |
| 行圆角 | — | `rounded-md` |

## 6. 阴影与层次

- 层次从下到上：应用背景 → 侧栏 / 卡片（`shadow-glass`）→ 悬停中的可点击卡片（`shadow-pop`，上浮 2px）→ 浮层（`surface-glass-strong` + `shadow-pop`）→ 对话框遮罩（浅色黑 20% + 2px 模糊，深色黑 50%）。
- 卡片描边用 `ring-1 ring-foreground/8` 或玻璃白描边，不同时叠加粗边框和重阴影。
- 主按钮带一层主色投影：`shadow-[0_1px_2px_color-mix(in_oklab,var(--primary)_30%,transparent)]`。侧栏激活项：`0 2px 8px` 主色 28%。
- z-index 和 portal 层级沿用项目现状，不照搬参考平台的数值。

## 7. 动效

| 名称 | 时长 | 缓动 | 用于 |
| --- | --- | --- | --- |
| 按下 | 150ms | `ease-out` | 按钮 `active:scale-[0.97]`，图标按钮 `active:scale-95` |
| 悬停 / 颜色 | 150ms | `ease-out` | 背景、边框、文字颜色 |
| 淡入 `anim-fade` | 200ms | `ease` | 菜单、下拉、提示 |
| 弹出 `anim-pop` | 220ms | `--ease-apple` | 对话框：透明度 0→1，缩放 0.97→1，位移 -48%→-50% |
| 滑入 `anim-slide` | 250ms | `--ease-apple` | 抽屉、Toast：从侧边 24px 滑入 |
| 上浮 `anim-fade-up` | 350ms | `--ease-apple` | 页面头部、卡片网格首屏，最多 12 项，每项延迟 30ms |

- `--ease-apple: cubic-bezier(0.2, 0.8, 0.2, 1)`。基于 tw-animate-css 的 `data-open:animate-in` 写法时，把 `duration-100` 调到上表时长，缩放用 `zoom-in-97`。
- 虚拟列表行、会话消息行不加进入动画（会干扰高度测量），沿用现有的 `tool-content-fade` 和 `reply-fold-*`。
- `prefers-reduced-motion: reduce` 时去掉位移和缩放，只保留透明度变化；`data-chat-animations="off"` 时会话区的动效一律关闭。

## 8. 组件规范

下表是参考平台组件到本项目 `src/components/ui/*` 的对应关系。改造只动 class，props 和 DOM 结构保持不变；需要新组件时新增文件，不改旧组件的签名。

### 8.1 按钮 `button.tsx`

- 形状：胶囊 `rounded-full`，`font-medium`，`text-ui`。
- 反馈：`active:scale-[0.97]`（替换现有 `translate-y-px`）；`focus-visible:ring-4 ring-ring/20`；禁用 `opacity-40 cursor-not-allowed`。
- 变体：

| 现有 variant | 参考平台 | 样式 |
| --- | --- | --- |
| `default` | primary | `bg-primary text-primary-foreground hover:bg-primary/90` + 主色投影 |
| `secondary` | secondary | `bg-secondary hover:bg-accent`（灰色填充） |
| `outline` | 无直接对应 | `border-input bg-card hover:bg-accent`，用于需要边框的次要操作 |
| `ghost` | ghost / plain | `hover:bg-accent`。表格行内操作用 ghost 加 `text-primary-text`（参考 ghost 是蓝字） |
| `destructive` | danger | 静止 `bg-destructive/10 text-destructive`，悬停 `bg-destructive text-white` |
| `link` | — | `text-primary-text hover:underline` |

- 尺寸：`lg` h-11、`default` h-[2.125rem]、`sm` h-7、`xs` h-6；图标按钮 `icon` 32、`icon-sm` 28、`icon-xs` 24。
- 一个视图只放一个主按钮，位置在页头右侧或对话框底部最右。

### 8.2 图标按钮与提示

- 纯图标按钮必须有 `aria-label`，并包一层 Tooltip，文案与 `aria-label` 一致。
- Tooltip：300ms 延迟，`rounded-lg`，`bg-foreground/90 text-background text-xs`，`backdrop-blur`，`anim-fade`，偏移 6px。

### 8.3 输入类 `input.tsx` `textarea.tsx` `select.tsx` `combobox.tsx` `input-group.tsx`

- `h-9 rounded-lg border-input bg-card/80 px-3 text-ui`，占位符 `text-muted-foreground`。
- 聚焦：`border-ring ring-4 ring-ring/15`。
- 校验失败：`aria-invalid` 时 `border-destructive ring-4 ring-destructive/10`。
- 带前置图标：图标 14px，`start-3`，输入 `ps-9`。
- 下拉面板：`surface-glass-strong rounded-xl p-1`；选项 `h-8 rounded-lg ps-7 pe-3`，勾选标记在起始侧；**高亮项实心主色**（`data-highlighted:bg-primary data-highlighted:text-primary-foreground`），这是参考平台沿用 macOS 菜单的习惯。

### 8.4 表单字段 `field.tsx` `label.tsx`

- 标签在上：`text-xs font-medium text-foreground/80 mb-1.5`，必填项在标签后加红色星号。
- 字段下方一行：有错误显示错误（`text-xs text-destructive`），否则显示提示（`text-xs text-muted-foreground`），不同时显示。
- 两列表单 `grid grid-cols-2 gap-3`，窄屏单列。
- 校验时机：提交时统一校验并就地标红；简单的单项拦截可用 Toast。

### 8.5 卡片 `card.tsx`、`shared/setting-card.tsx`、`shared/settings-section.tsx`

- `surface-glass rounded-2xl`；头部标题 `text-heading-sm font-semibold tracking-tight`，副标题 `text-xs text-muted-foreground mt-0.5`，右侧放操作。
- 可点击卡片：`cursor-pointer hover:-translate-y-0.5 hover:shadow-pop transition`。
- 统计卡（参考 `Stat`）：标签 `text-xs text-muted-foreground`，数值 28px 半粗 `tabular-nums`，右上角 32px 圆形色调图标。

### 8.6 徽标 `badge.tsx`

- `h-5.5 rounded-full px-2 text-2xs font-medium`，色调按 2.3 表。
- 状态徽标带圆点：`size-1.5 rounded-full bg-current`。
- 类型标签（非状态）用 `rounded-md bg-muted px-1.5 text-2xs`，与状态徽标区分。

### 8.7 选项卡与分段控件 `tabs.tsx`、新增 `segmented.tsx`

- **分段控件**（视图切换，如卡片 / 列表、我的 / 全部）：容器 `rounded-lg bg-muted p-[3px]`；项 `rounded-md h-7 px-3 text-ui font-medium text-foreground/70`；选中 `bg-card text-foreground shadow-sm`。`TabsList` 的 `default` 变体改成这个外观。
- **下划线选项卡**（同一对象的内容分区）：`line` 变体，底部 1px 分隔线，激活项文字 `text-foreground`，下方 2px 主色圆角条，左右各缩进 12px。
- **子页导航**（对象内的多个子页面）：白底胶囊组 `rounded-xl bg-card/60 p-1`，激活项 `bg-card shadow-sm`。

### 8.8 对话框 `dialog.tsx`、`alert-dialog.tsx`

- 遮罩：`bg-black/20 backdrop-blur-[2px]`（深色 `bg-black/50`），`anim-fade`。
- 容器：`surface-glass-strong rounded-3xl`，默认宽 560px（确认框 420px），最大高度 86vh，内容区滚动。
- 布局：头部 `px-6 pt-5 pb-3`，标题 `text-heading font-semibold tracking-tight`，描述 `text-xs text-muted-foreground mt-1`；关闭按钮在末端（RTL 下自动翻转）；内容 `px-6 pb-4`；底部 `border-t px-6 py-3.5`，按钮右对齐，取消在前、主操作在后。
- 确认框（AlertDialog）：标题直接写问题（如“删除这个会话？”），描述写后果；危险操作的确认按钮用 `destructive`。

### 8.9 抽屉 `drawer.tsx`

- 详情面板从右侧滑出，**悬浮式**：距视口上、下、末端各 8px，`rounded-3xl surface-glass-strong`，遮罩黑 10%。
- 头部 `border-b px-5 py-3.5`：标题 16px 半粗截断，末端放附加操作和关闭按钮。
- 移动端底部抽屉、全屏抽屉保持现有交互，只换表面样式。

### 8.10 菜单 `dropdown-menu.tsx`、`context-menu.tsx`、`command.tsx`、`popover.tsx`、`hover-card.tsx`

- 面板 `surface-glass-strong rounded-xl p-1 min-w-[180px]`，偏移 6px。
- 项 `h-8 rounded-lg px-2.5 gap-2 text-ui`，图标 14px。
- 高亮：普通项实心主色白字；危险项默认红字，高亮时实心红底白字。
- 分隔线 `my-1 h-px bg-border`；分组标题 `text-2xs text-muted-foreground px-2.5`。

### 8.11 表格

参考平台的数据表是本项目表格（设置页列表、Markdown 表格、日志、监控）的统一样式：

- 容器 `rounded-2xl` 卡片，横向滚动。
- 表头吸顶，`text-ui font-medium text-muted-foreground`，`px-3.5 py-2.5`，底部 1px 分隔线，背景为卡片色 95%。
- 单元格单行，超长截断并用 `title` 显示全文；行高舒适 44px、紧凑 32px；行间分隔线为前景色 5%。
- 行悬停 `bg-primary/4`，150ms 过渡；末行无底线。
- 编号、哈希等标识用 `font-mono text-xs`，可跳转的标识用 `text-primary-text hover:underline`。
- 空表格占一行，高 160px，居中放空状态。
- 分页：底部 `px-5 py-3 text-xs text-muted-foreground`，左侧总数，右侧上一页 / 页码 / 下一页。

### 8.12 开关、复选框、单选、滑块、进度

- 开关：38×22，滑块 18px 白色带阴影；打开为 `bg-switch-on`。
- 复选框：18px，`rounded-sm`，选中和半选为主色实心、白色对勾（描边 3）。
- 进度条：高 6px，`rounded-full bg-muted`，填充主色，宽度变化有过渡。

### 8.13 Toast `app-toaster.tsx`（sonner）

- 位置右下（移动端顶部居中保持现状），宽 360px，`surface-glass-strong rounded-2xl px-4 py-3`，`anim-slide`。
- 左侧 8px 圆点表示状态（成功 `tone-success`、失败 `tone-danger`、信息 `primary`），标题 `text-ui font-semibold`，描述 `text-xs text-foreground/80`。
- 默认 3.2 秒，可向右滑动关闭。
- 用法：操作成功给一句结果（“已复制会话 ID”），失败写原因和下一步。

### 8.14 空状态与错误页

- 空状态：28px 线性图标（描边 1.4，`text-muted-foreground/60`）+ `text-ui text-muted-foreground` 一句话 + 可选操作按钮，上下 32px。
- 403 / 404 / 连接失败页：64px 圆角方块图标（色调底），56px 半粗数字或标题，15px 说明，主按钮“返回”。

### 8.15 头像

- 圆形，渐变底（主色系色板），白色首字，字号为尺寸的 42%；叠放时 `ring-2 ring-background`，`-space-x-2`。

### 8.16 页面头部 `PageHeader`（新增）

- 可选眉题（`text-xs font-medium text-primary-text mb-1`）、标题（`text-page-title font-semibold tracking-[-0.02em]`）、副标题（14px `text-muted-foreground max-w-3xl mt-1.5`），末端放操作按钮组；下边距 24px，`anim-fade-up`。

## 9. 布局规范

- **桌面工作区**：应用背景铺底；侧栏是浮动玻璃面板（与窗口边缘留 8px，`rounded-3xl`），宽度可拖拽；主区域无边框贴背景。若浮动侧栏与 macOS 红绿灯、拖拽区或 `chrome-reserve` 几何冲突，保留贴边侧栏，只换玻璃表面和颜色。
- **侧栏导航**：项 `h-9 rounded-lg px-3 gap-2.5 text-ui`（参考平台 13.5px，取整为 13px），图标 16px；激活项实心主色白字加主色投影；悬停 `bg-sidebar-accent`；分组标题 `text-2xs font-medium text-muted-foreground px-3 pt-5 pb-1.5`。
- **紧凑列表的选中态**（会话列表、文件树、Git 列表）：`bg-primary-soft`，文字保持前景色，图标或标记用 `text-primary-text`；键盘焦点额外显示 `ring-2 ring-ring/30`。实心主色只留给主导航，避免高密度列表一片蓝。
- **设置页**：左侧导航沿用侧栏导航样式；右侧内容区 `max-w-[1280px]`，顶部 `PageHeader`，分组用卡片。
- **标签条**：高 40px，激活标签用卡片色底和细描边，未激活标签 `text-muted-foreground hover:text-foreground`；背景图开启时沿用现有“拱门”描边逻辑。
- **状态栏**：高度不变，`text-2xs`，分隔线用 `--border`；告警项用状态色圆点。

## 10. 会话与内容渲染

- **消息**：用户气泡 `rounded-2xl bg-secondary px-3.5 py-2 text-sm`，助手消息无气泡；时间、作者等元信息 `text-2xs text-muted-foreground`。保留 `ws-msg-*` 与 `.is-user` / `.is-assistant` 的开图规则。
- **执行过程时间线**：沿用 `--activity-*` 令牌和几何定义；胶囊头部 `rounded-full`；详情框 `rounded-xl`。
- **Markdown 正文**：14px，行高 1.6；标题依次 20 / 17 / 15 / 14px 半粗；链接 `text-primary-text`，悬停下划线；引用块起始侧 3px `--primary-soft` 竖线、`text-muted-foreground`；列表缩进 1.25rem；分隔线 `--border`。
- **代码块**：单卡片 `rounded-xl border`，标题栏 40px `bg-muted/80`，代码正文 12–13px 等宽；复制等操作按钮用 ghost 图标按钮。行内代码沿用胶囊样式。
- **表格**：按 8.11 的数据表样式，容器 `rounded-xl`。
- **Mermaid 流程图**（`ai-elements/mermaid-theme.ts`）：
  - 浅色：节点底 `--primary-soft`，节点边框主色 60%，节点文字前景色；连线 `oklch(0.711 0.007 286.2)`（参考 `faint`）；分组底 `--muted`、边框 `--border`；连线标签为卡片色胶囊加细边框。
  - 深色：节点底主色 18% 叠在卡片色上，边框 `--primary-text`，文字前景色，连线 `--muted-foreground`。
  - 节点圆角 10px，字体 `var(--font-sans)`，连线默认直角折线。
  - 平移缩放控件用 `surface-glass` 小胶囊。
  - Mermaid 只接受具体颜色值，调色板按当前预设和明暗解析成十六进制后传入，并补对应测试。
- **数学公式**：继承正文颜色，不单独上色。
- **差异视图**：继续使用 `--diff-*` 令牌，只调整容器圆角和行高。

## 11. 编辑器、终端与画布

- **Monaco**：`monaco-themes.ts` 的画布底色和当前行高亮表新增 `apple` 项（浅色 `#ffffff` / `#f5f5f7`，深色 `#161618` / `#2c2c2e`）；选区和光标颜色跟随主色。
- **终端（xterm）**：背景继续从容器解析；光标和选区改为主色，ANSI 16 色保持不变（保证命令行输出可读）。
- **无限画布（@xyflow/react）**：节点卡片 `rounded-2xl` + `shadow-glass`，选中 `ring-2 ring-primary/25`；派生连线用主色实线，依赖连线用 `tone-info` 虚线；图例、缩放控件用 `surface-glass rounded-xl`。

## 12. 交互习惯

以下习惯从参考平台提炼，新界面和改造后的界面都要遵守：

1. **主操作位置固定**：页面主操作在页头末端，对话框主操作在底部最末。一屏只有一个主按钮，其余用次要或幽灵按钮。
2. **视图切换用分段控件**，内容分区用下划线选项卡，对象子页面用胶囊导航。三者不混用。
3. **详情不跳页**：列表项详情优先用右侧悬浮抽屉，保留列表上下文；需要完整编辑时才用对话框或独立页。
4. **危险操作先确认**：删除、重置、强制退出、丢弃修改等不可逆操作弹 AlertDialog，标题是问题，描述写后果，确认按钮为危险样式。可撤销操作直接执行并给 Toast。
5. **每个操作都有反馈**：按下缩放、悬停变色、提交中按钮显示旋转图标并禁用、完成后 Toast。复制操作统一提示“已复制 …”。
6. **禁用要说明原因**：不能执行的操作要么不显示，要么禁用并用 Tooltip 或字段提示说明原因；点击被拦截时用失败 Toast 说明。
7. **筛选有明确的应用时机**：表格筛选区提供“查询 / 重置”时，修改条件不立即刷新；即时搜索框则边输边筛。同一页面只用一种。
8. **表格内容单行**：超长截断，悬停显示全文；行内操作用小号幽灵按钮，危险操作用红字。
9. **空状态给出下一步**：说明为什么空，有可执行操作时放按钮。
10. **全局搜索分组展示**：结果按类型分组，左侧类型标签、中间标题、末端编号，悬停整行主色高亮；无结果时说明“没有可访问的匹配结果”。
11. **键盘可达**：所有浮层可用 Esc 关闭，焦点回到触发元素；菜单和选择器支持方向键；`focus-visible` 才显示聚焦环。
12. **动效服务于方位**：对话框从中心弹出，抽屉和 Toast 从侧边滑入，页面内容向上淡入；不用无意义的循环动画（运行中指示除外）。

## 13. 无障碍与兼容

- 文字对比度 ≥ 4.5:1，大字（≥ 18.66px 粗体或 24px）和图标、控件边界 ≥ 3:1。新增或修改颜色令牌时按 12+1 套预设 × 明暗复算。
- 支持 `prefers-reduced-motion`、`prefers-reduced-transparency`、`prefers-color-scheme`。
- 缩放 80%–300% 下不截字、不溢出；根元素行高规则（`line-height: 1.5em`）不动。
- WKWebView（macOS 桌面）、WebView2（Windows）、WebKitGTK（Linux）、Chromium（服务器模式浏览器）都要验证；老引擎缺 `color-mix` 时有不透明回落。
- RTL 语言（阿拉伯语）下布局、图标方向、抽屉方向正确。

## 14. 禁止事项

- 组件内写死颜色值、像素字号、z-index 魔数。
- 为改样式而修改组件 props、事件处理、数据流、i18n 键名或 `data-*` 测试锚点。
- 在虚拟列表、会话消息流、编辑器和终端内部使用 `backdrop-filter`。
- 在 apple 预设的装饰性元素（柔光、插画、图表、头像）中使用紫色、品红、橙色。
- 同一个视图出现两个主按钮，或用实心主色做高密度列表的选中态。
