# AGENTS.md

This file provides guidance to Code Agent when working with code in this repository.

## 项目概述

Codeg（Code Generation）是一个多智能体编码工作台，它将多个智能体（Claude Code、Codex CLI、OpenCode、Gemini CLI、OpenClaw、Cline 等）统一到一个工作区中，支持会话聚合和多智能体协作，支持桌面安装，服务器/Docker 部署。

## 技术栈

- **桌面运行时**: Tauri 2（Rust 后端 + webview 前端）
- **服务器运行时**: 独立 Rust 二进制（Axum HTTP + WebSocket）
- **前端**: Next.js 16（静态导出模式）+ React 19 + TypeScript（strict）
- **样式**: Tailwind CSS v4 + shadcn/ui（radix-maia 风格）
- **国际化**: next-intl
- **数据库**: SeaORM + SQLite
- **包管理器**: pnpm

## 代码检查与测试（任务完成后进行必要的检查）

### 前端

```bash
pnpm lint .                    # lint
pnpm test                      # vitest 全跑（CI 用同一条命令）
pnpm test:watch                # 开发时增量重跑
pnpm test:coverage             # 覆盖率报告（输出到 coverage/index.html）
pnpm build                     # 静态导出构建
```

### 后端 Rust（在 `src-tauri/` 目录下执行）

```bash
# 桌面模式（默认 feature）
cargo check
cargo test --features test-utils
cargo clippy --all-targets --features test-utils -- -D warnings

# 服务器模式
cargo check --no-default-features --features server-bin --bin codeg-server
cargo test --no-default-features --features server-bin --bin codeg-server --lib
cargo clippy --no-default-features --features server-bin --bin codeg-server --lib -- -D warnings

# codeg-mcp 协作伴生进程（多智能体委托）
cargo check --no-default-features --features mcp-bin --bin codeg-mcp
cargo clippy --no-default-features --features mcp-bin --bin codeg-mcp -- -D warnings

# 解析器快照评审（输出变化时）
cargo insta review
INSTA_UPDATE=auto cargo test --features test-utils     # 自动写新 .snap
```

## 架构

### 双模式运行

项目通过 Cargo feature flags 支持三种二进制：

- **`codeg`**（`tauri-runtime`，默认）：完整桌面应用，包含 Tauri 窗口管理、系统通知、自动更新等
- **`codeg-server`**（`--no-default-features --features server-bin`）：独立服务器模式，仅编译 Axum HTTP API + WebSocket
- **`codeg-mcp`**（`--no-default-features --features mcp-bin`）：per-launch stdio MCP 伴生进程，被注入到代理 CLI 的 MCP 配置中，向 LLM 暴露**异步**子智能体委托工具。

后两个（以及 `codeg-computer-helper` 的 `computer-helper`）各要一个默认不开的 feature：Tauri CLI 会把所有 feature 已开的二进制目标打进桌面安装包，不开就不进包。

### 共享核心

- **`app_state.rs`** — `AppState` 共享状态结构，两种模式通过 `EventEmitter` 枚举区分事件发射方式
- **`web/event_bridge.rs`** — `EventEmitter::Tauri(AppHandle)` 或 `EventEmitter::WebOnly(Arc<WebEventBroadcaster>)`
- **`web/router.rs`** — Axum 路由，接受 `Arc<AppState>`
- **`web/handlers/`** — HTTP API 端点，全部使用 `Extension<Arc<AppState>>`

### Rust 后端（`src-tauri/src/`）

后端负责读取和解析本地文件系统上的代理会话文件：

- **`app_state.rs`** — 共享状态（db、连接管理器、终端管理器、事件广播器）
- **`models/`** — 共享数据结构
- **`parsers/`** — 每个智能体一个解析器
- **`commands/`** — 业务逻辑，`_core` 函数供两种模式共用，`#[tauri::command]` 函数仅桌面模式
- **`web/`** — Axum HTTP API + WebSocket + 静态文件服务 + 认证中间件
- **`acp/`** — Agent Client Protocol 连接管理
- **`db/`** — SeaORM + SQLite

### 前端（`src/`）

#### 核心库（`lib/`）

- **`transport/`** — Transport 抽象层（自动检测 Tauri/Web 环境切换 `invoke()`/`fetch()`）
- **`adapters/`** — AI 响应到组件渲染的适配器
- **`types.ts`** — Rust 模型的 TypeScript 镜像
- **`api.ts`** — 主 API 客户端
- **`tauri.ts`** — Tauri API 封装

#### 国际化（`i18n/`）

- 支持 10 种语言：英语、简体中文、繁体中文、日语、韩语、西班牙语、德语、法语、葡萄牙语、阿拉伯语
- 使用 next-intl 框架，消息文件存放在 `i18n/messages/`

### 数据流

桌面模式：前端 `invoke()` → Tauri 命令 → 业务逻辑 → 返回数据
服务器模式：前端 `fetch()` → Axum HTTP API → 同一业务逻辑 → 返回 JSON
实时通信：后端事件 → EventEmitter（Tauri 事件 / WebSocket 广播）→ 前端

### 条件编译约定

