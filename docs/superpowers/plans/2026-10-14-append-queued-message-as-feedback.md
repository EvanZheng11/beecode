# 等待消息追加为实时反馈实施计划

**Goal：** 为等待队列中的用户消息增加“追加”操作。用户点击后，消息从等待队列移除并交给当前已有的实时反馈通道；反馈提交成功后由实时反馈的乐观条目承载，提交彻底失败时把原始消息放回队首。整个流程同一时刻只允许一个消息处于追加中，避免重复提交、编辑竞态和自动 flush 双入队。

**Architecture：** 沿用现有 `MessageQueueDisplay → ChatInput/ConversationShell → ConversationDetailPanel` 调用链。`MessageQueueDisplay` 在真实等待队列行提供“追加”操作；`ConversationDetailPanel` 保存瞬态 `appendingQueuedMessageId`，在编排函数中先用 `getItem` 从权威 queueRef 读取当前项并执行 payload 门控，再用 `remove` 的原子返回值确认仍拥有该 queued id，随后调用 `feedback.steer(item.draft.displayText, item.draft.blocks)`；若 remove 返回空则立即结束。以 `steer` 返回的 `FeedbackItem` 判定成功，彻底失败才调用 `requeueFront`。自动 flush 继续使用既有队列状态和就绪门控，追加进行期间暂停 flush；无活动回合的降级结果由反馈通道自身处理，编排层不得再次入队。

**Tech Stack：** React 19、TypeScript strict、现有 React hooks、`next-intl`、Vitest、Testing Library、pnpm。复用 `PromptDraft`、`QueuedMessage`、`FeedbackItem`、`buildSteerPayload`、`notify` 和现有实时反馈错误文案；不增加依赖或新业务模块。

**Spec：** [docs/superpowers/specs/2026-10-14-append-queued-message-as-feedback-design.md](../specs/2026-10-14-append-queued-message-as-feedback-design.md)

## Global Constraints

- 本计划对应的实现只触及以下既有前端文件和测试文件：`src/components/message/message-list-view.tsx`、`src/components/chat/message-queue-display.tsx`、`src/hooks/use-message-queue.ts`、`src/hooks/use-session-feedback.ts`、`src/components/conversations/conversation-detail-panel.tsx`、`src/i18n/messages/*.json`，以及这些模块已有的测试文件；不创建新模块、不增加依赖。
- `appendingQueuedMessageId` 是组件级瞬态状态，不写入 `QueuedMessage` 持久结构，也不改变队列恢复格式。
- 追加按钮只出现一个入口，当前实现位于真实等待队列行；历史消息没有可验证的 queuedId，不从 MessageListView 提供第二个入口。
- 追加开始前通过 `getItem(id)` 读取权威 queueRef 中的完整 `QueuedMessage` 并执行 payload 门控，再调用返回实际项的原子 `remove(id)`；若 flush 已移除或 id 不存在，立即返回且不调用 `steer`。失败恢复必须使用原始 `draft`、`modeId` 和 `adoptSendTimeMode` 语义，并通过 `requeueFront` 回到当前队首。
- 同一时间最多一个追加操作。入口回调和按钮事件处理都要有同步短路，不能只依赖 React 下一次 render 后的 `disabled` 属性。
- 追加期间，当前项以及其他项的编辑、删除、重排和追加操作按现有组件边界禁用；自动 flush 看到 `appendingQueuedMessageId` 时必须暂停，追加结束后由状态变化重新触发既有 flush。
- `useSessionFeedback.steer(text, blocks)` 保持现有调用语义和返回 `FeedbackItem`；成功包括实时反馈通道已经确认的结果。反馈通道内部若已将内容降级入队，编排层只能把它视为成功，不能再调用 `requeueFront`，避免双入队。
- 失败提示复用现有 `Folder.chat.messageInput.steerFailed` 或 `steerNoteFailed`，不新增第二套失败文案；所有新增按钮文案、`title` 和 `aria-label` 使用国际化 key。
- 现有 flush、`TurnBusyError` 回队、反馈 native/pull 通道和持久化结构保持原有语义；不做批量追加、追加位置选择或追加状态持久化。
- 新增或调整的代码注释使用中文，说明“移除 → 反馈提交 → 成功消失/失败回队首”的顺序；不记录消息正文到日志。

