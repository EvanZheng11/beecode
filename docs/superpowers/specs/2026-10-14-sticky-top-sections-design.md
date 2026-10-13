# 顶层侧栏标题吸顶（聊天 / 文件夹 / 最近）设计

- 日期：2026-10-14
- 状态：设计已确认（方案 A），待实施
- 影响面：前端 `src/components/conversations/`；无后端、无数据库、无 IPC 改动
- 运行环境：桌面与 Web 共用同一份前端逻辑，两端行为一致

## 1. 背景与根因

侧栏会话列表（`SidebarConversationList`）把「置顶 / 文件夹 / 聊天 / 最近」四个段落的标题行与正文行放进同一个 virtua 虚拟化列表：

- `<Virtualizer itemSize={32} bufferSize={400} onScroll={...}>`（`sidebar-conversation-list.tsx`）；
- 段落标题是 `kind === "section"` 的行，由 `SidebarSectionHeader` 渲染；「文件夹」标题右侧有 4 个操作按钮：新建分组、导入本地会话、克隆仓库、打开文件夹；「聊天 / 最近」有新建按钮，「最近」另有过滤菜单（全部 / 聊天 / 文件夹）；
- 现状唯一的吸顶是**文件夹级**浮层：`computeStickyState`（`sidebar-conversation-grouping.ts`）+ `recomputeSticky`（列表组件），只对 `kind === "folder"` 行生效；`buildOwnerHeaderIndex` 在 `section` 行处把归属重置为 -1，所以滚进「聊天 / 最近」后文件夹浮层会消失。

根因：段落标题没有任何吸顶逻辑。用户向下滚动时，标题（以及标题上的展开/收起、4 个文件夹按钮、最近过滤菜单）随行被 virtua 卸载或滚出视口，导致：

1. 不知道自己当前在哪个段落；
2. 想折叠当前段落、新建会话、加文件夹、切换「最近」过滤时，必须回滚到列表顶部；
3. 与已有文件夹吸顶行为不一致。

方案 A：保留现有文件夹吸顶层，新增一个**段落标题吸顶层**，两者在同一视口顶部叠成「吸顶栈」——段落标题在最上，文件夹标题紧贴其下；两者都用 iOS 式「下一个标题推顶」的交接方式。

被否掉的替代方案（仅记录取舍，不在本次实施）：

- 用 CSS `position: sticky`：virtua 会卸载缓冲区外的行，被卸载的节点无法靠 CSS 保持吸顶，pass。
- 把段落标题移出虚拟列表、固定在滚动容器外：四种段落顺序、折叠状态、4 个按钮都要在列表外重新接线，改动面远大于浮层复用，pass。
- 为吸顶在内容顶部预留 padding：会改变 `scrollSize` 与底部可达位置，违反第 7 节约束，pass。

## 2. 吸顶栈行为定义

候选行：**所有 `kind === "section"` 的行**（`sectionOrder` 决定「文件夹 / 聊天 / 最近」的先后；「置顶」存在时恒在最上，它与其余段落是同一类行，同样吸顶，不硬编码三个）。同一时刻最多一个段落标题吸顶。

设某段落标题行的真实边框盒顶部为 `rowTop`，其内部标题条（`h-[2rem]`）顶部为 `barTop`，条高为 `barHeight`：

| 场景 | 行为 |
| --- | --- |
| 标题条尚未滚出视口顶部（`scrollOffset <= barTop`） | 不显示浮层，真实标题行就是交互目标 |
| 标题条已滚出（`scrollOffset > barTop`），且下一个段落标题条距顶部超过一条高 | 浮层固定在视口顶部（`translateY = 0`）；真实行若仍在缓冲区（未卸载）则保持挂载但 `inert`，避免“双影 + 双 tab” |
| 下一个段落标题条进入「距顶部不足一条高」的范围 | 浮层被推顶：`translateY = 下一个标题条相对顶部位置 - 条高`（负值，上限 0，取整到像素）；下一个标题完全到位后浮层让位，归属切到新段落 |
| 段落已折叠（`expanded === false`） | 标题仍吸顶（折叠后该段只剩标题行）；点击浮层标题可重新展开 |
| 段落为空 / 当前段落无内容 | 与有内容一致：标题吸顶，直到下一个标题推顶 |
| 最后一个段落 | `next` 为空，浮层一直吸顶；不追加任何底部位移 |
| 拖拽排序进行中 | 两个吸顶层都隐藏（拖拽面没有段落行，吸顶会误导；沿用现有文件夹浮层的处理） |

