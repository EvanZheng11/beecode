# 委托完成状态唤醒实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让委托任务进入 `completed` 缓存后立即唤醒 `get_delegation_status` 等待者，并把父级元数据、完成事件和子连接断开的慢收尾放到唤醒之后，同时保留现有取消、setup 竞态、批量状态和 `wait_ms` 语义。

**Architecture:** 只调整 `src-tauri/src/acp/delegation/broker.rs` 的正常 `complete_call` 完成路径。`pending.inner` 锁内仍原子执行 `running.remove` 和 `completed.insert`；锁释放后先调用 `result_notify.notify_waiters()`，再按原有顺序执行 `finalize_delegation` 的 meta 写入、完成事件广播和子连接断开。回归测试复用现有 `ChildLiveReplyLookup`、`DelegationMetaWriter`、`DelegationEventEmitter` 和 `MockSpawner` 注入点，在 broker 单元测试内用 `Notify` 门闩控制状态快照与慢收尾。

**Tech Stack:** Rust 2021、Tokio `Mutex`/`Notify`/任务、`async-trait`、`tracing`、现有 `DelegationBroker` 单元测试与 `MockSpawner`；验证使用 Cargo test、Clippy 和 Git 空白检查，不增加依赖。

**Spec:** `docs/superpowers/specs/2026-10-12-delegation-wakeup-design.md`

## Global Constraints

- 只改 `src-tauri/src/acp/delegation/broker.rs`；`listener.rs`、`companion.rs`、`live_reply.rs`、`meta_writer.rs` 和 `event_emitter.rs` 只作为现有接口与语义的核对依据。
- 正常运行任务的顺序固定为：持有 `pending.inner` 锁时完成 `running → completed`，释放锁，调用 `result_notify.notify_waiters()`，再执行 `finalize_delegation`。
- `notify_waiters()` 不得在 `pending.inner` 锁保护范围内调用；通知与 `finalize_delegation()` 之间不得增加异步等待、子连接操作或状态迁移。
- `complete_call` 找不到 `running[call_id]` 时仍只按原有 setup 竞态规则写入 `early_completes` 或静默忽略，不新增通知。
- 不改动 `cancel_by_external_handle`、`cancel_by_child_connection`、`cancel_by_parent`、`cancel_by_parent_turn`、`cancel_task_by_id` 的 completed 记录、收尾和通知点；不改动 `early_completes`、`early_cancels`、`inflight` 的 first-terminal-wins 规则。
- `get_tasks_status` 保留 `Notified::enable()` 在快照前注册、唤醒后重新分类的逻辑；省略 `wait_ms`、正数上限 60000 毫秒、`wait_ms = 0` 无限等待、批量请求顺序和父连接作用域都不变。
- 新增结构化 `debug` 阶段日志只记录 `task_id`、`parent_connection_id`、`terminal_status`、`wakeup_phase`、`finalize_phase`；不得记录 task 正文、结果正文、token 内容或路径内容。
- 新回归测试使用 `tokio::sync::Notify` 门闩编排顺序；`timeout` 只用于失败保护，不用固定 `sleep` 推断竞态。
- 新增或更新的 Rust 注释使用中文，并明确说明“迁移 → 唤醒 → 收尾”的顺序；不改变无关注释、抽象或文件格式。
- 未来实施的代码提交必须先通过完整 Rust 测试、Clippy 和 `git diff --check`，提交内容只包含 `src-tauri/src/acp/delegation/broker.rs`。

## 文件映射

