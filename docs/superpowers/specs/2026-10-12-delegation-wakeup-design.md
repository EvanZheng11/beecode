# 委托任务完成唤醒顺序设计规格

- 日期：2026-10-12
- 状态：设计已确认，待实施
- 交付范围：本次只提交本设计文档；文中代码与测试改动属于后续实施规格
- 影响面：`src-tauri/src/acp/delegation/broker.rs` 为主，验证覆盖 `listener.rs`、`companion.rs` 的既有链路
- 数据库：不改表结构、不迁移数据、不删除数据

## 1. 问题与目标

主智能体调用 `get_delegation_status` 等待子智能体结果时，偶尔会长时间看到“等待任务执行结果”，即使子任务已经完成。问题集中在完成事件到达后的两个阶段之间：broker 已经把任务标记为终态，但等待请求还没有收到唤醒信号。

目标是让等待请求在任务进入 `completed` 缓存后立即被唤醒，并由等待路径重新读取一次当前状态，尽快把终态结果返回给主智能体。父会话的元数据写入、完成事件广播和子连接断开继续执行，但不再阻塞状态 waiter 获取已经可用的终态结果。

验收标准如下：

| 编号 | 验收标准 |
| --- | --- |
| A1 | `complete_call` 将任务从 `running` 迁移到 `completed` 后，等待中的 `get_delegation_status` 能在终态收尾尚未结束时返回终态报告 |
| A2 | waiter 被唤醒后重新读取缓存，不能仅依据“收到唤醒”就返回旧的 `running` 快照 |
| A3 | 元数据写入 → 完成事件广播 → 子连接断开的现有顺序保持不变 |
| A4 | 取消、批量查询、`wait_ms` 三种等待模式的既有返回内容和边界语义保持不变 |
| A5 | 日志能区分“终态已进入缓存并发出唤醒”和“终态收尾已完成”，且不记录任务正文或结果正文 |

## 2. 现状与根因

### 2.1 请求链路

`get_delegation_status` 的调用链如下：

```text
主智能体
  │ MCP tools/call
  ▼
companion.rs
  │ 规范化 task_ids / 读取 wait_ms
  │ 一次 UDS 或 Windows 命名管道 round trip
  ▼
listener.rs
  │ 校验 token、解析父连接和父会话
  │ 将 wait_ms 映射为 StatusWait
  ▼
broker.rs::get_tasks_status
  │ pending lock 下分类 completed / running / unknown
  │ 必要时等待 result_notify，再重新分类
  ▼
{ tasks: [DelegationTaskReport, ...] }
```

子任务完成链路如下：

```text
子会话生命周期收到 TurnComplete 或错误
  ▼
broker.rs::complete_call
  ▼
pending lock：running.remove(call_id)
  ▼
pending lock：completed.insert(call_id, terminal report)
  ▼
释放 pending lock
  ▼
finalize_delegation：父 meta → 完成事件 → 子连接断开
  ▼
result_notify.notify_waiters()
```

### 2.2 等待语义

当前协议和 listener 的映射已经确定，规格只要求保留它们：

| MCP 参数 | `StatusWait` | 当前语义 |
| --- | --- | --- |
| 省略 `wait_ms` | `Immediate` | 只取一次当前快照，立即返回 |
| `wait_ms > 0` | `Bounded(ms.min(60000))` | 最多等待映射后的时长；期间出现终态则提前返回，超时返回当前快照 |
| `wait_ms = 0` | `Infinite` | 不设置时间上限，等待任务状态变化；broker 已有的“识别到新的人工阻塞时返回”规则保持不变 |

`get_tasks_status` 不是固定周期轮询。它在每轮快照前先 arm `Notify`，然后在 `pending.inner` 锁下分类任务；如果仍需要等待，就停在 `result_notify` 上，收到唤醒后再进入下一轮。这样可以避免快照与通知之间丢失完成事件。

`listener.rs` 负责 `wait_ms` 到 `StatusWait` 的映射，并将正数限制为 60000 毫秒。`companion.rs` 负责一次状态 UDS round trip；取消状态查询时只抑制响应，不向 broker 发送任务取消。