## Task 1: UI 追加按钮与回调接线

**文件：**

- 修改：`src/components/message/message-list-view.tsx`
- 修改：`src/components/chat/message-queue-display.tsx`
- 修改：`src/components/conversations/conversation-detail-panel.tsx`
- 测试：`src/components/message/message-list-view.test.tsx`、`src/components/chat/message-queue-display.test.tsx`

**接口：**

- `MessageListViewProps` 增加 `onAppendQueuedMessage?: (queuedId: string) => void` 和 `appendingQueuedMessageId?: string | null`，宿主用 `undefined` 隐藏追加入口。
- 等待消息气泡的 hover 操作区调用 `onAppendQueuedMessage(item.id)`；追加按钮使用 `Folder.chat.messageList.appendAsFeedback` 作为 tooltip 和 aria-label，并在当前项或全局追加状态存在时禁用。
- `MessageQueueDisplay` 接收同一追加中 id 或等价的只读禁用状态，只在等待项存在且没有冲突编辑时应用禁用；如果当前渲染路径仍需透传回调，透传 `queuedId`，不在第二个位置复制按钮。
- `ConversationDetailPanel` 将编排函数传给 `MessageListView`，并把追加中的 id 传给相关队列展示组件；不把队列项内容复制到 UI 层。

**实现步骤：**

1. 在消息列表现有用户消息操作区加入追加按钮，沿用 `MessageAction`、hover 显示、尺寸和无障碍属性；按钮只携带队列 id，不直接调用 hook 或反馈 API。
2. 在队列展示组件中让追加中的全局状态覆盖编辑、删除、重排和其他追加按钮的可用性；保留现有拖拽和队列展示布局，不新增第二个业务入口。
3. 在详情面板的 `MessageListView` 和队列展示装配处接线，确保无实时反馈能力、非运行中回合或只读 viewer 不传递追加回调，避免显示点击后必然失败的按钮。
4. 增加组件测试：追加按钮传出正确 id；无回调时不显示；追加进行时所有相关操作处于禁用状态；快速连续点击只触发一次回调；不同语言 provider 下按钮通过 key 取文案。

**验证命令：**

```bash
pnpm test -- src/components/message/message-list-view.test.tsx src/components/chat/message-queue-display.test.tsx
```

**预期结果：** 两个组件测试文件全部通过；测试能证明按钮的显示门控、正确 id 传递、全局禁用和同步防重复行为，不触发真实反馈提交。

## Task 2: 队列状态和失败回队首

**文件：**

- 修改：`src/components/conversations/conversation-detail-panel.tsx`
- 核对并按需要补充：`src/hooks/use-message-queue.ts`
- 测试：`src/hooks/use-message-queue.test.ts`、`src/components/conversations/conversation-detail-panel-layout.test.ts`

**接口：**

- 复用 `UseMessageQueueReturn.getItem(id)`、返回实际项的 `remove(id)` 和 `requeueFront(draft, modeId, opts?)`；后者的 `opts` 是可选向后兼容扩展，不新增独立队列模块。
- 新增面板内部编排函数 `handleAppendQueuedAsFeedback(id: string): Promise<void>`，只接收队列 id。
- `appendingQueuedMessageId: string | null` 只由详情面板维护，按钮和队列显示组件读取它；`use-message-queue.ts` 继续作为队列状态唯一来源。

**实现步骤：**