文件夹吸顶层的叠加规则：

- 折叠后的段落顺序与「最近」的显示开关（`showRecent`）只影响候选行集合，计算逻辑不感知具体段落名；
- 当段落浮层可见时，文件夹吸顶层的基准位置 = 段落条高（`barHeight`），即紧贴段落标题下沿；
- 当段落浮层被下一个段落标题推顶（`translateY` 变负）时，文件夹浮层跟随同一位移一起上移，保持「紧贴段落标题下沿」；同一时刻不会有文件夹交接与段落交接冲突（段落交界处其后没有同段文件夹标题）；
- 文件夹浮层自身的交接仍由下一个文件夹标题触发，但推顶下限是它自己的槽位（第 4 节的 `inset`）；在槽位中上滑到完全被段落条遮住后，真实文件夹标题接管。

## 3. virtua 虚拟化约束

- 两个浮层都绝对定位在与 `ScrollArea` 同一个 `relative` 包裹层内（现有文件夹浮层的位置），**不在** `Virtualizer` 的内容流里：不改变 `scrollSize`、行偏移与 `findItemIndex`，因此不必调整 `itemSize={32}` / `bufferSize={400}` / `scrollRef` / `onScroll`。
- 行高不等：段落标题行 `pt-[0.75rem] + h-[2rem]`（100% 缩放时为 44px），其余行为 32px 或由卡片自身决定。virtua 已用 ResizeObserver 实测每一行的尺寸，几何计算必须从句柄读取：
  - `handle.getItemOffset(i)`：行顶部（用于计算 `rowTop`）；
  - `handle.getItemSize(i)`：实测行高（文件夹行的实测值就是条高，现有文件夹逻辑沿用；段落条高用第 4 节的常量，避免把 12px 顶隙算进条高）；
  - `handle.findItemIndex(scrollOffset)`：当前视口顶部所在行的扁平索引；
  - `handle.scrollOffset`：当前滚动偏移。
- 禁止在浮层里做任何影响文档流高度的事情（不加 `pt-*` 占位、不用 `position: static` 的兄弟节点推高内容），否则滚动边界会变。
- `onScroll` 已是「每帧一次」的 rAF 合并（`handleVirtuaScroll`），段落吸顶复用同一次 `recomputeSticky`，不新增监听器；展开/折叠、拖拽起止、视口就绪、数据刷新等不触发 `onScroll` 的几何变化，仍由现有 `useIsomorphicLayoutEffect` 依赖数组覆盖，需把段落吸顶状态加入依赖（与现有 `stickyFolderId` 同理，保证浮层挂载后立刻拿到初始 `transform`）。
- 滚动偏移按行归属解析时用 `findItemIndex` 而不是自己维护累积高度，避免缩放 / 变高行下的漂移。

## 4. 几何计算（纯函数，可测）

新增/扩展都在 `sidebar-conversation-grouping.ts`，不碰 DOM：

1. `sectionHeaderFlatIndices(rows)`：所有 `kind === "section"` 行的扁平索引，升序（镜像现有 `folderHeaderFlatIndices`）。
2. `buildSectionHeaderIndex(rows)`：与 `buildOwnerHeaderIndex` 同构但不重置——遇到 `kind === "section"` 把 current 设为该行索引，输出每个扁平索引归属的段落标题索引。滚进 `chats-empty`、`recent-more` 等行时归属自然落到所属段落。
3. 现有 `computeStickyState` 增加可选参数 `inset = 0`（缺省时行为与现在完全一致，现有文件夹测试不回归）：

