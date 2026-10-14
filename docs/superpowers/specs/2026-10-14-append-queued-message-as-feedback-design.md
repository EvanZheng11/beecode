# 设计文档：等待中用户消息气泡的"追加为实时反馈"能力

日期：2026-10-14
分支：`worktrees/wt_append_feedback`
状态：已实现，最终审查修复中

## 1. 背景与目标

### 背景

Codeg 中用户在代理忙（turn 进行中）时发送的消息会进入等待队列
（`src/hooks/use-message-queue.ts` 的 `useMessageQueue`），由
`conversation-detail-panel.tsx` 的自动 flush 效应在回合结束等可插入时机逐条发送。
与此同时，系统已有另一条"实时反馈（steering）"通道
（`src/hooks/use-session-feedback.ts`），可把一句话注入**当前正在进行**的回合。

现状问题：排在队列中的消息只能等当前回合结束、逐条 flush 时才被代理看到；
用户如果想把某条**还在等待**的消息提前塞进当前回合，只能删掉重发，或等 flush。

### 目标

给**等待中的用户消息气泡**增加一个"追加"操作按钮：

- 点击后，该消息**从等待队列移除**，并转成一次**现有实时反馈提交**（steer）；
- 提交会等待最近的可插入时机（复用现有 feedback 通道的时序语义）；
- 提交**失败则把原消息放回队首**（`requeueFront`），保证不丢内容；
- 提交进行中**防重复点击**。

非目标见第 8 节范围边界。

## 2. 状态转换

单条排队消息在本次功能中新增一条状态边（其余状态不变）：

```
等待中(queued) ──点击"追加"──▶ 反馈提交中(appending) ──成功──▶ 已消失(从队列移除，转 feedback 条目)
                                      │
                                      └──失败──▶ 回到队首(queued, requeueFront)
```

约束：

- **appending 是 UI 层瞬态**，不写入 `QueuedMessage` 持久结构；用组件级状态
  （如 `appendingId: string | null`）记录，与 `useSessionFeedback.submitting`
  语义对齐。
- appending 期间：
  - 该气泡的"追加"按钮禁用（防重复点击）；
  - 该气泡的编辑/删除/插入操作禁用（内容正在被搬运，避免竞态）；
  - 全局同一时刻最多一条 appending（按钮互斥），简化错误恢复推理。
- 成功后该条从队列消失，呈现为一条已提交的实时反馈条目
  （feedback 通道现有的乐观 UI 已覆盖）。
- 失败后通过 `requeueFront` 回到队首：队首语义保证它比
  "已经排在它后面的消息"更早被 flush（FIFO 不被破坏），与现有
  TurnBusyError 弹回路径一致。

## 3. 调用链（新路径，全部复用现有模块）

```
MessageQueueDisplay (src/components/chat/message-queue-display.tsx)
  └─ 等待队列行操作区："追加"按钮
       └─ onSteerItem(queuedId)                 [经 ChatInput / ConversationShell 透传]
            └─ conversation-detail-panel.tsx     [新编排函数，如 handleAppendQueuedAsFeedback]
                 1. `getItem(id)` 同步读取权威 queueRef 中的当前项，检查 payload；不存在或空白时结束
                 2. 调用权威队列的 `remove(id)`，以其原子返回值取得仍由本次操作拥有的完整项；
                    返回空时说明 flush 已移除或 id 不存在，立即结束，不调用 steer
                 3. `setAppendingId(id)` → 记录防重复状态
                 4. `await feedback.steer(draft.text, draft.blocks)`
                    （use-session-feedback.ts 的 steer，等待最近可插入时机，
                      内部已处理 native/downgrade 通道与 submitting 状态）
                 5a. 成功 → `setAppendingId(null)`，结束
                 5b. 失败 → `messageQueue.requeueFront(item.draft, item.modeId, {
                            adoptSendTimeMode: item.adoptSendTimeMode,
                          })`
                            （保留原始发送时机语义）
                            `setAppendingId(null)`
```

涉及文件的职责边界（**不新增模块**）：

| 文件 | 改动 |
| --- | --- |
| `src/hooks/use-message-queue.ts` | `getItem` 同步读取权威项；`remove` 原子移除并返回实际项；`requeueFront` 保留可选发送时机参数 |
| `src/hooks/use-session-feedback.ts` | 无改动（`steer` 已存在） |
| `src/components/chat/message-queue-display.tsx` | 在真实等待队列行提供唯一追加入口，按 payload 和通道门控并禁用冲突操作 |
| `src/components/message/message-list-view.tsx` | 无新增追加入口，历史消息没有真实 queuedId |
| `src/components/conversations/conversation-detail-panel.tsx` | 新增编排函数 `handleAppendQueuedAsFeedback`，负责状态转换与错误恢复 |

最终入口按 progress ledger 裁决放在 `MessageQueueDisplay` 的真实等待队列行：
历史消息气泡没有 queuedId，不能作为等待项的追加入口；只提供一个入口。

## 4. 错误恢复

