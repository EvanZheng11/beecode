# Task 1 报告：追加按钮与回调接线

## 结论

DONE。完成追加为实时反馈的 UI 回调、禁用态和组件测试；没有实现 Task 2/3 的新编排逻辑。

## 修改文件

- `src/components/message/message-list-view.tsx`
  - `MessageListViewProps` 增加 `onAppendQueuedMessage` 与 `appendingQueuedMessageId`。
  - 用户消息操作区增加追加按钮，使用 `Folder.chat.messageList.appendAsFeedback` 取 tooltip 和 `aria-label`。
  - 无回调时隐藏按钮；任意追加操作进行中时禁用按钮；点击只传递 queued id。
- `src/components/chat/message-queue-display.tsx`
  - 增加 `appendingQueuedMessageId` 接口。
  - 追加或现有实时反馈单飞期间统一禁用拖拽、编辑、删除和追加入口，并阻止重排回调。
- `src/components/conversations/conversation-detail-panel.tsx`
  - 将追加中的 queued id 从布尔状态细化为 id。
  - 在实时反馈能力可用、回合运行、当前连接非 viewer 且队列非空时，把既有队列实时反馈编排函数传给 `MessageListView`。
  - 将追加中的 id 传给消息列表用于全局禁用。
- `src/components/message/message-list-view.test.tsx`
  - 覆盖翻译 key、aria-label、queued id 传递和全局禁用。
- `src/components/chat/message-queue-display.test.tsx`
  - 覆盖宿主追加状态下所有队列操作控件禁用。

## 验证

- `pnpm exec vitest run src/components/message/message-list-view.test.tsx src/components/chat/message-queue-display.test.tsx`
  - 13 个测试套件通过，59 个测试通过。
- `pnpm exec vitest run src/components/message/message-list-view.test.tsx src/components/chat/message-queue-display.test.tsx src/components/chat/conversation-shell.test.tsx`
  - 16 个测试套件通过，62 个测试通过。
- `pnpm exec tsc --noEmit`
  - 通过，无错误。
- `pnpm exec eslint src/components/message/message-list-view.tsx src/components/message/message-list-view.test.tsx src/components/chat/message-queue-display.tsx src/components/chat/message-queue-display.test.tsx src/components/conversations/conversation-detail-panel.tsx`
  - 通过，无 lint 错误或警告。
- `git diff --check`
  - 通过。

简报原命令 `pnpm test -- src/components/message/message-list-view.test.tsx src/components/chat/message-queue-display.test.tsx` 在当前 pnpm/Vitest 调用方式下未按文件过滤，运行超过 120 秒并触发了无关的全量测试静态断言；随后使用等价的 `pnpm exec vitest run <files>` 完成了限定验证，并单独验证了相关 `conversation-shell` 断言。

## 风险与后续

- `appendAsFeedback` 的 10 种语言文案属于后续 Task 4，本 Task 按范围没有修改语言文件。
- 本 Task 没有新增实时反馈提交、失败恢复或队列状态编排；按钮回调复用当前已有的实时反馈函数，实际新编排由后续 Task 2/3 完成。

## 提交

- 见最终回复中的 commit 字段。
