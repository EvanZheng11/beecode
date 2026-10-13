# 移动端用户消息复制按钮与文本选择修复设计

## 状态

设计已获用户确认，按最小方案实施。

## 背景与目标

Web 移动端（无 hover 能力的触摸设备）的用户消息存在两个问题：

- 复制按钮不可见：按钮只通过 `opacity-0 group-hover/user-msg:opacity-100` 显示，触摸设备不触发 hover，用户消息旁的“复制”和“创建任务”按钮始终透明，无法点击。
- 长按无法选择文本：透明按钮仍然参与命中测试，触摸落在按钮上时不会进入文本选择，表现为上层有看不见的元素遮挡。

目标：移动端默认显示用户消息操作按钮；隐藏状态的按钮不参与命中测试；桌面端保持 hover/键盘聚焦显示，按钮布局与点击行为不变。

## 根因

`src/components/message/message-list-view.tsx` 中 `UserMessageCopyButton` 与 `UserMessageTaskButton` 的 `MessageAction`：

- `opacity-0` 只改变透明度，元素仍留在布局与命中测试中；
- 显示条件只有 `group-hover/user-msg`，触摸设备没有 hover；
- 没有键盘聚焦的显示条件，键盘聚焦到透明按钮时同样不可见（顺带修复，代价为零）。

## 方案（最小）

两个按钮共用同一个可见性 className 常量，作为唯一事实来源：

1. 默认隐藏：`opacity-0 pointer-events-none`；
2. 桌面端 hover 或自身键盘聚焦时显示并恢复命中：`group-hover/user-msg:opacity-100 group-hover/user-msg:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto`；
3. 无 hover 能力的设备始终显示并可点击：`[@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto`，沿用仓库中 `src/components/layout/row-more-button.tsx` 已有的媒体查询写法，不新增 JS 端移动端检测。

按钮的顺序、`self-end`、`gap`、图标与点击逻辑均保持不变。

## 不做的事

- 不调整按钮位置、布局、图标和交互逻辑；
- 不改用户消息文本渲染、选区工具栏与图片操作按钮；
- 不引入 `useIsCoarsePointer` 等 JS 移动端检测或额外状态。

## 测试策略

在 `src/components/message/message-list-view.test.tsx` 增加对共用 className 的最小断言：

- 隐藏状态包含 `pointer-events-none`，透明按钮不再拦截文本选择；
- hover/键盘聚焦显示时恢复 `pointer-events-auto`，按钮仍可点击；
- `[@media(hover:none)]` 下默认可见且可点击。

手工验证（无法自动化）：移动端 Web 打开会话，用户消息旁出现复制/创建任务按钮；长按文本可正常选择。

## 风险

- `hover: none` 按设备主指针能力判定：带鼠标的触摸笔记本仍走桌面 hover 显示，属于既有媒体查询取舍。
- 纯 CSS 方案依赖 Tailwind 任意媒体查询变体的排序，测试只锁定类名不变式，视觉结果需真机抽查一次。