| 文件 | 操作 | 责任范围 |
| --- | --- | --- |
| `src-tauri/src/acp/delegation/broker.rs` | 修改 | 更新 `result_notify`、`PendingInner::insert_completed` 和 `complete_call` 的顺序注释；增加两阶段日志；在现有 `#[cfg(test)] mod tests` 中增加门闩测试夹具和慢收尾回归测试。 |
| `src-tauri/src/acp/delegation/live_reply.rs` | 只读核对 | 使用已有 `ChildLiveReplyLookup::blocked_on(&str) -> Option<BlockedOn>` 接口作为状态快照门闩，不修改 trait 或生产实现。 |
| `src-tauri/src/acp/delegation/meta_writer.rs` | 只读核对 | 使用已有 `DelegationMetaWriter::write_meta(&str, &str, serde_json::Value)` 接口和 `MockMetaWriter::snapshot()` 记录终态 meta，不修改 trait。 |
| `src-tauri/src/acp/delegation/event_emitter.rs` | 只读核对 | 使用已有 `MockEventEmitter::count()` / `snapshot()` 验证完成事件仍在终态 meta 之后发出。 |
| `src-tauri/src/acp/delegation/spawner.rs` | 只读核对 | 使用已有 `MockSpawner` 的 `disconnects` 记录验证子连接仍在完成事件之后断开。 |
| `src-tauri/src/acp/delegation/listener.rs` | 只读核对 | 确认 `wait_ms` 映射未被实现改动影响。 |
| `src-tauri/src/acp/delegation/companion.rs` | 只读核对 | 确认状态请求仍是一帧 round trip，未引入新的协议通道。 |
| `docs/superpowers/specs/2026-10-12-delegation-wakeup-design.md` | 只读核对 | 作为本计划的唯一设计依据。 |

不会创建新文件。现有抽象已经足够注入测试行为：`DelegationBroker::with_writers(...)` 可注入 meta writer 和 event emitter，`with_live_reply_lookup(...)` 可注入 live-reply lookup；因此只在 `broker.rs` 测试模块内定义门闩类型，不增加生产接口或 `test-utils` 公共 API。

## 现有接口与测试装配

实施者按以下真实签名装配测试，避免自行引入同名接口：

```rust
pub trait ChildLiveReplyLookup: Send + Sync {
    async fn latest_reply(&self, child_connection_id: &str) -> Option<String>;
    async fn blocked_on(&self, _child_connection_id: &str) -> Option<BlockedOn> {
        None
    }
}

pub trait DelegationMetaWriter: Send + Sync {
    async fn write_meta(
        &self,
        parent_connection_id: &str,
        parent_tool_use_id: &str,
        meta: serde_json::Value,
    );
}

pub fn with_writers(
    spawner: Arc<dyn ConnectionSpawner>,
    depth_lookup: Arc<dyn ConversationDepthLookup>,
    meta_writer: Arc<dyn DelegationMetaWriter>,
    event_emitter: Arc<dyn DelegationEventEmitter>,
) -> DelegationBroker;

pub fn with_live_reply_lookup(
    self,
    live_reply_lookup: Arc<dyn ChildLiveReplyLookup>,
) -> DelegationBroker;

pub async fn complete_call(&self, call_id: &str, outcome: DelegationOutcome);

pub async fn get_task_status(
    &self,
    parent_connection_id: &str,
    parent_conversation_id: Option<i32>,
    task_id: &str,
    wait: StatusWait,
) -> DelegationTaskReport;
```

## 任务 1：先写慢收尾回归测试并确认旧顺序失败

**文件：**

- 修改：`src-tauri/src/acp/delegation/broker.rs` 的现有 `#[cfg(test)] mod tests`
- 复用：`MockSpawner`、`MockMetaWriter`、`MockEventEmitter`、`shallow_lookup`、`request`、`enable_delegation`

**接口：**

- 消费 `ChildLiveReplyLookup::blocked_on`、`DelegationMetaWriter::write_meta` 和 `DelegationBroker::with_writers`。
- 产出测试 `complete_call_wakes_status_waiter_before_slow_finalize`；后续实现必须让该测试在终态收尾门闩未释放时拿到 `Completed`。

- [ ] **步骤 1：添加状态快照与终态 meta 门闩类型（约 4 分钟）**

在 broker 测试模块的现有 import 区增加以下导入，并紧接着定义两个测试专用类型。状态门闩在 `blocked_on` 被调用时发出进入信号；meta 门闩只拦截 `codeg.delegation.status == "completed"`，所以 `start_delegation` 的 `"running"` meta 仍立即完成。