- `#[cfg(feature = "tauri-runtime")]` — 仅桌面模式编译（Tauri 窗口、通知、`tauri::State` 参数等）
- `#[cfg_attr(feature = "tauri-runtime", tauri::command)]` — 函数始终可用，仅在桌面模式标记为 Tauri 命令
- `_core` 后缀函数 — 接受普通引用参数（`&AppDatabase`、`&EventEmitter`），供 Web handlers 和 Tauri 命令共用

## 关键约束

- **仅支持静态导出**：`next.config.ts` 设置 `output: "export"`，不支持动态路由（`[param]`），必须使用查询参数替代
- **路径别名**：`@/*` 映射到 `./src/*`，导入写法为 `@/lib/utils`、`@/components/ui/button`
- **服务器部署**：通过环境变量配置（`CODEG_PORT`、`CODEG_HOST`、`CODEG_TOKEN`、`CODEG_DATA_DIR`、`CODEG_STATIC_DIR`）
- **Docker 支持**：多阶段构建（Node.js + Rust），支持 `docker-compose` 一键部署

## 代码风格

- Prettier：无分号、尾逗号（es5）、2 空格缩进、80 字符宽度
- ESLint：next/core-web-vitals + typescript + prettier
- TypeScript：strict 模式，启用 `noUnusedLocals` 和 `noUnusedParameters`
- Rust：2021 edition，使用 `thiserror` 定义错误类型

## 多平台发布与打包经验

发布新版本时，必须把 Linux、Windows、macOS 的桌面包、服务器包、Docker、updater manifest 和最终 Release 当成一个整体验证。只看到某几个矩阵 job 成功，不能视为发布完成。

### 发布前固定检查

- 先对照原版仓库的 `release.yml`，确认本仓库的构建矩阵、依赖版本和发布门禁没有被旧配置覆盖。
- `build-tauri` 矩阵必须包含 6 个目标：
  - `x86_64-unknown-linux-gnu`
  - `aarch64-unknown-linux-gnu`
  - `x86_64-pc-windows-msvc`
  - `aarch64-pc-windows-msvc`
  - `x86_64-apple-darwin`
  - `aarch64-apple-darwin`
- 矩阵必须设置 `fail-fast: false`，避免一个平台失败时取消其它平台，方便区分代码问题和 runner 问题。
- Windows arm64 不能遗漏；updater manifest 要求 `codeg_<版本>_arm64-setup.exe`。
- 发布同一版本的修复时，确认远程 `v<版本>` 标签指向最终提交，再触发对应 workflow，避免 workflow 使用旧提交。

### 依赖版本必须保持同一主线

- `src-tauri/Cargo.toml` 中 `tauri-plugin-opener` 使用 `2`，不要固定到与 npm 插件不一致的旧 Rust 版本。
- `package.json` 中 `@tauri-apps/plugin-opener` 使用 `^2.7.2`，并让 `pnpm-lock.yaml` 与它一致。
- Windows 依赖使用 `webview2-com 0.39` 和 `windows 0.62`，避免 `windows-core 0.61` 与 `0.62` 同时进入同一编译路径，产生 `ICoreWebView2Environment` 类型不匹配。
- 修改版本后必须同时更新 `src-tauri/Cargo.lock` 和 `pnpm-lock.yaml`，不能只改 manifest 文件。

### updater manifest 门禁

- 以 `src-tauri/scripts/generate-updater-manifest.mjs` 的 `expectedAssets()` 为唯一资产命名依据，不要凭经验手写名称。
- 当前必须存在这些桌面 updater 资产及同名 `.sig`：macOS x64、macOS arm64、Linux x64、Windows x64、Windows arm64；manifest 会为基础键和安装器后缀键建立 10 个平台键。
- 每个服务器 `.tar.gz` 或 `.zip` 包也必须有同名 `.sig`。
- 6 个桌面矩阵全部成功并上传资产后，才运行 `Generate updater manifest`；manifest 成功后才允许 `publish-release`。
- manifest job 失败时，优先检查缺失的资产名或签名名，再修改代码。不要用手工补文件绕过门禁。

### 本地验证门禁

在推送发布标签前，至少执行：

```bash
cargo metadata --manifest-path src-tauri/Cargo.toml --locked --no-deps --format-version 1
cargo tree --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc -e normal -i webview2-com@0.39.1
cargo check --manifest-path src-tauri/Cargo.toml --locked --features mcp-bin,computer-helper
git diff --check
```

同时解析 `.github/workflows/release.yml`，断言 6 个 Tauri target、`fail-fast: false` 和 Windows arm64 资产均存在。发布配置变更后，必须保留用户已有的 `tsconfig.json`、`.codegraph/` 等工作树变更。

### CI 结果判读

- GitHub macOS runner 可能因容量不足排队较久；页面显示 queued 或 capacity constraints 且没有失败日志时，应继续等待，不要立即改代码。
- `System.IO.IOException: A device which does not exist was specified` 这类 runner 文件系统错误属于基础设施瞬时故障；先重跑失败 job，只有重跑仍出现相同代码错误时才修改配置。
- GitHub Actions 的 Node.js 20 deprecation annotation 是警告，不是构建失败原因。
- 最终完成条件是 Run 显示 `Success`，`build-server` 为 5/5，`build-tauri` 为 6/6，Docker、updater manifest、`publish-release` 均成功，并在 GitHub Release 页面核对资产数量和 Windows arm64 资产存在。

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
