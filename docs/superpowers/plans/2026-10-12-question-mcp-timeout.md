# 提问 MCP 超时配置实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 使用 `subagent-driven-development`（推荐）或 `executing-plans` 按任务逐项实施。每一步都用复选框跟踪，并在每个任务结束后运行对应检查。

**Goal:** 在“设置 → 常规”增加提问 MCP 的等待时长、重提次数和超时首选项配置，并让 `ask_user_question` 后端按配置等待、重提或选择首个选项。

**Architecture:** 复用现有 `app_metadata`、`QuestionRuntimeConfig` 和 `QUESTION_SETTINGS_CHANGED_EVENT`。后端 listener 在收到 MCP 提问时读取一份运行时快照，负责本轮的计时、重新注册问题和最终 `QuestionOutcome`；前端只负责配置编辑和现有问题卡/文本兜底展示。

**Tech Stack:** Rust 2021、Tokio、SeaORM app metadata、Axum/Tauri 双 transport、Next.js 16、React 19、TypeScript strict、next-intl、Vitest。

## Global Constraints

- UI 文案和新增注释使用中文；十种语言消息文件保持同一消息键结构。
- 等待时长默认 10 分钟，范围 1–1440 分钟。
- 重提次数默认 3 次，表示首次超时后的额外次数，范围 0–10 次。
- 超时自动选择第一个选项默认开启；关闭后不启动超时计时器，也不使用重提次数。
- 不新增数据库表或依赖；配置继续写入 `app_metadata`。
- 一轮提问开始时固定配置快照；设置中途修改只影响下一轮提问。
- 生产代码必须先有会失败的回归测试；测试必须证明用户回答优先于超时。
- 保留宿主 MCP 已彻底取消时的现有纯文本兜底；不承诺修改外部 MCP 客户端内部计时器。

---

### Task 1: 扩展提问配置模型和持久化

**Files:**
- Modify: `src-tauri/src/acp/question.rs:1756-1790` — 扩展 `QuestionConfig` / `QuestionRuntimeConfig`。
- Modify: `src-tauri/src/commands/question.rs:30-92` — 扩展字段、默认值、app_metadata 键、规范化和运行时应用。
- Modify: `src-tauri/src/commands/question.rs:130-171` — 增加默认、非法值、保存读取和运行时快照测试。
- Modify: `src/lib/types.ts:1472-1513` — 添加前端 `QuestionSettings` 类型镜像。
- Modify: `src/lib/api.ts:1918` 附近 — 添加 `getQuestionSettings` / `setQuestionSettings` transport 封装。
- Modify: `src/lib/tauri.ts:390` 附近 — 添加 Tauri transport 封装。
- Review: `src-tauri/src/web/handlers/question.rs`、`src-tauri/src/web/router.rs` — 确认现有接口直接返回扩展后的结构，不新增路由。

**Interfaces:**
- Produces `QuestionConfig { enabled, wait_timeout_minutes, retry_count, auto_select_first_on_timeout }`。
- Produces `QuestionSettings` with the same four serialized fields.
- Produces `QuestionRuntimeConfig::snapshot() -> QuestionConfig` returning a clone that a listener can hold for one MCP ask.
- Preserves existing `is_enabled()` behavior for MCP injection.

- [ ] **Step 1: 写失败测试**

在 `src-tauri/src/commands/question.rs` 的测试模块增加以下断言：

```rust
#[tokio::test]
async fn defaults_include_mcp_timeout_policy() {
    let db = crate::db::test_helpers::fresh_in_memory_db().await;
    let settings = load_question_settings(&db.conn).await;
    assert_eq!(settings.wait_timeout_minutes, 10);
    assert_eq!(settings.retry_count, 3);
    assert!(settings.auto_select_first_on_timeout);
}

#[tokio::test]
async fn set_normalizes_timeout_policy_and_updates_runtime() {
    let db = crate::db::test_helpers::fresh_in_memory_db().await;
    let config = QuestionRuntimeConfig::new();
    let saved = set_question_settings_core(
        &db.conn,
        &config,
        &EventEmitter::Noop,
        QuestionSettings {
            enabled: true,
            wait_timeout_minutes: 0,
            retry_count: 99,
            auto_select_first_on_timeout: false,
        },
    )
    .await
    .unwrap();
    assert_eq!(saved.wait_timeout_minutes, 1);
    assert_eq!(saved.retry_count, 10);
    assert!(!config.snapshot().await.auto_select_first_on_timeout);
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test --features test-utils commands::question::tests`

Expected: FAIL because the new fields and runtime snapshot do not exist.

- [ ] **Step 3: 实现最小配置模型**

在 `QuestionConfig` 和 `QuestionSettings` 中增加字段，并集中定义边界常量及规范化函数：