```ts
export function computeStickyState(args: {
  scrollOffset: number
  activeHeaderOffset: number // 标题「条」的顶部；段落行要加上顶隙
  nextHeaderOffset: number | null // 下一个标题「条」的顶部
  headerHeight: number // 条高
  inset?: number // 该标题槽位距视口顶部的距离，文件夹叠在段落下面时为段落条高
}): { visible: boolean; translateY: number }
```

公式：

```text
visible = scrollOffset > activeHeaderOffset
if (visible && nextHeaderOffset != null) {
  const d = nextHeaderOffset - scrollOffset
  if (d >= 0 && d < inset + headerHeight)
    translateY = Math.round(d - inset - headerHeight) // ≤ 0
}
```

组件内的输入（`sidebar-conversation-list.tsx`）：

```ts
const REM_PX = (16 * zoomLevel) / 100 // 全仓 rem 随窗口缩放，见 appearance-provider
const SECTION_TOP_GAP = 0.75 * REM_PX // 与 SidebarSectionHeader 的 pt-[0.75rem] 对应
const SECTION_BAR_HEIGHT = 2 * REM_PX // 与 h-[2rem] 对应，文件夹行高沿用 FOLDER_ROW_HEIGHT
const rowTop = (i: number) => handle.getItemOffset(i)
const barTop = (i: number) => rowTop(i) + (rows[i].kind === "section" ? SECTION_TOP_GAP : 0)
```

`recomputeSticky` 里的顺序：

1. `sectionIdx = sectionIndex[Math.max(0, Math.min(rows.length - 1, handle.findItemIndex(handle.scrollOffset)))]`；若 `< 0`（理论上不会——首行是段落行），段落浮层置空。
2. `nextSectionIdx = nextHeaderAfter(sectionFlatIndices, sectionIdx)`（复用现有「严格大于」的查找）。
3. `sectionState = computeStickyState({ scrollOffset, activeHeaderOffset: barTop(sectionIdx), nextHeaderOffset: nextSectionIdx == null ? null : barTop(nextSectionIdx), headerHeight: SECTION_BAR_HEIGHT })`。
4. 文件夹侧：沿用现有归属 / 下一个文件夹标题的解析；`folderInset = sectionState.visible ? SECTION_BAR_HEIGHT : 0`；文件夹条自身 `translateY_f = computeStickyState({ ..., headerHeight: rowHeight, inset: folderInset })`；最终写入文件夹浮层的 `transform`：

```text
folderTotalY = sectionState.translateY + folderInset + folderState.translateY
```

5. 注意现有 `recomputeSticky` 在「没有任何文件夹行」时提前 return，会连带跳过段落计算——实施时必须把段落计算提到最前，文件夹部分的早退只清文件夹状态。

浮层 DOM（`transform` 只写 style，不参与 React 重渲染路径）：

- 段落浮层：`absolute left-0 right-0 top-0`，`translateY(sectionState.translateY)`；只渲染标题「条」，**不带顶隙**（`topGap={false}`），否则置顶时顶部会露出 12px 透明缝，透出下方滚动的行；底色 `bg-sidebar` 与下方行一致，负责遮挡。
- 文件夹浮层：保持现有节点与 `overlayRef`，仅 `transform` 改为 `folderTotalY`。
- z 序与 DOM 顺序：文件夹浮层先渲染，段落浮层后渲染（或段落 `z-index` 更高），保证交接时文件夹条滑到段落条下方被遮住；视觉从上到下 = 段落条 → 文件夹条。

## 5. 吸顶层与原始节点的交互 / 无障碍