### 2.3 根因

`complete_call` 当前已经在同一个 `pending.inner` 锁内完成 `running → completed` 迁移，因此并发状态查询不会看到任务既不在 `running` 也不在 `completed`。问题在于 `result_notify.notify_waiters()` 放在 `finalize_delegation(...).await` 之后。

`finalize_delegation` 包含三个可能等待外部组件的动作：

1. 写入父会话 `meta["codeg.delegation"]`；
2. 广播 `DelegationCompleted`；
3. 断开子连接。

这些动作的延迟不应影响已进入完成缓存的状态查询。当前顺序形成了下面的可见窗口：

```text
T1 complete_call：锁内完成 running → completed
T2 状态 waiter：仍停在 result_notify
T3 complete_call：等待慢的 meta / 事件 / disconnect 收尾
T4 complete_call：notify_waiters
T5 waiter：重新分类并返回 completed
```

因此主智能体看到的“等待任务执行结果”时间包含了与状态缓存无关的终态收尾时间。

## 3. 推荐方案

在 `complete_call` 中保留现有的锁内原子迁移，只把唤醒移动到**释放 pending lock 之后、进入 `finalize_delegation` 之前**：

```text
pending lock
  running.remove(call_id)
  completed.insert(call_id, terminal report)
释放 pending lock
result_notify.notify_waiters()       ← 新位置
finalize_delegation(...).await       ← 继续慢收尾
```

实现约束如下：

1. 只有确实从 `running` 取出任务并写入 `completed` 的分支才通知。
2. `running` 中没有 `call_id` 时，继续按现有逻辑把结果写入 setup 阶段的 `early_completes`，或在非 setup 场景静默忽略；该分支不因为本设计额外唤醒。
3. `notify_waiters()` 必须在 pending lock 已释放后调用，避免 waiter 被唤醒后长时间争用该锁。
4. `notify_waiters()` 与 `finalize_delegation()` 之间不插入新的异步等待、子连接操作或状态迁移。
5. `finalize_delegation` 本身不改动 pending map，仍由调用方负责 `running → completed` 迁移。
6. 本次顺序调整针对正常运行任务由生命周期调用的 `complete_call`。setup 阶段的 `ChildTerminal` 分支和各取消路径保留现有先收尾后唤醒的结构，避免扩大取消与 setup 竞态的改动面；这些路径的既有语义由回归测试继续守住。

### 3.1 waiter 的二次确认

通知只表示“某个可能影响等待条件的事件发生”，不携带任务状态，也不携带任务 id。`get_tasks_status` 被唤醒后必须继续走现有循环：

1. 重新在 `pending.inner` 锁下分类每个请求的 task id；
2. 发现 `completed` 后组装终态报告；
3. 对批量请求重新计算 `running_count`，再决定是否返回；
4. 对其他父会话的任务继续返回 `Unknown`，不泄漏状态。

这样可以同时处理两类竞态：

- 完成先发生、waiter 后开始快照：waiter 直接看到 `completed`，无需依赖通知许可；
- waiter 先看到 `running`、随后收到唤醒：waiter 重查缓存后才返回 `completed`。

现有“快照前先调用 `Notified::enable`”的做法必须保留。它保证完成发生在快照与真正等待之间时，唤醒不会丢失；本设计只改变通知发生的时间点。

### 3.2 日志与注释

实现时在 broker 的完成路径增加结构化 `debug` 日志，至少带上以下字段：

- `task_id`：broker 任务 id；
- `parent_connection_id`：父连接 id；
- `terminal_status`：`completed`、`failed` 或 `canceled`；
- `wakeup_phase`：固定使用 `completed_cache_visible` 表示缓存已可读并已发出 waiter 唤醒；
- `finalize_phase`：通知时为 `pending`，收尾结束时为 `finished`。

日志正文说明“状态 waiter 在终态收尾前被唤醒”。不记录任务文本、子智能体结果文本、token 内容或路径内容。若现有调用上下文已经带有同名字段，复用现有 span 字段，避免重复创建不一致的字段。

同步更新以下注释，使执行顺序与代码一致：

