# 宿主中断提问：实施检查点（未验收、未合回）

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

## 审核与剩余验收

独立只读审核 H2（会话1672）与唯一返工复审（会话1674）均判为需要返工。
复审指出的原生静默结束/secret receiver 丢失已补代码和回归；这些后续修正尚未得到独立通过结论。因此保留检查点，不合回，不标记可发布。

尚需确认：

1. 最终固定提交的独立审核验收，尤其正常回执释放、原生 responder 的接纳与真正上游消费之间仍存在的协议边界。
2. 新消息的会话侧栏状态/活动通知是否需要与正常 linked send 完全一致。
3. 在真实 BeeCode UI/实际宿主中观察卡片被保留、用户点选、原智能体收取新消息的完整交互。当前主要证据是状态机、真实注册表与内存 socket，不能冒充真实宿主界面验收。
4. 用户报告的3–4分钟现场仍没有对应会话时间线；本次DeepSeek约65秒超时实测不能替代该现场归因。
5. 最终二进制未打包安装，运行中的应用不会因本分支存在而生效。

忙碌时用户需稍后重试卡片提交；没有引入自动后台队列。显式 Stop/断连撤题后不会再补送旧答案。