```rust
use crate::acp::delegation::event_emitter::{
    mock::MockEventEmitter,
    DelegationEventEmitter,
};
use crate::acp::delegation::live_reply::ChildLiveReplyLookup;
use crate::acp::delegation::meta_writer::{
    mock::MockMetaWriter,
    DelegationMetaWriter,
};
use async_trait::async_trait;
use tokio::sync::Notify;

struct StatusProbeGate {
    entered: Arc<Notify>,
    release: Arc<Notify>,
}

#[async_trait]
impl ChildLiveReplyLookup for StatusProbeGate {
    async fn latest_reply(&self, _child_connection_id: &str) -> Option<String> {
        None
    }

    async fn blocked_on(&self, _child_connection_id: &str) -> Option<BlockedOn> {
        self.entered.notify_one();
        self.release.notified().await;
        None
    }
}

struct SlowFinalizeMetaWriter {
    inner: Arc<MockMetaWriter>,
    entered: Arc<Notify>,
    release: Arc<Notify>,
}

#[async_trait]
impl DelegationMetaWriter for SlowFinalizeMetaWriter {
    async fn write_meta(
        &self,
        parent_connection_id: &str,
        parent_tool_use_id: &str,
        meta: serde_json::Value,
    ) {
        let is_terminal_completed = meta
            .get("codeg.delegation")
            .and_then(|value| value.get("status"))
            .and_then(serde_json::Value::as_str)
            == Some("completed");
        self.inner
            .write_meta(parent_connection_id, parent_tool_use_id, meta)
            .await;
        if is_terminal_completed {
            self.entered.notify_one();
            self.release.notified().await;
        }
    }
}
```

运行：

```bash
cd /Users/andyzheng/git/codeg/worktrees/wt_delegation_wakeup/src-tauri
cargo check --tests --features test-utils
```

预期：测试门闩类型和 trait 实现编译通过，尚未加入回归测试时没有行为断言被执行。

- [ ] **步骤 2：添加不使用固定 sleep 的失败测试（约 5 分钟）**

在 `infinite_wait_parks_until_terminal` 附近加入以下完整测试。它先让 waiter 进入 `blocked_on`，再启动 `complete_call`；等待 `finalize_entered` 证明 `complete_call` 已经进入终态 meta 收尾后，才释放状态快照门闩。这样旧顺序会在 `timeout` 内无法返回，新顺序会在终态收尾门闩仍保持关闭时返回。