- `DelegationBroker::result_notify` 字段注释：说明唤醒发生在 completed 缓存可见后、终态副作用收尾前；
- `complete_call` 的生命周期注释：明确“迁移 → 唤醒 → 收尾”；
- `PendingInner::insert_completed` 的调用说明：明确调用方在释放锁后立即通知，再进入异步收尾。

## 4. 并发顺序与不变量

### 4.1 正常完成

| 顺序 | 持有的状态 | 允许的动作 |
| --- | --- | --- |
| 1 | 持有 `pending.inner` 锁 | 删除 `running[task_id]`，构造并插入 `completed[task_id]` |
| 2 | 已释放 `pending.inner` 锁 | 调用 `result_notify.notify_waiters()` |
| 3 | 不持有 pending 锁 | 执行父 meta 写入、完成事件广播、子连接断开 |
| 4 | 不持有 pending 锁 | waiter 重新取锁并读取 `completed`，返回终态报告 |

第 3 步和第 4 步可以并行。第 4 步不依赖第 3 步完成，因为 `finalize_delegation` 不负责写入 completed cache，也不负责决定状态查询结果。

### 4.2 完成与取消竞态

`running` 的删除仍然由 `pending.inner` 锁串行化：哪个终态路径先取走任务，哪个路径继续完成；后到的路径保持现有的缓冲或无操作规则。移动通知不能改变这个先后关系。

具体要求：

- `complete_call` 成功迁移后可以提前唤醒 waiter；其 outcome 为错误时，仍按既有 `error_code` 映射为 `Failed` 或 `Canceled`；
- `cancel_by_external_handle`、`cancel_by_child_connection`、`cancel_by_parent`、`cancel_by_parent_turn` 和 `cancel_task_by_id` 的 completed 记录、取消结果、子连接处理和现有通知点保持不变；
- setup 阶段的 `early_completes`、`early_cancels`、`inflight` 仍按原有 first-terminal-wins 规则工作；
- 重复完成不会生成第二份 completed 记录，也不会因为本设计新增一次终态事件。

### 4.3 批量状态

`result_notify` 不携带 task id，因此一个完成会唤醒所有等待中的批量查询。每个查询都必须重新分类自己的 task id 列表：

- 任一请求任务进入终态时，批量查询按现有规则返回全部请求项；
- 已完成项返回终态报告，仍运行的兄弟项返回 `Running`；
- 请求顺序和父连接作用域保持不变；
- 其他父会话的任务仍返回 `Unknown`；
- 与任务无关的唤醒仍然只导致重新快照，不会凭空把 `Running` 报告变成终态。

### 4.4 监听器与伴生进程

`listener.rs` 和 `companion.rs` 不需要新增状态通道，也不需要改变协议。状态 round trip 仍然只有一帧请求和一帧响应：

1. companion 发出 `BrokerMessage::Status`；
2. listener 将请求交给 `get_tasks_status`；
3. broker 在缓存可读后唤醒 listener 内的 status future；
4. listener 返回 `{ "tasks": [...] }`；
5. companion 按现有渲染逻辑返回 MCP `tools/call` 结果。

listener 对 peer close 的竞速处理保持不变。若主智能体在收尾期间取消状态查询，companion 仍只丢弃这次响应；这不等于取消子任务。

## 5. 错误处理与兼容性

### 5.1 终态错误

`complete_call` 的 `DelegationOutcome::Err` 仍先写入 completed cache，再按既有规则报告 `Failed` 或 `Canceled`。提前唤醒只改变 waiter 何时看到这个报告，不改变 `error_code`、`message`、`child_conversation_id` 或 `duration_ms`。

`finalize_delegation` 当前的 meta writer、event emitter 和 disconnect 都是尽力执行；其中任一外部动作慢或失败，都不能回退已写入的 completed cache，也不能让状态 waiter重新变成 `Running`。收尾继续完成其余动作，并保留现有错误吞并行为。

### 5.2 协议兼容性

本设计不改变：