- **抑制原始节点**：给 `SidebarSectionHeader` 增加 `suppressed?: boolean`（与 `FolderHeader` 的现有约定一致）：为真时在根节点设置 `inert={true}` + `aria-hidden="true"`。当某段落的浮层显示时，把该段落的 `kind === "section"` 真实行标记为 suppressed，避免 virtua 尚未卸载它时出现两个可聚焦控件 / 双份朗读。
- **浮层是正式控件**：浮层渲染同一个 `SidebarSectionHeader`（`memo` 不失效），带完整 `aria-expanded` / `aria-label` / `title`，键盘可聚焦、可回车触发；当真实行已滚出缓冲并被卸载时，浮层就是该段落唯一的键盘 / 读屏入口。
- **指针事件**：浮层容器 `pointer-events-none`，只有标题条本身 `pointer-events-auto`；容器其余区域不拦截下方列表的点击。标题条的 hover 揭示（4 个文件夹按钮、新建、过滤菜单）依赖组件内部的 `group/header`，浮层副本自动继承；触屏（`[@media(hover:none)]`）仍常显。
- **下拉菜单**：最近过滤菜单由 Radix 门户渲染，浮层位置不受影响；触发器已有 `data-[state=open]:opacity-100`，打开菜单导致 body `pointer-events:none` 时按钮不会消失。
- **焦点顺序**：浮层渲染在 `ScrollArea` 之后，tab 顺序在列表内容之后（与现有文件夹浮层一致，不新增焦点陷阱）。
- **拖拽**：`dragging !== null` 时清空两个吸顶状态（拖拽面替代虚拟列表，句柄几何已过期）。
- **文案**：不新增 i18n key，不修改现有标签。

## 6. 展开收起与「文件夹」的 4 个操作按钮

- 浮层标题点击调用 `toggleSection(section)`，折叠 / 展开走同一条 `setSectionCollapsed` + 持久化链路；段落折叠不会删除自己的标题行，扁平索引不变，因此**不做**文件夹浮层那种「折叠后 scrollToIndex 回标题」的附加滚动（回滚反而会打断用户当前位置）。
- 4 个按钮（新建分组、导入本地会话、克隆仓库、打开文件夹）以及「聊天 / 最近」的新建按钮、最近过滤菜单，都通过把 `renderRow` 里内联的段落 props 抽成一个 `sectionHeaderElement(row)` 构建函数来保证：真实行与浮层行使用**同一个**元素构建器、同一批稳定回调（`handleOpenFolderAction`、`handleOpenCloneDialog`、`handleOpenImportWindow`、`openNewGroupDialog`、`openChatModeTab`、`handleNewConversation`、`recentFilter` / `changeRecentFilter`）。回调身份稳定，`memo` 命中率不受影响。
- 按钮均为 toggle 的兄弟节点（现有结构），点击只触发自身动作、不切换折叠；浮层中保持这一点。

## 7. 底部滚动边界不改变

- 浮层绝对定位、不参与内容流：`scrollSize`、`itemSize` / `bufferSize`、`ScrollArea` 的 `px-1.5 pb-1.5` 一律不动；
- 不新增任何顶部占位 / `padding-top`，滚到最底部时最后一行仍可完整到达视口底，滚动条长度与改动前一致；
- 浮层只在视口顶部覆盖，不新增底部遮挡；`scrollToActive`、`recent-more` 分页、拖拽自动滚动逻辑不改。

## 8. 测试策略

### 8.1 纯函数几何测试（`sidebar-conversation-grouping.test.ts`）

- `sectionHeaderFlatIndices`：含 `pinned` 与自定义 `sectionOrder` 的行数组，返回升序索引；空数组返回 `[]`。
- `buildSectionHeaderIndex`：段落行之间（含 `folders-empty` / `chats-empty` / `recent-*`）的每个索引归属正确；遇到新段落切换。
- `computeStickyState` 扩展：
  - `inset = 0` 时逐条复跑现有用例（`visible` 阈值、推顶区间、`nextHeaderOffset = null`、`d < 0` 保护），确保文件夹行为零回归；
  - `inset = 32`：推顶开始得更早（`d < inset + headerHeight`）、`translateY = d - inset - headerHeight`、取整；
  - 阈值边界：`d === inset + headerHeight` 不推顶，`d === 0` 时 `translateY = -(inset + headerHeight)`；
  - `scrollOffset === activeHeaderOffset` 不显示（真实标题接管）。
- 段落条顶部 = 行顶部 + 顶隙的换算：用 100% / 125% 缩放两套常量各断言一次。

### 8.2 组件行为测试（`sidebar-conversation-list.test.tsx`）