```rust
#[tokio::test]
async fn complete_call_wakes_status_waiter_before_slow_finalize() {
    let mock = Arc::new(MockSpawner::new());
    mock.queue_spawn(Ok("child-conn-1".into())).await;
    mock.queue_send(Ok(42)).await;

    let status_probe_entered = Arc::new(Notify::new());
    let status_probe_release = Arc::new(Notify::new());
    let finalize_entered = Arc::new(Notify::new());
    let finalize_release = Arc::new(Notify::new());
    let writer = Arc::new(MockMetaWriter::new());
    let emitter = Arc::new(MockEventEmitter::new());
    let broker = DelegationBroker::with_writers(
        mock.clone() as Arc<dyn ConnectionSpawner>,
        shallow_lookup(),
        Arc::new(SlowFinalizeMetaWriter {
            inner: writer.clone(),
            entered: finalize_entered.clone(),
            release: finalize_release.clone(),
        }) as Arc<dyn DelegationMetaWriter>,
        emitter.clone() as Arc<dyn DelegationEventEmitter>,
    )
    .with_live_reply_lookup(Arc::new(StatusProbeGate {
        entered: status_probe_entered.clone(),
        release: status_probe_release.clone(),
    }) as Arc<dyn ChildLiveReplyLookup>);
    enable_delegation(&broker).await;

    let task_id = broker
        .start_delegation(request(1, "pt-wakeup"))
        .await
        .task_id
        .expect("start_delegation must return a task id");

    let mut waiter = {
        let broker = broker.clone();
        let task_id = task_id.clone();
        tokio::spawn(async move {
            broker
                .get_task_status("parent-conn", Some(1), &task_id, StatusWait::Infinite)
                .await
        })
    };
    status_probe_entered.notified().await;

    let call_id = task_id.clone();
    let completion = {
        let broker = broker.clone();
        tokio::spawn(async move {
            broker
                .complete_call(
                    &call_id,
                    DelegationOutcome::Ok(DelegationSuccess {
                        text: "done".into(),
                        child_conversation_id: 42,
                        child_agent_type: AgentType::ClaudeCode,
                        turn_count: 1,
                        duration_ms: 0,
                        token_usage: None,
                    }),
                )
                .await;
        })
    };
    finalize_entered.notified().await;
    status_probe_release.notify_one();

    let waiter_result =
        tokio::time::timeout(Duration::from_secs(1), &mut waiter).await;
    let report = match waiter_result {
        Ok(joined) => joined.expect("status waiter task must not panic"),
        Err(_) => {
            finalize_release.notify_one();
            completion
                .await
                .expect("completion task must finish during cleanup");
            waiter
                .await
                .expect("status waiter must finish during cleanup");
            panic!("status waiter did not wake before terminal finalization finished");
        }
    };

    assert_eq!(report.status, TaskStatus::Completed);
    assert_eq!(report.text.as_deref(), Some("done"));
    assert!(
        !completion.is_finished(),
        "complete_call must still be blocked in slow finalization"
    );
    assert_eq!(emitter.count().await, 0);
    assert!(mock.disconnects.lock().await.is_empty());

    finalize_release.notify_one();
    completion
        .await
        .expect("completion task must finish after finalization release");

    let cached = broker
        .get_task_status("parent-conn", Some(1), &task_id, StatusWait::Immediate)
        .await;
    assert_eq!(cached.status, TaskStatus::Completed);
    assert_eq!(cached.text.as_deref(), Some("done"));

    let meta_calls = writer.snapshot().await;
    assert_eq!(meta_calls.len(), 2);
    assert_eq!(
        meta_calls[1].meta["codeg.delegation"]["status"].as_str(),
        Some("completed")
    );
    assert_eq!(emitter.count().await, 1);
    assert_eq!(
        mock.disconnects.lock().await.as_slice(),
        &["child-conn-1".to_string()]
    );
}
```

运行：

```bash
cd /Users/andyzheng/git/codeg/worktrees/wt_delegation_wakeup/src-tauri
cargo check --tests --features test-utils
```

预期：测试代码编译通过；此步骤只验证类型和 trait 实现，随后单独的红测试命令会验证旧顺序确实无法在终态收尾门闩关闭时唤醒 waiter。

- [ ] **步骤 3：运行红测试确认它确实区分旧顺序（约 2 分钟）**

运行：

```bash
cd /Users/andyzheng/git/codeg/worktrees/wt_delegation_wakeup/src-tauri
cargo test --features test-utils complete_call_wakes_status_waiter_before_slow_finalize
```

预期：命令能编译测试夹具但测试失败，因为当前 `complete_call` 仍在 `finalize_delegation(...).await` 后才通知；不要修改测试断言来迎合旧行为。

## 任务 2：实现“迁移 → 唤醒 → 收尾”并增加阶段日志

**文件：**

- 修改：`src-tauri/src/acp/delegation/broker.rs:560-570`、`:1425-1427`、`:2902-2962`
- 不修改：任何取消函数、setup disposition 分支、`get_tasks_status`、`listener.rs`、`companion.rs`

**接口：**

- 消费任务 1 的回归测试和现有 `complete_call` 参数 `(&self, &str, DelegationOutcome)`。
- 产出不改变签名的 `complete_call`；唯一行为变化是正常 `running` 任务在 completed 缓存可见后立即发出 waiter 通知。

- [ ] **步骤 1：更新字段、缓存插入和完成路径注释（约 3 分钟）**

把 `result_notify` 字段说明改成下面的语义，并把 `insert_completed` 的尾部说明改为“调用方释放锁后立即通知，再收尾”；同步更新 `complete_call` 的 doc comment，明确正常完成路径是“原子迁移 → 锁外唤醒 → 异步收尾”，找不到 running 条目仍只处理 setup 早到完成。

