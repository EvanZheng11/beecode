# 宿主中断提问：修复与发布验收记录

## 已确认的用户选择

- 宿主放弃工具调用后保留选择卡片。
- 用户点选后将答案作为普通用户消息发给原智能体连接。
- MCP 与原生问答均覆盖。秘密输入不转入聊天历史。

## 隔离

- 基线：`03bfe55e10ef12d79f972aaefba51183a78368ec`
- 分支：`worktrees/wt_question_hostcut_20261108_0142`
- worktree：`/home/andy/git/beecode/worktrees/wt_question_hostcut_20261108_0142`
- 目标：main；未合回，未修改安装中的 BeeCode。

## 当前实现

- 区分宿主放弃与用户 Stop/断连；保留原题号，移除失效倒计时。
- 已保留的问题不按关闭的 oneshot receiver 当作孤儿回收。
- 用户作答通过注册表、状态与命令队列的原子接纳完成：成功入队才移除卡片；忙碌/通道失败返回可重试错误，不做后台盲重试。
- 补送命令携带 `user_message`，连接循环负责可见消息与原智能体历史。
- 短期作答回执覆盖用户提交与宿主撤回竞争，MCP 写失败及原生 responder 返回失败可恢复。
- 原生回合结束先转换仍未回答的问题，再 drain 权限等待器；秘密输入仍撤回，不进入补送。

## 已运行验证

Docker 工具链：`codeg-acp-2206631-release-verify:ubuntu2204-rust-stable`，网络使用 host。
构建时 `out/index.html` 为仅供 Tauri check 的占位文件，sidecar 为构建脚本生成的占位文件；这些不是可发布制品。

- 桌面测试目标编译：通过（`cargo check --tests --features test-utils`）。
- server/MCP：通过（`cargo check --no-default-features --features server-bin,mcp-bin --lib --bin codeg-server --bin codeg-mcp`）。
- 最新库测试：非 root 身份，4 个测试线程；6691 通过、5 忽略、2 个已复现基线失败被排除。
- 两项库测试在原始基线同样失败：
  - `stopping_a_grok_follow_up_turn_ends_it_once_and_ignores_the_stragglers`：清理次数 `(2,1)` 对预期 `(1,1)`。
  - `an_event_socket_gets_past_an_address_that_never_answers`：`HandshakeIncomplete`。
- UDS 集成测试在此前候选上 5/6 通过；`end_to_end_uds_ask_revoked_after_register_declines` 失败也在原始基线复现（旧测试把 unavailable 当作 declined）。原生最后一轮边界调整后未重新运行该集成套件。
- strict Clippy 不通过，发现五处未修改文件的 lint：commands/acp.rs、computer/marker.rs、models/message.rs、workspace_state/mod.rs、acp/delegation/event_emitter.rs。本次修改文件未报告 lint；未声称 Clippy 全通过。
- `git diff --check`：通过。
- Codegraph sync 实际解析到原工程索引，而非任务 worktree；任务分支索引未建立，不能声称已更新任务索引。

## F1 收口（候选 d692386 之后）

- 正常作答的 `QuestionResolved` 在注册表临界区内发布，避免晚于撤回恢复事件清掉同题卡片。
- 前端不再在 API 成功返回后另行按题号清卡；卡片即使在返回前恢复同一题号，也能解除提交锁并重试。
- idle 扫描不再删除未确认传输的 submitted 回执。新题取代已提交的旧题、显式 Stop、断连仍终止旧回执，迟到回执不得影响新题。
- mark 的状态门禁成功后才取走 submitted；失败时保留回执。通道满/关闭也先同步恢复卡片与无期限状态，返回错误供用户重试。
- Stop API 在命令入队前撤题，关闭“Cancel 尚未被 loop 消费，旧答案排在其后”的窗口。迟到 waiter 的取消、超时停止和重提不再收走已转为补送的题。
- 原生秘密题在撤回时连同并发作答回执一起清理，绝不补送；本地权限 drain 遇到已提交但尚未响应的非秘密答案时恢复卡片，不静默吞答。
- 补送携带稳定 message_id 与 UserMessage，发出 UserPromptSent。lifecycle 对补送 UserMessage 按连接事件顺序更新已有会话为 InProgress，并广播侧栏状态，不新建会话行；同队列处理补送轮的取消，避免迟到的开始状态覆盖 Stop。

### 协议与生命周期边界

- `confirm_question_answer` 仅表示 MCP `write_frame` 成功，或原生 responder 接纳响应；原生 responder 甚至不保证底层 socket 已写出。两者都没有“宿主已消费答案”的应用层 ACK。
- 本地补送入队以注册表锁去重；不宣称宿主端到端 exactly-once。传输已经接纳但宿主随后丢弃答案的窗口不能自动判定，不靠超时猜测再投递授权答案。
- submitted 回执保留到传输确认、明确失败恢复或用户终止/新题替换；idle 不承担传输超时推断。失败恢复时若原连接忙、队列满或关闭，保留卡片供手动重试，不后台循环发送。
- 新题替换已提交旧回执是代际终止：即使旧写出随后失败，也不得复活旧授权或清掉新题。尚未作答或已转为补送的旧题仍占据单题槽位，不能被新题覆盖。
- 已入队 Prompt 与普通用户消息一样受连接进程/应用生命周期约束；没有新增持久化重放队列。

### F1 验证记录（持续更新）