| 场景 | 处理 |
| --- | --- |
| steer 提交异常（网络/通道降级后仍失败/会话关闭） | `requeueFront(item.draft, item.modeId, { adoptSendTimeMode: item.adoptSendTimeMode })` 回队首，气泡重新出现为等待中；追加失败用现有错误提示路径告知用户 |
| steer 内部走"降级为 enqueue"的 fallback | 现有 `steer` 的 fallback 策略会自行入队 —— 此时**不得**再手动 `requeueFront`，否则同一内容入队两次。编排函数需依据 steer 的返回值/结果区分"已成功送达（含降级）"与"彻底失败"，仅对后者回队。实现时以 `steer` 返回的 `FeedbackItem` 为成功判据 |
| appending 期间用户删除该气泡/队列被清空 | remove 已先执行，气泡已不在 UI 中，成功路径无 UI 残留；失败路径 `requeueFront` 使其重现，符合预期 |
| appending 期间 flush 效应触发 | 该条已 `remove`，其他排队项也暂停自动 flush；effect 与定时器分别检查 state 和同步 ref，追加结束后恢复 flush |
| flush 先移除该 id，React 仍保留旧快照 | `getItem` 或 `remove` 返回空，立即结束，不调用 steer、不回队 |
| 重复点击 | `appendingId !== null` 时按钮 disabled；编排函数入口同样短路 |

关键竞态点（实现时必须核对）：remove（乐观）与 requeueFront（回滚）之间，
`moveToFront` / `reorder` / 编辑等用户操作可能已改变队列 —— `requeueFront`
按语义插到**当前队首**，不做位置记忆，这是有意为之（与 TurnBusyError 弹回一致）。

### `requeueFront` 的兼容扩展

`requeueFront` 增加可选的 `opts.adoptSendTimeMode`，仅用于完整恢复原排队项时保留
其发送时机语义。未传第三个参数的既有调用行为不变；因此这是向后兼容的可选扩展，
不是对原有调用者的强制签名变更。追加失败必须透传原项的该字段，避免回队后丢失
发送时机。`getItem(id)` 和 `remove(id)` 的返回值扩展用于确认权威队列所有权；
既有删除调用者可继续忽略返回值。

## 5. 国际化

- 按钮文案与 aria-label/tooltip 新增 message key，例如
  `messageList.appendAsFeedback`（"追加"），放入
  `src/i18n/messages/` 下全部 10 个语言文件
  （en / zh-CN / zh-TW / ja / ko / es / de / fr / pt / ar）。
- 失败提示复用现有 feedback 失败文案，不新增 key；若实现中发现无现成 key，
  再补 `feedback.appendFailed` 一组（同样 10 语言）。
- 阿拉伯语等 RTL 布局由现有 hover 操作区样式承载，无额外处理。

## 6. 测试计划

单元/组件测试（vitest，`pnpm test`）：

1. **状态转换**：点击追加 → 队列中该条被 `remove`、`steer` 被调用一次；
   成功后 `appendingId` 复位。
2. **错误恢复**：`steer` reject → `requeueFront` 收到**原始** draft/modeId
   （含 `adoptSendTimeMode`），队列头为该条；`appendingId` 复位。
3. **降级兜底**：`steer` 内部降级入队成功 → 不得再调用 `requeueFront`
   （防双入队，对应第 4 节关键场景）。
4. **防重复点击**：appending 期间再次点击不产生第二次 `steer`。
5. **按钮禁用态**：appending 期间编辑/删除/插入按钮禁用。
6. **i18n**：10 个语言文件均含新 key，无缺漏（现有 i18n 一致性测试若存在则挂靠）。

7. **交错时序**：同 tick flush 先取走队首、原子移除失败时不 steer、不回队；
   追加先开始时已排定的 flush 定时器也暂停；同 tick draft 更新使用权威新内容。
8. **空白附件**：带附件且 displayText 为空或仅含空白时，payload 返回 null，
   UI 隐藏追加入口，编排保留队列内容。

手工验收：

- 代理忙时排队 2 条消息，对第 2 条点追加：它出现在当前回合的反馈条目中，
  第 1 条仍在队列且仍先于任何回队项被 flush。
- 断网状态下点追加：气泡回到队首，恢复网络后 flush 正常。

## 7. 验证命令

```bash
pnpm lint .
pnpm test
```

## 8. 范围边界（明确不做）

- 不改 `use-session-feedback.ts` 的导出签名；`use-message-queue.ts` 的
  `requeueFront` 仅增加可选 `opts.adoptSendTimeMode` 扩展，旧调用行为不变。
- 不做"批量追加多条"、"追加到队首/队尾选择"、追加顺序编排等扩展。
- 不为 appending 状态引入持久化（刷新后按现有队列恢复语义即可，
  进行中的追加丢失则表现为"该条仍在队列"或"已作为反馈提交"，两者皆可接受）。
- 保持既有 flush、TurnBusyError 弹回和反馈通道降级语义，仅增加追加期间暂停
  flush 的 state/ref 门控。
- 不给"插入/删除"等既有排队项操作增加新行为。
