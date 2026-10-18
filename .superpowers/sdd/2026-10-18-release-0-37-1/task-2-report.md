# Task 2：升级到 0.37.1 报告

## 文件已更改

- `package.json`：应用版本更新为 `0.37.1`。
- `src-tauri/Cargo.toml`：Rust 包版本更新为 `0.37.1`。
- `src-tauri/tauri.conf.json`：Tauri 应用版本更新为 `0.37.1`。
- `src-tauri/Cargo.lock`：同步根包 `codeg` 的锁定版本为 `0.37.1`。

## 摘要

Task 2 已将三个应用版本字段统一为 `0.37.1`。当前基线中的三个字段实际为
`0.36.1`，因此按发布目标直接升级到 `0.37.1`。Cargo 校验只同步了根包版本，未改变无关依赖。

搜索结果中的旧版本引用均为允许保留的历史或说明性内容：Task 1 报告和发布计划中的上游
`v0.37.0`、`Cargo.lock` 中无关的 `cssparser 0.37.0`，以及源码中描述兼容性范围或历史行为的注释。
没有文件继续把 `0.37.0` 作为当前应用发布版本。

## 命令与结果

- `cargo check`（`src-tauri/`）：通过；同步了 `Cargo.lock` 中根包 `codeg` 的版本。
- `cargo check --locked`（`src-tauri/`）：通过；确认锁定依赖可用。
- Python `json.loads` / `tomllib.loads`：通过；`package.json`、`tauri.conf.json`、`Cargo.toml` 均可解析，三个版本均为 `0.37.1`。
- `git grep -n -e '0\.37\.0' -e 'v0\.37\.0' -- ':!node_modules' ':!src-tauri/target'`：通过；仅发现上述历史、依赖和说明性引用。
- `git diff --check`：通过。

## 风险

- 工作树中仍存在合法的 `0.37.0` 文本引用；它们不是应用版本元数据，删除会破坏历史记录或说明语义。
- 未执行完整前端测试、完整 Rust 测试或多平台构建；本任务仅做版本字段和锁文件同步及轻量校验。
- 未执行任何远程推送操作。