```rust
pub const DEFAULT_QUESTION_TIMEOUT_MINUTES: u32 = 10;
pub const DEFAULT_QUESTION_RETRY_COUNT: u32 = 3;
pub const MAX_QUESTION_TIMEOUT_MINUTES: u32 = 1440;
pub const MAX_QUESTION_RETRY_COUNT: u32 = 10;

impl QuestionSettings {
    fn normalized(mut self) -> Self {
        self.wait_timeout_minutes = self.wait_timeout_minutes.clamp(1, MAX_QUESTION_TIMEOUT_MINUTES);
        self.retry_count = self.retry_count.min(MAX_QUESTION_RETRY_COUNT);
        self
    }
}
```

分别把三个新字段存到 `question.wait_timeout_minutes`、`question.retry_count`、`question.auto_select_first_on_timeout`，缺失或解析失败时回退默认值。`set_question_settings_core` 先规范化，再写 DB、更新 runtime、广播规范化结果。

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test --features test-utils commands::question::tests`

Expected: PASS，既有 `enabled` 测试和新增默认/规范化测试全部通过。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/acp/question.rs src-tauri/src/commands/question.rs src/lib/types.ts src/lib/api.ts src/lib/tauri.ts src-tauri/src/web/handlers/question.rs src-tauri/src/web/router.rs
git commit -m "feat: 添加提问 MCP 超时配置模型"
```

### Task 2: 实现 MCP 提问等待、重提和首选项策略

**Files:**
- Modify: `src-tauri/src/acp/delegation/listener.rs:140-203, 498-555` — 注入 `QuestionRuntimeConfig`，改造 `BrokerMessage::Ask` 生命周期。
- Modify: `src-tauri/src/acp/delegation/listener.rs:1296-1304` — 复用或新增首选项 `QuestionOutcome` 构造函数。
- Modify: `src-tauri/src/acp/delegation/listener.rs` 测试模块 — 覆盖超时、重提、无限等待和竞争。
- Modify: `src-tauri/src/lib.rs:1158-1205` — 桌面 listener 传入 `question_config.clone()`。
- Modify: `src-tauri/src/bin/codeg_server.rs:416-454` — server listener 传入 `state.question_config.clone()`。
- Modify: `src-tauri/src/acp/delegation/service.rs:485-502` — 测试 listener 构造补齐配置参数。
- Modify: `src-tauri/src/acp/delegation/listener.rs:1946-2085, 3874-3888` — `make_listener`、`make_feedback_listener`、`make_question_listener`、`make_session_listener`、`make_task_listener`、`make_authoring_listener` 和 `make_computer_listener` 的测试构造传入默认 `QuestionRuntimeConfig`。

**Interfaces:**
- `DelegationListener` owns `question_config: QuestionRuntimeConfig`.
- `QuestionConfig` is cloned once when an `Ask` request begins.
- `build_first_option_outcome(&[QuestionSpec]) -> QuestionOutcome` selects `options[0].label` for each question and sets `declined: false`。
- Produces `AskWaitResult::{Answered(QuestionOutcome), TimedOut, PeerClosed}` and `wait_for_question_answer(...)`, which races the answer receiver, the configured timeout, and the socket read for peer close.

- [ ] **Step 1: 写失败测试**

在 listener 测试 stub 中增加一个可控 `QuestionRuntimeConfig`，添加这些场景：

```rust
#[tokio::test]
async fn ask_retries_after_timeout_then_returns_first_options() {
    let config = QuestionRuntimeConfig::new();
    config.set(QuestionConfig {
        enabled: true,
        wait_timeout_minutes: 1,
        retry_count: 1,
        auto_select_first_on_timeout: true,
    }).await;
    tokio::time::pause();
    let (response, registered, canceled) = run_ask_round_trip(config).await;
    assert_eq!(registered, 2);
    assert_eq!(canceled, vec!["q-1", "q-2"]);
    assert_eq!(response.outcome["answers"][0]["selected"][0], "Incremental");
}

#[tokio::test]
async fn ask_user_answer_wins_over_timeout() {
    tokio::time::pause();
    let (listener, questions, mut client) = start_ask_round_trip(default_config()).await;
    questions.answer("q-1", incremental_outcome()).await;
    let response = read_frame::<_, BrokerResponse>(&mut client).await.unwrap();
    assert_eq!(response.outcome["answers"][0]["selected"][0], "Incremental");
    drop(listener);
}

#[tokio::test]
async fn ask_without_auto_select_waits_until_user_answers() {
    tokio::time::pause();
    let (listener, questions, mut client) = start_ask_round_trip(QuestionConfig {
        auto_select_first_on_timeout: false,
        ..default_config()
    }).await;
    tokio::time::advance(Duration::from_secs(60 * 60)).await;
    assert!(tokio::time::timeout(
        Duration::from_millis(20),
        read_frame::<_, BrokerResponse>(&mut client)
    ).await.is_err());
    questions.answer("q-1", incremental_outcome()).await;
    assert!(read_frame::<_, BrokerResponse>(&mut client).await.is_ok());
    drop(listener);
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test --features test-utils acp::delegation::listener::tests::ask_retries_after_timeout_then_returns_first_options`