1. 编排函数入口先检查 `appendingQueuedMessageId !== null`，再用 `getItem(id)` 从权威 queueRef 查找 id；找不到或 payload 为空时直接返回，不修改队列。
2. 在第一次异步等待前调用 `mqRemove(id)`；只接受它返回的权威队列项。返回 `undefined` 表示 flush 已先移除该 id，立即结束且不得调用 steer；成功移除后再设置 `appendingQueuedMessageId(id)`，这样 flush、编辑和删除不会再看到或操作正在搬运的项。
3. 成功路径只清理追加状态，让实时反馈乐观条目负责显示；失败路径将保存的原始 draft 和 mode 信息交给 `mqRequeueFront`，使消息回到当前队首，最后在 `finally` 清理追加状态。
4. 核对 `use-message-queue.ts` 的恢复行为，确保回队首不会丢失 `adoptSendTimeMode` 的发送时机语义；`requeueFront` 的可选 `opts` 扩展必须保持未传参数的旧调用行为，为该字段增加覆盖测试，不改变其他 enqueue/dequeue/reorder 行为。
5. 将自动 flush effect 的追加中门控写入现有依赖，使追加完成或失败后能重新进入既有 flush，不改变正常队列 FIFO 和 `TurnBusyError` 回退逻辑。

**验证命令：**

```bash
pnpm test -- src/hooks/use-message-queue.test.ts src/components/conversations/conversation-detail-panel-layout.test.ts
```

**预期结果：** 队列 hook 测试确认移除、回队首、FIFO 和发送时机字段保持；详情面板布局测试确认编排顺序为“按 id 取项 → remove → 设置追加状态 → steer → 成功清理或失败 requeueFront → finally 清理”，并确认追加状态会阻塞自动 flush。

## Task 3: 复用实时反馈并防重复/双入队

**文件：**

- 修改：`src/components/conversations/conversation-detail-panel.tsx`
- 核对：`src/hooks/use-session-feedback.ts`
- 复用并核对：`src/lib/queued-steer.ts`
- 测试：`src/hooks/use-session-feedback.test.ts`、`src/components/conversations/conversation-detail-panel-layout.test.ts`、`src/components/chat/message-queue-display.test.tsx`

**接口：**

- 使用 `useSessionFeedback` 返回的 `steer(text: string, blocks?: PromptInputBlock[]): Promise<FeedbackItem>`，文本和 blocks 从保存的 `QueuedMessage.draft` 生成。
- 成功判据是 `steer` 返回 `FeedbackItem`；`FeedbackItem` 已表示 native 推送或 pull 反馈通道接受了内容，不能再手动入队。
- 面板保留现有 `notify` 错误提示和 `toErrorMessage` 转换；失败处理必须将原始消息回队首后再结束追加状态。

**实现步骤：**

1. 复用现有 draft 到 steering payload 的转换，文本内容与附件 blocks 一起传给 `feedback.steer`；不直接调用 `submitSessionFeedback`，不复制 `use-session-feedback` 内部通道选择、乐观条目或降级逻辑。
2. 用面板状态和同步 ref 双重防重：第一个点击立即占用追加槽位，后续同 tick 点击、其他队列项点击和重新渲染后的点击都直接返回。
3. 对 steer 返回的 `FeedbackItem` 走成功路径；对通道已经内部降级为队列并返回成功的结果不调用 `requeueFront`。只有 steer 抛出彻底失败且没有内部成功入队的结果时才回队首，确保一条消息不会同时存在于反馈条目和队列中。
4. 保持 `use-session-feedback.ts` 的导出签名和 `steer` 失败抛出语义；只补充测试所需的边界覆盖，不把队列策略移入反馈 hook。
5. 增加测试：steer 调用一次并收到完整 text/blocks；steer reject 后回队首且保留原 draft/mode；反馈通道降级入队成功后不再手动回队；追加期间第二次点击不产生第二次 steer；成功后反馈乐观条目出现而队列项消失。

**验证命令：**

```bash
pnpm test -- src/hooks/use-session-feedback.test.ts src/components/conversations/conversation-detail-panel-layout.test.ts src/components/chat/message-queue-display.test.tsx
```

