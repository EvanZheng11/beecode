# 最终审查修复报告

日期：2026-10-14
分支：`worktrees/wt_append_feedback`

## 结论

通过。已完成最终审查要求的竞态、发送时机兼容、附件 payload 门控、注释和旧 key 清理。

提交 commit：`21c3af2 fix: close queued feedback append race`。

## 修复内容

- `use-message-queue.ts` 新增权威 `getItem` 读取；`remove` 从 `queueRef` 原子移除并返回实际项，缺失时返回 `undefined`。
- 追加编排先从权威队列读取当前 draft 并执行 payload 门控，再以 `remove` 返回值确认仍拥有 queued id。flush 先移除时立即结束，不调用 `feedbackSteer`，也不回队。
- 自动 flush 定时器增加同步追加 ref 门控，避免追加刚取得队列项时同 tick flush 抢先发送。
- `buildSteerPayload` 对带附件 draft 的空白 `displayText` 返回 `null`；队列入口与 payload 使用同一门控，避免显示入口后静默失败。
- `requeueFront` 保留可选 `adoptSendTimeMode`，旧调用不传第三参数时行为不变；设计文档和实施计划已同步为向后兼容扩展。
- 相关新增和调整注释统一使用中文；修正队列回队语义注释。
- 删除十种语言文件中已确认无生产引用的 `steerItemNow`、`steerItemAsNote`；保留 `deliverQueuedSteer` 及其测试，因为现有 `queued-steer.test.ts` 仍直接依赖该 helper。当前没有生产代码引用该 helper，未扩大范围删除测试路径。

## 变更文件

- `/Users/andyzheng/git/codeg/worktrees/wt_append_feedback/src/hooks/use-message-queue.ts`
- `/Users/andyzheng/git/codeg/worktrees/wt_append_feedback/src/hooks/use-message-queue.test.ts`
- `/Users/andyzheng/git/codeg/worktrees/wt_append_feedback/src/components/conversations/conversation-detail-panel.tsx`
- `/Users/andyzheng/git/codeg/worktrees/wt_append_feedback/src/components/conversations/conversation-detail-panel-feedback.test.ts`
- `/Users/andyzheng/git/codeg/worktrees/wt_append_feedback/src/components/conversations/conversation-detail-panel-layout.test.ts`
- `/Users/andyzheng/git/codeg/worktrees/wt_append_feedback/src/components/chat/message-queue-display.tsx`
- `/Users/andyzheng/git/codeg/worktrees/wt_append_feedback/src/components/chat/message-queue-display.test.tsx`
- `/Users/andyzheng/git/codeg/worktrees/wt_append_feedback/src/lib/prompt-draft.ts`
- `/Users/andyzheng/git/codeg/worktrees/wt_append_feedback/src/lib/prompt-draft.test.ts`
- `/Users/andyzheng/git/codeg/worktrees/wt_append_feedback/src/i18n/messages/*.json`
- `/Users/andyzheng/git/codeg/worktrees/wt_append_feedback/docs/superpowers/specs/2026-10-14-append-queued-message-as-feedback-design.md`
- `/Users/andyzheng/git/codeg/worktrees/wt_append_feedback/docs/superpowers/plans/2026-10-14-append-queued-message-as-feedback.md`

## 验证

- `pnpm test`：593/593 测试文件通过，8824/8824 测试通过。
- `pnpm lint .`：通过。
- `pnpm exec tsc --noEmit`：通过。
- `git diff --check`：通过，无输出。
- 十种语言 JSON/key 校验：通过；`appendAsFeedback` 全部存在，两个旧 dead key 全部移除。
- 追加相关定向测试：5 个测试文件、77 个测试通过。

全量测试中的既有测试会输出若干预期错误/环境提示到 stderr，但不影响退出码和通过结果。

## 风险与未决事项

- `deliverQueuedSteer` 当前仅由既有测试直接引用，生产代码不再使用；为避免删除超出本次修复范围，保留 helper 与测试。若后续要移除，应单独确认测试替代路径。
- 追加与 flush 的竞态通过同步 `queueRef`、原子 `remove` 返回值和定时器 ref 门控覆盖；未增加持久化状态或新的依赖。

完成时间：2026-10-14 10:24:16