- `get_delegation_status` 的工具名称、参数名和 `{ "tasks": [...] }` 响应形状；
- `DelegationTaskReport` 字段和状态枚举；
- `wait_ms` 的三种映射和 60000 毫秒上限；
- `task_ids` 的去重、请求顺序和批量报告规则；
- token 校验、父连接作用域和 DB fallback；
- companion 的取消响应抑制行为；
- UDS / Windows 命名管道帧格式。

对调用方可见的变化只有：终态达到后，长轮询更早返回。正数 `wait_ms` 仍是“最多等待指定时长”，不会因为提前唤醒而违反协议；`wait_ms = 0` 仍不设置超时。

### 5.3 崩溃与重启

移动唤醒不增加持久化数据。进程在完成缓存写入后、终态收尾前崩溃时，内存缓存和当前进程的 waiter 都会按现有进程生命周期消失；重启后的状态仍使用原有 DB fallback 和子会话恢复规则。该设计不承诺跨进程恢复，也不改变 DB 状态写入时序。

## 6. 测试方案

本方案只描述后续实施测试；本次提交不修改 Rust 测试代码。

### 6.1 核心回归测试

在 `src-tauri/src/acp/delegation/broker.rs` 的现有 broker 单元测试中增加一个测试，例如：

`complete_call_wakes_status_waiter_before_slow_finalize`

测试必须使用两个测试门闩，避免用固定睡眠证明竞态：

1. **状态快照门闩**：注入一个 test-only `ChildLiveReplyLookup`，在 `blocked_on` 被 `get_tasks_status` 调用时发出 `status_probe_entered`，随后等待测试释放。这个信号证明 waiter 已经在 `running` 快照之后、重新等待之前的路径上。
2. **收尾门闩**：注入一个 test-only `DelegationMetaWriter`，对 `running` meta 立即返回，对终态 meta 发出 `finalize_entered` 后阻塞。这样 `finalize_delegation` 已开始但尚未结束。

测试步骤和断言：

1. 构造可注入 writer、live-reply lookup 和 `MockSpawner` 的 broker，启动一个 `Running` 任务并取得 `task_id`。
2. 启动 `StatusWait::Infinite` waiter，等待 `status_probe_entered`，确保它已经看过 `Running`。
3. 在独立任务中调用 `complete_call`，等待 `finalize_entered`，证明完成调用已经进入慢收尾门闩。
4. 释放状态快照门闩，让 waiter 继续到等待点。
5. 在**不释放收尾门闩**的情况下，用短 `timeout` 等待 status waiter；新实现必须返回 `Completed` 和预期结果文本，且 `complete_call` 仍未结束。
6. 断言 status waiter 返回后，收尾门闩仍然有效；随后释放收尾门闩，等待 `complete_call` 完成。
7. 最后检查 completed cache、一次 disconnect 和既有 meta / event 行为，确保提前返回没有跳过收尾。
8. 测试失败或超时的清理路径也必须释放两个门闩并回收 spawned task，不能把挂起任务泄漏到同一测试运行时。

旧顺序下，第 5 步会在超时内拿不到报告，因为 `complete_call` 被收尾门闩卡住且尚未调用 `notify_waiters()`；因此该测试能直接区分新旧顺序。

### 6.2 语义回归矩阵

| 范围 | 验证内容 | 通过条件 |
| --- | --- | --- |
| 完成 waiter | 慢 meta / 事件 / disconnect 时的 `Infinite` 等待 | cache 可读后先返回终态，收尾随后完成 |
| 立即快照 | 省略 `wait_ms` | 任务运行时立即返回 `Running`，不等待完成 |
| 正数等待 | `Bounded` 无完成与有完成两种情况 | 无完成到 deadline 返回 `Running`；有完成在 deadline 前返回终态 |
| 无限等待 | `wait_ms = 0` | 任务运行时保持等待；收到终态迁移后通过通知和二次快照返回 |
| 批量完成 | 一个任务完成、一个任务仍运行 | 按请求顺序返回 `Completed` 与 `Running`，不等兄弟任务 |
| 批量入口终态 | 进入查询前已有终态 | 立即返回，不被运行中的兄弟任务阻塞 |
| 取消 | MCP 取消、子连接断开、父连接取消、按 task id 取消 | 返回 `Canceled`，缓存、事件、disconnect 次数与现有测试一致 |
| setup 竞态 | setup 阶段 child terminal / parent cancel | `early_*` 和 first-terminal-wins 结果不变 |
| 作用域 | 其他父连接查询同一 task id | 仍返回 `Unknown` |