Expected: FAIL because listener currently performs only one unbounded wait and has no runtime config.

- [ ] **Step 3: 实现最小等待循环**

在 `BrokerMessage::Ask` 分支中使用同一份配置快照，并保证用户答案优先：

```rust
let cfg = self.question_config.snapshot().await;
let attempts = cfg.retry_count.saturating_add(1);
for attempt in 0..attempts {
    let Some(reg) = self
        .questions
        .register_question(&parent_conn_id, req.questions.clone())
        .await
    else {
        write_frame(conn, &ask_declined_response()?).await?;
        return Ok(());
    };
    match wait_for_question_answer(conn, &self.questions, &parent_conn_id, reg, &cfg).await? {
        AskWaitResult::Answered(outcome) => {
            write_frame(conn, &ask_response(&outcome)?).await?;
            return Ok(());
        }
        AskWaitResult::PeerClosed => return Ok(()),
        AskWaitResult::TimedOut if attempt + 1 < attempts => continue,
        AskWaitResult::TimedOut => {
            let outcome = build_first_option_outcome(&req.questions);
            write_frame(conn, &ask_response(&outcome)?).await?;
            return Ok(());
        }
    }
}
```

测试辅助函数应复用当前模块已有的 `ask_msg`、`StubQuestion`、
`make_question_listener`、`duplex`、`write_frame` 和 `read_frame`。新增
`default_config() -> QuestionConfig`、`incremental_outcome() -> QuestionOutcome`、
`start_ask_round_trip(config) -> (Arc<DelegationListener>, Arc<StubQuestion>, DuplexStream)`
和 `run_ask_round_trip(config) -> (BrokerResponse, usize, Vec<String>)`，由它们负责
启动 `serve_one`、写入 `ask_msg("tok")`，并在测试结束时回收 server task；这样三个
测试只验证生命周期结果，不重复构造 socket 和 token。

`auto_select_first_on_timeout=false` 时不调用 `tokio::time::timeout`，直接等待答案；peer-close 仍立即取消当前问题。超时前取消旧 question，重提使用同一组 `QuestionSpec` 但生成新的 question id，确保前端不会同时保留多张卡片。

为避免长时间等待测试和生产日志混淆，重试与首选项动作使用 `tracing::info!` 记录连接标识、attempt 和动作，不记录问题内容或用户答案。

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test --features test-utils acp::delegation::listener::tests`

Expected: PASS，新增生命周期测试和既有 broker/listener 测试全部通过。

- [ ] **Step 5: 运行连接构造检查**

Run: `cargo check` 和 `cargo check --no-default-features --features server-bin --bin codeg-server`

Expected: PASS，桌面和 server listener 都能取得同一个 runtime config。

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/acp/delegation/listener.rs src-tauri/src/acp/delegation/service.rs src-tauri/src/lib.rs src-tauri/src/bin/codeg_server.rs
git commit -m "feat: 支持提问 MCP 超时重试策略"
```

### Task 3: 增加常规设置 UI、transport 和国际化

**Files:**
- Modify: `src/components/settings/general-settings.tsx:1-526` — 加载、编辑、保存三项提问配置。
- Modify: `src/components/settings/general-settings.test.tsx:32-366` — mock API 并覆盖加载、保存、错误恢复和关闭说明。
- Modify: `src/lib/types.ts:1472-1513` — 使用 Task 1 的 `QuestionSettings` 镜像。
- Modify: `src/lib/api.ts`、`src/lib/tauri.ts` — 使用 Task 1 的问答设置方法。
- Modify: `src/i18n/messages/{en,zh-CN,zh-TW,ja,ko,es,de,fr,pt,ar}.json` — 添加 `GeneralSettings.questionMcp*` 消息键。

**Interfaces:**
- `getQuestionSettings(): Promise<QuestionSettings>`。
- `setQuestionSettings(settings: QuestionSettings): Promise<QuestionSettings>`。
- UI 保存 payload 始终包含 `enabled`、`wait_timeout_minutes`、`retry_count`、`auto_select_first_on_timeout` 四个字段。

- [ ] **Step 1: 写失败测试**

在 `general-settings.test.tsx` 的 API mock 中添加问答设置，并增加：