- 前端：`pnpm test src/components/chat/ask-question-card.test.tsx src/contexts/acp-connections-context.test.tsx --maxWorkers=2`，288/288 通过。
- 同四个前端文件的 `pnpm exec eslint ...`：通过。
- `tsc --noEmit --incremental false`：不通过，仅报告未修改的 `src/hooks/use-connection-lifecycle.locale.test.tsx:63` 的 locale 类型不匹配（TS2322）；本次没有扩大范围修改。
- Rust 宿主撤回定向回归：21/21 通过，包含真实 UnixStream + broker `serve_one` + 真实 registry，以及真实 ACP conversation loop 的原生无 cancel 回合结束/可见补送。
- 全量库回归：非 root、4 线程，6702 通过、5 忽略，排除工单中已确认的 2 项基线失败。首轮另外有 1 项环境失败：`nobody` 的 home 不存在；仅在验证容器创建可读写 home 后，该项单测和全量复跑均通过。
- 桌面：`cargo check --tests --features test-utils` 通过。server/MCP：`cargo check --no-default-features --features server-bin,mcp-bin --lib --bin codeg-server --bin codeg-mcp` 通过。
- UDS 集成：5 通过、0 失败，排除工单中已确认的 `end_to_end_uds_ask_revoked_after_register_declines` 基线旧断言失败。
- `git diff --check`：通过。F1 实现与自动验证执行完成，等待主会话真实宿主验收和最终独立审核；未合并、推送或发布。
- 本轮 strict Clippy 尝试未能运行：验证镜像未安装 cargo-clippy（exit 1），没有为此安装全局组件；先前候选的 5 项既有 lint 记录仍保留，不能当作本轮 Clippy 通过。
- 定向编译使用任务 worktree 的 `src-tauri/target`、`CARGO_INCREMENTAL=0`，没有操作其他任务的 target 或容器。

### 可复核的运行命令

在本任务 worktree 挂载到 `/w` 的验证容器内，工作目录 `/w/src-tauri`，`CARGO_INCREMENTAL=0`：

```bash
cargo test --features test-utils,server-bin,mcp-bin,cli-bin,computer-helper,browser-child --lib host_abandoned -- --test-threads=4
# 上一条生成的二进制；容器 nobody 的 home 必须存在且可读写。
runuser -u nobody -- target/debug/deps/codeg_lib-28bb250fe7cd8632 --test-threads=4 --skip stopping_a_grok_follow_up_turn_ends_it_once_and_ignores_the_stragglers --skip an_event_socket_gets_past_an_address_that_never_answers
cargo check --tests --features test-utils
cargo check --no-default-features --features server-bin,mcp-bin --lib --bin codeg-server --bin codeg-mcp
cargo test --features test-utils,server-bin,mcp-bin,cli-bin,computer-helper,browser-child --test delegation_e2e_uds -- --skip end_to_end_uds_ask_revoked_after_register_declines --test-threads=4
```

日志在本 worktree `src-tauri/target/f1-{focused,lib-final,desktop-check,server-check,uds}.log`，每个文件末尾记录退出码。前端日志在 `/tmp/f1-frontend-tests.log`、`/tmp/f1-frontend-lint.log`，类型检查在 `/tmp/f1-tsc-final.log`。

## 审核与剩余验收

早期独立审核 H2（会话1672）及复审（会话1674）均判为需要返工；之后升级至难点助手收口，形成 `07e30c63e`。集成发布候选 `878383ffa` 的最终独立审核（会话1679）通过，未发现已证实的阻断问题。

主会话已补真实 DeepSeek 宿主交互验收：候选 server/MCP 二进制、最终静态前端、真实 `deepseek-acp 0.9.0`，模型替换为本地确定性服务，全部使用隔离目录、数据库和测试凭据。2026-11-08 05:03:24 发起工具调用，05:04:24 宿主真实返回 `MCP error -32001: Request timed out`；卡片仍保留且无倒计时。05:05:12 通过页面点选提交后，出现包含选择的用户消息，原智能体回复 `ANSWER_RECEIVED`。测试端点只收到一条补送答案，快照 `pending_question=None`、连接 connected。

全量前端回归发现共享卡片成功解锁影响旧恢复表单；已通过显式 `lockAfterSubmit` 区分：普通实时卡允许同题恢复重试，恢复表单成功后保持锁定直到卸载。相关298项通过，最终前端全量804文件/11910测试全部通过（Node22，maxWorkers=4，testTimeout=15000）。修改文件ESLint通过，最终静态构建通过。发布签名/版本/manifest脚本53项通过，版本统一为0.42.4。

尚需确认：

1. 最终固定提交的独立审核验收，尤其正常回执释放、原生 responder 的接纳与真正上游消费之间仍存在的协议边界。
2. 在真实 BeeCode UI/实际宿主中观察卡片保留、点选、原智能体收取新消息及侧栏状态的完整交互。F1 已覆盖真实 Unix socket、真实注册表、ACP conversation loop、数据库状态与前端事件回归；这些不能冒充真实宿主界面验收。
3. 用户报告的3–4分钟现场仍没有对应会话时间线；此前DeepSeek约65秒超时实测不能替代该现场归因。
4. 最终二进制未打包安装，运行中的应用不会因本分支存在而生效。

忙碌时用户需稍后重试卡片提交；没有引入自动后台队列。显式 Stop/断连撤题后不会再补送旧答案。
