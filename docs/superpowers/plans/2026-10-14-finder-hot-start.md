# Finder 已运行实例目录导入修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 让 macOS Finder／超级右键在 Codeg 已运行时也能把目录送入现有导入和新会话流程。

**架构：** 在已有 Tauri 深链回调中转发 `file://` URL 到现有 macOS 目录队列，同时保留 `RunEvent::Opened` 的冷启动入口。两个系统入口可能为同一次 LaunchServices 事件同时触发，因此在目录事件边界增加短时间去重；用户稍后再次打开同一目录仍创建新会话。

**技术栈：** Rust、Tauri 2、`url`、现有 `OpenedPathQueue` 单元测试。

## 全局约束

- 复用 `src-tauri/src/macos/opened_paths.rs` 与现有前端监听，不新增业务接口。
- 只处理本地、存在且为目录的 `file://` URL。
- 日志与注释使用中文，保留现有错误处理和重试机制。
- 不修改当前工作区已有的 `tsconfig.json`。

---

### 任务 1：先覆盖重复入口与已运行入口

**文件：**

- 修改：`src-tauri/src/macos/opened_paths.rs`
- 修改：`src-tauri/src/lib.rs`
- 测试：`src-tauri/src/macos/opened_paths_test.rs`

**接口：**

- `lib.rs` 的 `on_open_url` 回调把 `event.urls()` 交给 `macos::opened_paths::handle_opened_urls`。
- `handle_opened_urls` 保持现有路径校验、队列和广播接口不变。

- [ ] **步骤 1：** 增加一个可测试的短窗口重复事件判断，验证同一路径在窗口内只保留一次，窗口过后可再次接收。
- [ ] **步骤 2：** 在 `on_open_url` 的 macOS 分支转发 `file://` URL，`codeg://` 仍交给原深链解析。
- [ ] **步骤 3：** 运行 Rust 目录事件测试，确认新增判断通过且原有队列、重试测试不回归。
- [ ] **步骤 4：** 提交：

```bash
git add src-tauri/src/lib.rs src-tauri/src/macos/opened_paths.rs src-tauri/src/macos/opened_paths_test.rs
git commit -m "fix: 支持已运行实例接收 Finder 目录"
```

### 任务 2：全量相关验证

**文件：**

- 验证：`src-tauri/src/lib.rs`
- 验证：`src-tauri/src/macos/opened_paths.rs`

- [ ] **步骤 1：** 运行 `cargo test --features test-utils macos::opened_paths`。
- [ ] **步骤 2：** 运行 `cargo check`。
- [ ] **步骤 3：** 运行 `git diff --check` 并检查最终 diff，仅保留本需求相关文件。