```rust
    /// 在终态写入 `completed` 缓存后唤醒所有状态长轮询；正常
    /// `complete_call` 会在释放 `pending.inner` 锁后、父级 meta/事件/子连接
    /// 收尾前通知，因此 waiter 不会被慢收尾阻塞。
    result_notify: Arc<Notify>,
```

```rust
    /// 调用方在同一把锁内完成 `running.remove` + 此处插入；锁释放后立即
    /// 通知状态长轮询，再执行父级 meta、完成事件和子连接收尾。
    fn insert_completed(&mut self, call_id: &str, task: CompletedTask) {
```

```rust
    /// 将任务从 `running` 原子迁移到 `completed`，释放 pending 锁后立即
    /// 唤醒状态 waiter，再执行终态 meta、`DelegationCompleted` 事件和子连接
    /// 断开。若任务仍处于 setup 保留窗口，则继续按原规则缓存早到完成。
```

运行：

```bash
cd /Users/andyzheng/git/codeg/worktrees/wt_delegation_wakeup/src-tauri
cargo check --tests --features test-utils
```

预期：注释修改不改变 Rust 类型或测试构建；没有把 setup 阶段的 `Disposition::ChildTerminal` 或取消分支误写成新的正常完成顺序。

- [ ] **步骤 2：移动通知并加入不泄漏正文的两阶段日志（约 4 分钟）**

将 `complete_call` 中现有 `finalize_delegation` 和 `notify_waiters` 的顺序替换为以下完整代码。`let task = { ... }` 的锁作用域在 `if let` 前已经结束，所以通知不持有 `pending.inner` 锁；通知和 finalize 之间没有新的 `.await`。

```rust
        if let Some((task, duration_ms)) = task {
            let terminal_status = match &outcome {
                DelegationOutcome::Ok(_) => "completed",
                DelegationOutcome::Err { code, .. } if code == "canceled" => "canceled",
                DelegationOutcome::Err { .. } => "failed",
            };
            tracing::debug!(
                task_id = %task.task_id,
                parent_connection_id = %task.parent_connection_id,
                terminal_status = %terminal_status,
                wakeup_phase = "completed_cache_visible",
                finalize_phase = "pending",
                "委托已进入 completed 缓存，先唤醒状态等待再执行终态收尾"
            );
            self.result_notify.notify_waiters();
            self.finalize_delegation(
                &task.parent_connection_id,
                &task.parent_tool_use_id,
                &task.child_connection_id,
                task.child_conversation_id,
                task.agent_type,
                duration_ms,
                &outcome,
                &task.task_preview,
                &task.task_id,
            )
            .await;
            tracing::debug!(
                task_id = %task.task_id,
                parent_connection_id = %task.parent_connection_id,
                terminal_status = %terminal_status,
                wakeup_phase = "completed_cache_visible",
                finalize_phase = "finished",
                "委托终态收尾完成"
            );
        }
```

运行：

```bash
cd /Users/andyzheng/git/codeg/worktrees/wt_delegation_wakeup/src-tauri
cargo check --tests --features test-utils
```

预期：日志字段和移动后的异步调用编译通过；`completed_cache_visible` 日志发生在 `notify_waiters()` 调用点，`finalize_phase` 为 `pending`；收尾结束日志的 `finalize_phase` 为 `finished`。两条日志只含五类结构化字段，不引用 `task.task_preview`、`outcome`、`ok.text`、token 或路径；`terminal_status` 对成功、普通错误、`code == "canceled"` 分别是 `completed`、`failed`、`canceled`；`complete_call` 的 `None` 分支仍只调用 `buffer_early_complete`，不新增通知。

- [ ] **步骤 3：运行红测试转绿（约 2 分钟）**

运行：

```bash
cd /Users/andyzheng/git/codeg/worktrees/wt_delegation_wakeup/src-tauri
cargo test --features test-utils complete_call_wakes_status_waiter_before_slow_finalize
```

