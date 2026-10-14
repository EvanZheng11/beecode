# 顶层侧栏标题累计吸顶修复计划

> 日期：2026-10-14
> 目标：完成聊天、文件夹、最近三个顶层 section 的累计吸顶，并修订当前实现对应的规格与验收计划。

## 目标行为

- 顶层 section 按实际 `rows` 与 `sectionOrder` 排列；默认顺序为聊天、文件夹、最近的验收顺序。
- section 标题按进入顺序形成有序 sticky 栈。前面已经进入槽位的标题持续保留，后来的标题追加到栈尾。
- 每个 section 使用独立浮层、独立槽位和独立 `sectionHeaderElement`。后一个标题接近时，只推顶当前栈末项，不能删除或替换前项。
- 文件夹浮层位于所有 section 浮层下方，使用所有 section 条高之和作为总 inset；每个已经吸顶的真实 section 行分别设置 `inert` 与 `aria-hidden`。
- 拖拽开始时清空整个 section 栈和 folder sticky 状态；拖拽结束后按当前 rows 与滚动位置重新计算。
- 所有浮层都在 `Virtualizer` 内容流之外，不改变 `scrollSize`、行偏移、底部边界或虚拟化参数。

## 状态与几何

1. `stickySections` 保存按 rows 顺序进入栈的 `SidebarSectionKey[]`；`sectionOverlayRefs` 保存每个 section 浮层节点。
2. `recomputeSticky` 读取 `VirtualizerHandle` 的 `scrollOffset`、`findItemIndex`、`getItemOffset` 和 `getItemSize`，不自行累计实际行高。
3. 每个 section 标题的槽位由此前已进入栈的标题条高度之和决定。标题条顶部加上当前缩放下的 `0.75rem` 顶隙，标题条高度使用 `2rem`。
4. 只有栈末 section 使用下一个 section 标题计算推顶位移；栈中前项保持自己的整数像素槽位。
5. 文件夹 sticky 的 `computeStickyState` 使用 section 栈总高度作为 `inset`，最终位置为 `sectionStackHeight + folderState.translateY`。
6. `sectionHeaderElement` 同时服务真实行和浮层，保留折叠、新建、四个文件夹操作、最近过滤及无障碍属性。

## 测试验收

### 组件行为

- 顶部只渲染真实 section 标题。
- 按实际 section 顺序累计显示多个浮层；聊天、文件夹、最近三个标题可以同时存在，各自 transform 分别为自己的槽位。
- 栈末 section 接近下一个标题时只发生末项推顶；反向滚动时按槽位移除后来的 section，前项仍按几何规则保留。
- 文件夹浮层位于 section 栈之下，并使用总 inset；文件夹自己的交接只改变文件夹浮层。
- 真实 section 行逐个抑制，浮层保持唯一可访问标题；浮层按钮和切换回调继续有效。
- 拖拽、缩放、折叠、空 section、无文件夹行、最近过滤、四个文件夹按钮和底部边界继续通过既有测试。
- 底部专项验收使用聊天 10 条、文件夹 15 行、最近 10 条和 20 行视口。滚到底部时，section 栈显示聊天标题和文件夹标题，实际内容保留文件夹 7 行、最近标题和最近 10 条，合计 `2 + 7 + 1 + 10 = 20` 行。

### 选择器与无障碍

- 测试用 `data-sticky-section` 和 `data-sticky-folder` 定位浮层。
- 不使用脆弱的 `closest("div.absolute")`。
- section 浮层和真实行均复用 `SidebarSectionHeader`；真实行只在对应浮层存在时设置 `inert` 与 `aria-hidden`。
- 浮层不进入 `data-virtua-content`，不产生额外上下 padding 或列表占位。

## 实施范围

- 保留当前两个未提交文件中已经完成的累计栈、共享标题构建器、受控 virtua 几何、无障碍标记、数据属性和新增行为测试。
- 修正底部验收夹具，使其表达 20 行视口的实际模型；修正测试中依赖固定行步长的 section 和 folder 索引。
- 更新设计规格中的状态、槽位、累计保留、总 inset 和 20 行底部验收。
- 更新本计划，删除单浮层、后者替换前者、旧的单 section 状态等过时描述。
- 不新增依赖、不新增 i18n key、不修改 `.superpowers/sdd` 文件。

## 验证与交付

按以下顺序运行并记录结果：

```bash
pnpm exec vitest run src/components/conversations/sidebar-conversation-grouping.test.ts src/components/conversations/sidebar-conversation-list.test.tsx src/components/conversations/sidebar-section-header.test.tsx
pnpm test
pnpm lint .
pnpm exec tsc --noEmit
pnpm build
git diff --check
```

验证通过后，只提交实现、测试、规格、计划和最终报告，提交信息固定为：

```text
fix: 按需求累计堆叠侧栏顶层标题
```

最终报告写入 `.superpowers/sdd/2026-10-14-sticky-top-sections/final-fix-report.md`，报告包含修改文件、根因、每条验证命令及结果、提交哈希和未解决风险。
