# 移动端用户消息复制按钮与文本选择修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** Web 移动端默认显示用户消息的复制/创建任务按钮，隐藏状态的按钮不拦截文本选择。

**架构：** 纯 CSS 方案。两个按钮共用同一个可见性 className 常量：默认 `opacity-0 pointer-events-none`，桌面端 `group-hover/user-msg` 与 `focus-visible` 时显示并恢复命中，`[@media(hover:none)]` 设备默认显示且可点击。不引入 JS 端移动端检测，不改按钮布局与行为。

**技术栈：** React 19 + Tailwind CSS v4 + Vitest。

## 全局约束

- 只修改 `src/components/message/message-list-view.tsx`、`src/components/message/message-list-view.test.tsx` 与本计划/设计文档。
- 保留两个按钮现有顺序、`self-end`、`gap`、图标、点击逻辑。
- 新增注释使用中文；不顺手改现有英文注释。
- 不修改 `tsconfig.json`、`.codegraph` 及无关代码。

---

### 任务 1：先写失败测试

**文件：**

- 修改：`src/components/message/message-list-view.test.tsx`

**接口：**

- 从 `./message-list-view` 导入新增的导出常量 `USER_MESSAGE_ACTION_VISIBILITY_CLASS`。

- [ ] **步骤 1：** 在测试文件导入列表中加入 `USER_MESSAGE_ACTION_VISIBILITY_CLASS`。
- [ ] **步骤 2：** 在文件末尾新增 describe 块，断言：隐藏状态含 `pointer-events-none`；hover/`focus-visible` 显示时含对应 `pointer-events-auto`；`[@media(hover:none)]` 下含 `opacity-100` 与 `pointer-events-auto`。
- [ ] **步骤 3：** 运行 `pnpm vitest run src/components/message/message-list-view.test.tsx`，确认新测试因常量不存在而失败。

### 任务 2：实现共用可见性常量

**文件：**

- 修改：`src/components/message/message-list-view.tsx`

**接口：**

- 新增导出常量 `USER_MESSAGE_ACTION_VISIBILITY_CLASS: string`，`UserMessageCopyButton` 与 `UserMessageTaskButton` 的 `MessageAction` 均引用它。

- [ ] **步骤 1：** 在两个按钮组件上方新增常量与中文注释：默认隐蔽且不命中、桌面 hover/聚焦显示并恢复命中、无 hover 设备始终显示可点击。
- [ ] **步骤 2：** 把两个按钮的 `className` 替换为 `USER_MESSAGE_ACTION_VISIBILITY_CLASS`。
- [ ] **步骤 3：** 运行 `pnpm vitest run src/components/message/message-list-view.test.tsx`，确认测试通过。

### 任务 3：验证与提交

**文件：**

- 验证：`src/components/message/message-list-view.tsx`
- 验证：`src/components/message/message-list-view.test.tsx`

- [ ] **步骤 1：** 运行 `pnpm lint .`，确认无新增告警。
- [ ] **步骤 2：** 运行 `git diff --check` 与 `git status --short`，确认只含本需求文件。
- [ ] **步骤 3：** 提交：

```bash
git add docs/superpowers/specs/2026-10-14-mobile-message-copy-design.md docs/superpowers/plans/2026-10-14-mobile-message-copy.md src/components/message/message-list-view.tsx src/components/message/message-list-view.test.tsx
git commit -m "fix: 移动端显示用户消息操作按钮并放行文本选择"
```