现有 virtua mock 的几何是「所有行 32px、`offset = index * 32`」，段落行实际是 44px。扩展 mock 的受控几何（如 `virtuaCtl.itemSizes` / `offsetFor(index)`），默认值保持 32，**现有文件夹吸顶用例不改动**；段落用例显式给段落行 44、其余 32。

必测行为：

1. 列表顶部：不渲染段落浮层，真实标题唯一且可聚焦；
2. 滚进「文件夹」正文：出现「文件夹」浮层；真实行 `inert` + `aria-hidden`，浮层副本 `aria-expanded` 正确；
3. 继续滚进「聊天」：文件夹浮层消失（现有行为保持），「聊天」浮层出现；「最近」同理；
4. 自定义段落顺序（如聊天在前）：吸顶跟随实际顺序，不硬编码；
5. 交接：下一个段落标题进入一条高以内时，断言浮层 `style.transform` 等于 `translateY(d - barHeight)`；完全到位后归属切换；
6. 与文件夹浮层叠加：`Folder 1` 的浮层出现在段落条下方（总位移 = 段落位移 + 32），下一个文件夹标题推顶时两者不重叠；滚到段落交界时段落与文件夹一起上移；
7. 展开 / 收起：点击浮层标题折叠该段（正文行消失、浮层仍在、`aria-expanded=false`），再点展开；不触发额外 `scrollToIndex`；
8. 4 个文件夹按钮：浮层中 `新建分组 / 导入 / 克隆 / 打开文件夹` 各存在一次且点击调用对应 spy；「最近」浮层存在过滤菜单与新会话按钮；
9. 拖拽开始：两个浮层（若显示）立即消失；
10. 底部边界：浮层是 `ScrollArea` 的兄弟节点而非内容节点（断言浮层节点不是虚拟列表内容容器后代），且列表内容无新增上下 padding。

真机手动 QA（jsdom 无布局，virtua 真实窗口化必须手测）：大列表快速滚动时浮层的跟手度、缩放 125% 下的条高与推顶、触屏 hover 常显、macOS 弹性滚动到顶 / 到底。

### 8.3 命令

```bash
pnpm lint .
pnpm test
pnpm build
```

## 9. 不做的范围

- 不调整 virtua 参数、不换成手写虚拟化、不做动态 `itemSize` 估算；
- 不改文件夹吸顶的归属 / 交接语义（只在总位移上叠加段落层）；
- 不加吸顶过渡动画 / 弹簧动效，保持现有「整数像素、无 transition」的浮层写法；
- 不改段落顺序、折叠状态的持久化格式与 i18n 文案；
- 不改 `scrollToActive`、拖拽排序、`recent-more` 分页；
- 不为吸顶在列表顶部或底部预留空间；
- 不新增第三方依赖；
- 不做横向滚动 / 水平吸顶。

## 10. 风险与未决

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 顶隙（`pt-[0.75rem]`）被算进条高 | 浮层提前显示、顶部露缝 | 条高与顶隙用独立常量（rem × 缩放），`visible` 用 `rowTop + 顶隙` 判断 |
| 非 100% 缩放下常量与实测行高不一致 | 推顶错位 | `REM_PX = 16 × zoomLevel / 100`（与 `FOLDER_ROW_HEIGHT` 同一口径）；测试覆盖 125% |
| 真实行未卸载时与浮层同时可交互 | 双 tab 停靠、双朗读 | `suppressed` 走现有 `inert` + `aria-hidden` 约定复用 |
| 段落与文件夹两次交接叠加 | 位移跳变 / 遮挡顺序反了 | 段落位移与文件夹槽位分别计算后相加；DOM/z 序固定为段落在上 |
| 「无文件夹行」早退跳过段落计算 | 段落吸顶在纯聊天工作区失效 | 重排 `recomputeSticky`，段落计算先行（第 4 节第 5 点） |
| 折叠后行高变化未触发 `onScroll` | 浮层停留旧状态 | 现有 layout effect 依赖已含 `rows` / `folderExpanded`，段落状态加入依赖数组 |