预期：测试通过；报告在 `finalize_release.notify_one()` 之前已经是 `TaskStatus::Completed` 且正文为 `done`，随后仍完成一次终态 meta、一次完成事件和一次 disconnect。

- [ ] **步骤 4：运行直接相关的现有 broker 测试（约 5 分钟）**

运行：

```bash
cd /Users/andyzheng/git/codeg/worktrees/wt_delegation_wakeup/src-tauri
cargo test --features test-utils infinite_wait_parks_until_terminal
cargo test --features test-utils batch_infinite_returns_when_any_settles
cargo test --features test-utils batch_infinite_returns_immediately_when_one_already_terminal
cargo test --features test-utils batch_bounded_deadline_returns_running_snapshot
cargo test --features test-utils completion_before_park_resolves_instead_of_hanging
cargo test --features test-utils child_terminal_wins_over_later_parent_cancel
cargo test --features test-utils parent_cancel_wins_when_it_arrives_before_child_terminal
cargo test --features test-utils emitter_records_after_meta_write_on_complete_call
```

预期：每条命令均为 PASS。它们分别覆盖无限等待、批量“任一终态”、入口已有终态、正数 deadline、setup 完成竞态、setup 取消竞态和 meta-before-event 顺序；本次实现不得把其他终态路径改成提前通知。

## 任务 3：完成全量验证并做静态顺序审查

**文件：**

- 验证：`src-tauri/src/acp/delegation/broker.rs`
- 只读核对：`src-tauri/src/acp/delegation/listener.rs`、`src-tauri/src/acp/delegation/companion.rs`

**接口：**

- 消费任务 2 的 `complete_call` 顺序和测试。
- 产出全量 Rust 测试、Clippy、差异空白检查和日志字段审查均通过的实现状态。

- [ ] **步骤 1：运行完整 Rust 测试（约 5 分钟）**

运行：

```bash
cd /Users/andyzheng/git/codeg/worktrees/wt_delegation_wakeup/src-tauri
cargo test --features test-utils
```

预期：退出码为 0；现有取消路径、父级取消、external handle、setup 竞态、批量状态、父作用域隔离、`StatusWait::Immediate`/`Bounded`/`Infinite` 和 resume 相关测试全部通过。

- [ ] **步骤 2：运行 Clippy 严格检查（约 5 分钟）**

运行：

```bash
cd /Users/andyzheng/git/codeg/worktrees/wt_delegation_wakeup/src-tauri
cargo clippy --all-targets --features test-utils -- -D warnings
```

预期：退出码为 0，没有 warning；特别确认测试门闩的 trait 实现、`tracing` 字段写法和 `terminal_status` 匹配没有触发 lint。

- [ ] **步骤 3：检查差异空白和日志正文范围（约 3 分钟）**

运行：

```bash
cd /Users/andyzheng/git/codeg/worktrees/wt_delegation_wakeup
git diff --check
git diff -- src-tauri/src/acp/delegation/broker.rs
```

预期：`git diff --check` 无输出；人工逐段确认 `complete_call` 的可见顺序为 `completed.insert` → 释放锁 → `notify_waiters` → `finalize_delegation`，并确认阶段日志字段没有 `task_preview`、结果正文、token 或路径。

- [ ] **步骤 4：核对协议调用方未被改写（约 2 分钟）**

运行：

```bash
cd /Users/andyzheng/git/codeg/worktrees/wt_delegation_wakeup
rg -n "wait_ms|StatusWait::(Immediate|Bounded|Infinite)|get_tasks_status|notify_waiters" src-tauri/src/acp/delegation/listener.rs src-tauri/src/acp/delegation/companion.rs src-tauri/src/acp/delegation/broker.rs
```

预期：只有 `broker.rs` 的正常 `complete_call` 顺序和注释/日志发生本任务对应变化；`listener.rs` 的 60000 毫秒上限、`companion.rs` 的状态 round trip 和 broker 的 waiter 二次快照逻辑保持原状。

## 任务 4：提交实现并合并到主分支

**文件：**

