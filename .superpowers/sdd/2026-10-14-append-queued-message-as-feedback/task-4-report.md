# Task 4 报告：10 语言追加为实时反馈文案

## 结论

DONE。十个语言文件均在 `Folder.chat.messageList` 下新增 `appendAsFeedback`，只插入一行本地化字符串，未改动其他文案与格式。

## 变更文件

- `src/i18n/messages/en.json` — `"Append as live feedback"`
- `src/i18n/messages/zh-CN.json` — `"追加为实时反馈"`
- `src/i18n/messages/zh-TW.json` — `"追加為即時回饋"`
- `src/i18n/messages/ja.json` — `"ライブフィードバックとして追加"`
- `src/i18n/messages/ko.json` — `"라이브 피드백으로 추가"`
- `src/i18n/messages/es.json` — `"Añadir como comentarios en vivo"`
- `src/i18n/messages/de.json` — `"Als Live-Feedback anhängen"`
- `src/i18n/messages/fr.json` — `"Ajouter comme retour en direct"`
- `src/i18n/messages/pt.json` — `"Anexar como feedback ao vivo"`
- `src/i18n/messages/ar.json` — `"إضافة كملاحظات مباشرة"`

每处译文沿用各语言既有 `Folder.chat.messageInput.liveFeedback` 术语（如 zh-CN「实时反馈」、zh-TW「即時回饋」、ja「ライブフィードバック」、de「Live-Feedback」、ar「ملاحظات مباشرة」），语义为把等待中的消息经正在运行回合的反馈通道插入，而非普通队列发送。

插入位置统一在各语言文件 `messageList` 的 `forkNotReady` 与 `copied` 之间，10 个文件均为第 3455 行后新增 1 行，`git diff --stat` 为 10 files changed, 10 insertions(+)。阿拉伯语文案仅为 JSON 字符串内容，未触碰任何操作区布局、图标方向或按钮顺序。

失败提示未新增 key，继续使用现有 `Folder.chat.messageInput.steerFailed` / `steerNoteFailed`。

## 验证方式与结果

- 简报 JSON 校验脚本（逐语言 `JSON.parse` + 路径取值 + 非空字符串检查）：退出码 0，输出「通过：10 个语言文件均含追加文案」。
- `grep -c '"appendAsFeedback"' src/i18n/messages/*.json`：十个文件均为 1，key 名完全一致、无重复。
- `pnpm exec prettier --check` 上述十个文件：退出码 0，「All matched files use Prettier code style!」。
- `git diff --check`：退出码 0，无空白/冲突标记问题。
- `pnpm exec vitest run src/i18n/messages.test.ts src/components/chat/message-queue-display.test.tsx src/components/chat/conversation-shell.test.tsx`：9 个测试套件、35 个用例全部通过（含 en.json 为基准的 key parity 与全语言 ICU 可解析检查）。
- `git status --short`：变更仅限上述十个语言文件与本报告。

## 风险与未决事项

- 无阻塞项。译文为自然语言表述，若产品对某语言用词有既定 glossary，可在后续统一替换对应一行字符串。
- 未运行全量 `pnpm lint` / `pnpm test`，属于 Task 4 简报范围外；本次只改动 JSON 数据，已用 prettier、diff check、i18n 与相关组件测试覆盖。

## Commit

- 见任务最终回复。
