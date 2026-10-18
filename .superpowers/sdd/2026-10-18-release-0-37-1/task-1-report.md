# Task 1 合并报告

## 执行范围

本报告对应计划 `docs/superpowers/plans/2026-10-18-release-0-37-1.md` 的 Task 1。
本次只完成上游 `v0.37.0` 合并、冲突处理和合并门禁核对。版本升级、完整发布门禁、远程推送和发布标签操作不属于本次范围。

## 上游来源核对

- 上游仓库：`https://github.com/spacering-net/codeg.git`
- 上游标签：`v0.37.0`
- 核对提交：`2ae6eaf7dc2e9b8bba58d8b67a629f471204b1d1`
- 获取命令：`git fetch origin refs/tags/v0.37.0:refs/tags/v0.37.0`
- 核对结果：`git rev-list -n 1 v0.37.0` 与指定提交完全一致。

当前远程配置中，`origin` 指向上述上游仓库；fork 的推送远程为 `my-github`，本次未使用任何推送命令。

## 合并结果

在分支 `worktrees/wt_release_0_37_1` 执行了计划要求的命令：

```text
git merge --no-edit 2ae6eaf7dc2e9b8bba58d8b67a629f471204b1d1
```

合并前当前 fork 提交为 `07e4ce7a`（`fix: restore Windows arm64 release asset`）。合并结果保留当前 fork 提交作为第一父提交，并使用指定上游提交作为第二父提交。上游新增和自动合并内容共计 75 个文件、9842 行新增、1066 行删除。

### 冲突处理

合并产生了 5 个冲突文件：

- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `src-tauri/tauri.conf.json`
- `src/components/conversations/conversation-detail-panel.tsx`

版本字段冲突均保留 fork 当前的 `0.36.1`。这是因为本次只执行 Task 1，计划中的 `0.37.1` 版本升级属于后续 Task 2；锁文件中的 `codeg` 根包版本同步保留为 `0.36.1`。

会话详情面板冲突保留上游新增的 `messageListNode` 语义和 `insightsInSidebar` 属性，并移除所有 Git 冲突标记。其余上游新增文件和自动合并修改均纳入合并结果。

合并后的首次前端回归发现冲突拼接导致 `MessageListView` 在同一组件中重复挂载。已删除重复节点，并把上游的 `insightsInSidebar` 属性合并到 fork 原有节点；针对性测试 `message-list-image-root.test.ts` 通过 4/4。

## Fork 发布修复保留情况

合并后逐项核对如下：

- Windows 依赖保留：`webview2-com = { version = "0.39", ... }`、`windows = { version = "0.62", ... }`。
- opener 版本保留：`package.json` 中 `@tauri-apps/plugin-opener` 为 `^2.7.2`；Rust 侧仍声明 `tauri-plugin-opener` 版本线 `2`。
- Tauri 桌面矩阵保留 6 个 target：
  - `x86_64-apple-darwin`
  - `aarch64-apple-darwin`
  - `x86_64-unknown-linux-gnu`
  - `aarch64-unknown-linux-gnu`
  - `x86_64-pc-windows-msvc`
  - `aarch64-pc-windows-msvc`
- `build-tauri` 和 `build-server` 矩阵均保留 `fail-fast: false`。
- Windows arm64 条目仍存在，未被上游合并删除。
- `generate-updater-manifest` 仍存在，并要求 `create-draft-release`、`build-tauri`、`build-server` 成功；`publish-release` 仍要求 updater manifest job 成功后才能发布。
- 合并后的 `.github/workflows/release.yml` 与合并前 fork 版本无差异，说明发布 workflow 修复没有被上游覆盖。
- `package.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 和 `src-tauri/tauri.conf.json` 相对合并前 fork 版本没有除冲突保留以外的变化。

## 已执行验证

以下检查均通过：

1. `git fetch` 后的上游标签 SHA 校验。
2. `git diff --cached --check`。
3. Git 冲突标记扫描，结果为 `conflict-markers=none`。
4. JSON、Cargo 清单、锁文件和 release workflow 的结构化核对。
5. 受保护发布文件相对 fork 合并前版本的差异核对，结果为 `fork-protected-files=unchanged`。

额外执行的测试结果如下：

- `vitest src/components/message/message-list-image-root.test.ts`：通过 4/4。
- `pnpm test`：两次全量运行均为 676 个测试文件中 675 个通过、1 个失败（10141/10142）。失败始终位于上游新增或修改的 `sidebar-tag-filter.test.tsx` 键盘焦点用例组，但单独运行该文件和目标用例通过；失败用例在全量运行中因焦点/时序状态不稳定而轮换，未发现可安全归因的确定性业务根因。
- `cargo test --features test-utils`：未通过构建前置检查。构建脚本报告本地缺少 `out` 目录和两个 sidecar 文件，并因此退出；日志未报告 Rust 源码编译错误。

本次未执行计划中的 Task 2 版本升级、Task 3 中除测试外的本地发布门禁、Task 4 远程推送和浏览器发布验收。

## 操作边界

- 未合并上游 `main`。
- 未推送任何远程分支或标签。
- 未创建或推送 `v0.37.0`。
- 未修改主工作树中的 `tsconfig.json` 或 `.codegraph/`。