- 提交：`src-tauri/src/acp/delegation/broker.rs`
- 合并目标：`/Users/andyzheng/git/codeg` 的 `main`

**接口：**

- 消费任务 3 的全部通过结果。
- 产出一个只含 broker 实现的中文提交，并在主工作树执行 fast-forward 合并。

- [ ] **步骤 1：确认提交范围（约 2 分钟）**

运行：

```bash
cd /Users/andyzheng/git/codeg/worktrees/wt_delegation_wakeup
git status --short
git diff --name-only
```

预期：实现提交阶段只出现 `src-tauri/src/acp/delegation/broker.rs`；计划文档已经由本计划任务单独提交，不能把其他文件或生成物带入实现提交。

- [ ] **步骤 2：强制暂存并核对暂存内容（约 2 分钟）**

运行：

```bash
cd /Users/andyzheng/git/codeg/worktrees/wt_delegation_wakeup
git add src-tauri/src/acp/delegation/broker.rs
git diff --cached --check
git diff --cached --name-only
```

预期：空白检查无输出，暂存文件列表只有 `src-tauri/src/acp/delegation/broker.rs`。

- [ ] **步骤 3：提交实现（约 2 分钟）**

运行：

```bash
cd /Users/andyzheng/git/codeg/worktrees/wt_delegation_wakeup
git commit -m "修复委托完成状态唤醒"
```

预期：生成一个提交，提交信息为 `修复委托完成状态唤醒`；提交内容只包含 broker 实现与回归测试。

- [ ] **步骤 4：在主工作树 fast-forward 合并（约 2 分钟）**

运行：

```bash
git -C /Users/andyzheng/git/codeg merge --ff-only worktrees/wt_delegation_wakeup
git -C /Users/andyzheng/git/codeg status --short --branch
```

预期：`main` fast-forward 到实现提交，主工作树状态干净；合并后不修改数据库、不需要迁移数据、不需要更新 listener/companion 的 wire 版本。

## 设计规格覆盖自审

- **A1、A2：** 任务 1 的双门闩测试证明 completed 缓存可读后先唤醒，任务 2 保留通知后的循环重分类，返回新快照而不是唤醒前的 `Running`。
- **A3：** `finalize_delegation` 内部的 meta → `DelegationCompleted` → disconnect 顺序保持不变；测试断言终态 meta、一个事件和一次 disconnect 都完成。
- **A4：** 任务 2 的直接相关测试和任务 3 的全量测试覆盖取消、setup 竞态、批量报告、父作用域、三种 `StatusWait`；实现只移动正常 `complete_call` 的通知点。
- **A5：** 两条 `debug` 日志固定记录 `completed_cache_visible`、`pending/finished` 阶段和五个结构化字段，不携带 task/result 正文。
- **并发不变量：** `running.remove` 与 `completed.insert` 仍在同一把 `pending.inner` 锁内，通知在锁外，`finalize_delegation` 不写 pending map。
- **提交与合并：** 任务 4 给出 broker 单文件提交、中文提交信息和 `/Users/andyzheng/git/codeg` 主工作树的 fast-forward 命令。

## 风险与缓解

- waiter 可能先看到 completed、父级 UI meta 仍短暂显示 running：这是规格接受的可见窗口；meta → event → disconnect 的收尾顺序保持不变，阶段日志可区分两段。
- `Notify` 会唤醒所有状态 waiter：每个 waiter 都重新锁内分类自己的 task id；批量请求仍按原顺序返回 completed/running/unknown。
- 测试使用 `timeout` 作为失败保护：门闩负责决定先后，timeout 不参与生产逻辑，也不以固定 sleep 作为通过条件。
- 正常完成日志新增两次 debug 调用：字段只包含受控 id、状态和阶段，任务预览与结果正文继续留在既有 meta/报告路径，不进入日志。

## 执行入口

在当前隔离分支 `worktrees/wt_delegation_wakeup` 内按任务 1 → 2 → 3 → 4 顺序内联执行；每个步骤先执行列出的命令并核对预期结果，再进入下一步。实现期间不创建下级子智能体。