优先复用现有测试覆盖，再运行新增核心回归测试。重点既有测试包括 `infinite_wait_parks_until_terminal`、`batch_infinite_returns_when_any_settles`、`batch_bounded_deadline_returns_running_snapshot`、父级取消和 external handle 取消相关测试，以及 meta-before-event 的顺序测试。

### 6.3 检查命令

后续实现完成后，在 `src-tauri/` 执行：

```bash
cargo test --features test-utils
cargo clippy --all-targets --features test-utils -- -D warnings
```

如只验证核心回归，可先使用包含测试名的 cargo filter，再执行完整测试。listener 和 companion 没有逻辑改动，但完整测试应覆盖它们的编译和既有 wait / round trip 测试。

## 7. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 主智能体先收到终态，父 UI meta 仍短暂显示运行中 | 状态查询与 UI 卡片存在短暂时间差 | 保留 meta → event → disconnect 顺序；日志记录缓存唤醒和收尾完成两个阶段；收尾仍由原调用继续执行 |
| 提前唤醒造成多个 waiter 同时重查 | 短时增加 pending lock 和报告组装工作 | 这是 `Notify` 当前广播语义的既有成本；重查只发生在真实终态事件后，且每个 waiter 只返回自己的请求 |
| waiter 在收尾期间看到子连接仍存在 | 主智能体先取得结果，子会话可能尚未断开 | completed cache 是状态查询的既有数据源；disconnect 仍在同一个 `complete_call` 中随后执行 |
| 通知与快照竞态引入偶发旧状态 | waiter 可能继续显示 Running | 保留快照前 `Notified::enable`，唤醒后必须重新持锁分类；回归测试用门闩覆盖顺序 |
| 误把取消或 setup 终态也改成新顺序 | 取消卡片、事件次数或 setup 竞态变化 | 第一版只移动 `complete_call` 的成功 running→completed 通知点，其他终态路径不重构；运行取消和 setup 回归矩阵 |
| 日志泄漏任务正文 | 日志体积或敏感信息增加 | 只记录 id、状态和阶段字段，不记录 task/result 文本 |

## 8. 回滚方案

这是内存通知顺序调整，无数据库迁移和协议版本变更。若上线后发现 UI 收尾时间差或并发负载问题：

1. 恢复 `complete_call` 中“先执行 `finalize_delegation`、再调用 `notify_waiters()`”的旧顺序；
2. 同步恢复对应的顺序注释和阶段日志；
3. 保留回归测试，确认它在回滚版本上按预期暴露旧的等待行为，再决定是否调整方案；
4. 重新执行 broker 测试和 clippy。

回滚不需要清理缓存数据、不需要改数据库，也不需要升级 companion 与 listener 的 wire 版本。

## 9. 实施顺序

1. 在 `broker.rs` 中更新 `complete_call` 的注释和顺序：原子迁移后释放锁，立即 `notify_waiters()`，再调用 `finalize_delegation`。
2. 增加阶段日志，确认日志字段不包含 task/result 正文。
3. 增加慢收尾门闩回归测试，先验证 `Infinite` waiter，再复用现有批量、取消和 `wait_ms` 测试。
4. 执行完整 Rust 测试与 clippy，检查 `git diff --check`。
5. 观察日志中的 `completed_cache_visible` 与 `finished` 两个阶段，确认状态响应可以先于收尾完成返回。

## 10. 自审结论

- 已明确当前根因、目标顺序和 waiter 二次确认动作。
- 已区分 completed cache 可见性与父 meta、完成事件、子连接断开的收尾责任。
- 已写明 `wait_ms` 省略、正数、零值，批量查询和取消路径的兼容要求。
- 已给出不依赖固定睡眠的回归测试同步方式，并说明旧顺序为何会失败。
- 已列出日志字段、风险和可逆的回滚步骤；文档没有未决占位项。