**预期结果：** 实时反馈 hook 的 steer 成功、附件参数和失败抛出测试通过；面板编排测试通过成功、彻底失败、降级成功和快速重复点击场景；不会出现同一 draft 同时被 `steer` 和 `requeueFront` 处理的双入队结果。

## Task 4: 10 语言文案

**文件：**

- 修改：`src/i18n/messages/en.json`
- 修改：`src/i18n/messages/zh-CN.json`
- 修改：`src/i18n/messages/zh-TW.json`
- 修改：`src/i18n/messages/ja.json`
- 修改：`src/i18n/messages/ko.json`
- 修改：`src/i18n/messages/es.json`
- 修改：`src/i18n/messages/de.json`
- 修改：`src/i18n/messages/fr.json`
- 修改：`src/i18n/messages/pt.json`
- 修改：`src/i18n/messages/ar.json`

**接口：**

- 在十个语言文件的 `Folder.chat.messageList` 下增加同名 key `appendAsFeedback`，供追加按钮的可见 tooltip 和 `aria-label` 使用。
- 失败提示继续使用现有 `Folder.chat.messageInput.steerFailed` 或 `Folder.chat.messageInput.steerNoteFailed`，不新增重复 key。

**实现步骤：**

1. 为十种语言分别填写“追加为实时反馈”的自然译文，语义说明当前消息会进入正在运行回合的反馈通道，不把它写成普通队列发送。
2. 检查 RTL 的阿拉伯语文案只改变文本，不改变现有操作区布局、图标方向或按钮顺序。
3. 运行脚本逐一读取 JSON，确认十个文件都存在 `Folder.chat.messageList.appendAsFeedback` 且值为非空字符串；同时确认 JSON 可解析、key 名完全一致。

**验证命令：**

```bash
node - <<'NODE'
const fs = require("fs")
const locales = ["en", "zh-CN", "zh-TW", "ja", "ko", "es", "de", "fr", "pt", "ar"]
for (const locale of locales) {
  const file = `src/i18n/messages/${locale}.json`
  const messages = JSON.parse(fs.readFileSync(file, "utf8"))
  const value = messages?.Folder?.chat?.messageList?.appendAsFeedback
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${file} 缺少 Folder.chat.messageList.appendAsFeedback`)
  }
}
console.log(`通过：${locales.length} 个语言文件均含追加文案`)
NODE
```

**预期结果：** 脚本退出码为 0，并输出十个语言文件均含新增 key；任一文件缺 key、JSON 格式错误或值为空都会以非零退出码失败。

## Task 5: 前端测试和 lint

**文件：**

- 验证：前述全部修改文件及其测试文件
- 提交前只允许包含：`docs/superpowers/plans/2026-10-14-append-queued-message-as-feedback.md`

**接口：**

- 前端测试使用仓库已有的 `pnpm test`/Vitest 配置。
- 静态检查使用仓库已有的 `pnpm lint .`，不引入新的 lint 规则或格式化工具。

**实现步骤：**

1. 先运行追加功能相关测试，确认组件、队列、反馈和详情面板编排都通过。
2. 运行完整前端测试，覆盖十语言消息加载、现有队列 flush、反馈通道和消息列表回归。
3. 运行 lint 和差异空白检查；检查最终状态，确认本次用户要求的文档提交不包含代码、测试或翻译文件。
4. 创建唯一提交：

```bash
git add docs/superpowers/plans/2026-10-14-append-queued-message-as-feedback.md
git commit -m "docs: add queued feedback implementation plan"
```

**验证命令：**

```bash
pnpm test
pnpm lint .
git diff --check
git status --short --branch
git show --stat --oneline --decorate HEAD
git show --name-only --format= HEAD
```

**预期结果：** `pnpm test` 和 `pnpm lint .` 均以退出码 0 完成；`git diff --check` 无输出；最终提交信息为 `docs: add queued feedback implementation plan`，提交文件清单只有 `docs/superpowers/plans/2026-10-14-append-queued-message-as-feedback.md`。