```tsx
it("加载并保存提问 MCP 超时配置", async () => {
  renderSettings()
  const timeout = await screen.findByLabelText("Question MCP wait time")
  expect(timeout).toHaveValue(10)

  fireEvent.change(timeout, { target: { value: "20" } })
  fireEvent.click(screen.getByLabelText("Auto-select the first option after timeout"))

  await waitFor(() =>
    expect(setQuestionSettings).toHaveBeenCalledWith({
      enabled: true,
      wait_timeout_minutes: 20,
      retry_count: 3,
      auto_select_first_on_timeout: false,
    })
  )
})

it("关闭自动选择时显示无限等待说明", async () => {
  renderSettings()
  const toggle = await screen.findByLabelText("Auto-select the first option after timeout")
  fireEvent.click(toggle)
  expect(await screen.findByText(/wait indefinitely/i)).toBeInTheDocument()
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/components/settings/general-settings.test.tsx -t "提问 MCP"`

Expected: FAIL because the General page has no question MCP controls or API mock.

- [ ] **Step 3: 实现最小设置区块**

沿用 `SettingsSection` / `SettingRow` / `Input` / `Switch`，在关闭行为与通知区块附近加入：

```tsx
<SettingsSection
  icon={MessageCircleQuestion}
  title={t("questionMcpTitle")}
  description={t("questionMcpDescription")}
>
  <SettingRow title={t("questionMcpWaitMinutes")}>
    <Input type="number" min={1} max={1440} value={waitMinutes} />
  </SettingRow>
  <SettingRow title={t("questionMcpRetryCount")}>
    <Input type="number" min={0} max={10} value={retryCount} />
  </SettingRow>
  <SettingRow title={t("questionMcpAutoSelect")}>
    <Switch checked={autoSelectFirst} />
  </SettingRow>
</SettingsSection>
```

使用一个保存回调把输入值转成整数并限制到后端范围；自动选择关闭时显示 `questionMcpInfiniteWait`，并禁用或隐藏“等待时长/重提次数”的即时保存提示，但仍保留当前值以便重新开启时恢复。

- [ ] **Step 4: 添加十种语言文案并运行前端测试**

Run: `pnpm exec vitest run src/components/settings/general-settings.test.tsx -t "Question MCP"`

Expected: PASS，控件可访问名称、默认值、payload 和无限等待说明全部正确。

- [ ] **Step 5: 运行 lint 和类型检查**

Run: `pnpm exec eslint src/components/settings/general-settings.tsx src/components/settings/general-settings.test.tsx && pnpm exec tsc --noEmit`

Expected: PASS，新增消息键在十种 locale 中结构一致。

- [ ] **Step 6: 提交**

```bash
git add src/components/settings/general-settings.tsx src/components/settings/general-settings.test.tsx src/lib/types.ts src/lib/api.ts src/lib/tauri.ts src/i18n/messages
git commit -m "feat: 在常规设置中增加提问 MCP 配置"
```

### Task 4: 集成回归、全量检查和合并准备

**Files:**
- Test: `src/contexts/acp-connections-context.test.tsx` — 保留并扩展 MCP 宿主超时后的纯文本兜底回归。
- Test: `src-tauri/src/acp/question.rs`、`src-tauri/src/commands/question.rs`、`src-tauri/src/acp/delegation/listener.rs` — 汇总 Rust 生命周期回归。

**Interfaces:** 使用前三个任务已经提交的 `QuestionSettings`、`QuestionRuntimeConfig` 和 listener 行为，不再引入新的公共设置接口。

- [ ] **Step 1: 写/确认跨层回归测试**

确认以下路径有测试覆盖：

```text
设置保存 → app_metadata → runtime snapshot
MCP Ask → 问题卡 → timeout → cancel → re-register
MCP Ask → retries exhausted → first option outcome
宿主提前取消 → 前端保留纯文本兜底
Codeg stop → question cleanup → declined
```

- [ ] **Step 2: 运行 Rust 必要检查**

```bash
cd src-tauri
cargo test --features test-utils
cargo check --no-default-features --features server-bin --bin codeg-server
cargo clippy --all-targets --features test-utils -- -D warnings
```

Expected: 全部退出码为 0；若 `cargo insta` 快照变化，只评审本次提问生命周期相关快照。

- [ ] **Step 3: 运行前端必要检查**

```bash
pnpm lint .
pnpm test
pnpm build
```

Expected: lint、Vitest、静态导出构建均成功。

- [ ] **Step 4: 复核差异和工作区**

```bash
```

确认只有本功能文件发生变化，没有提交 `.DS_Store`、密钥或生成产物。

- [ ] **Step 5: 更新 CodeGraph 并提交最终集成准备**

```bash
codegraph sync /Users/andyzheng/git/codeg/worktrees/wt_question_mcp_config
```

验证通过后，把 `worktrees/wt_question_mcp_config` 的提交 fast-forward 合并回 `main`，保留 worktree，删除临时分支。
