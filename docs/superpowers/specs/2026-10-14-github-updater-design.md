# GitHub 自动更新源切换与更新签名密钥重建设计

## 状态

设计已获用户确认（2026-10-14）。本文件只覆盖设计；密钥生成、工作流改动、代码改动与文档更新留待实施计划执行。

## 一、现状与问题

Codeg 的自动更新链路目前处于「代码在、产物不在、源还是旧的」状态：

1. **桌面端**：`src-tauri/tauri.conf.json` 的 `plugins.updater` 已启用，但
   - `endpoints` 指向 `https://github.com/spacering-net/codeg/releases/latest/download/latest.json`；
   - `pubkey` 是上一代 minisign 公钥。
2. **发布流水线**：`.github/workflows/release.yml` 主动关掉了签名与更新清单：
   - `build-tauri` 的四个桌面构建步骤（Windows、Linux x64、Linux arm64、macOS）都通过 `--config '{"bundle":{"createUpdaterArtifacts":false...}}'` 关闭 updater 产物，并设 `includeUpdaterJson: false`；
   - `create-draft-release` 的发布说明与 `publish-release` 日志明确写「免费桌面和服务器包不支持签名自动更新」，`docs/releasing/macos-self-signed.md` 同样写着 `bundle.createUpdaterArtifacts` 保持 false。
3. **服务器端**：自更新要求签名，但流水线从不产生签名：
   - `src-tauri/src/update/install.rs` 从 `version::RELEASE_DOWNLOAD_BASE` 下载 `codeg-server-<os>-<arch>.tar.gz|.zip` 与 `<同一路径>.sig`，再交给 `verify.rs::verify_release_signature` 验签；
   - `build-server` 只生成 `.sha256`（完整性校验，不是身份认证），从不生成 `.sig`。
4. **运行时常量**：`src-tauri/src/update/version.rs` 的 `UPDATE_MANIFEST_URL`、`RELEASE_DOWNLOAD_BASE` 与 `verify.rs` 内嵌的 `TAURI_PUBKEY_B64` 仍指向/来自旧仓库的旧密钥。
5. **仓库本体**：remote 已切到 `EvanZheng11/codeg`（`my-github`），但更新链路没有任何一处在跟：`tauri.conf.json`、服务器常量、`install.sh` / `install.ps1`、状态栏与设置页链接都还是 `spacering-net/codeg`。

**结论**：当前流水线产出的发布里既没有 `latest.json`，也没有任何 `.sig`。桌面检查更新会因清单缺失失败；服务器即使取到清单，也会在下载 `.sig` 或验签处失败。自动更新功能事实上整体不可用，更新源与签名密钥都需要一次性重建。

## 二、目标

- 更新源统一到 `EvanZheng11/codeg`：桌面 endpoint、服务器常量、安装脚本、桌面展示链接一致。
- 重建一套 Tauri/minisign 更新签名密钥：私钥只存在于本机密码管理器与 GitHub Actions Secret；仓库内只有公钥，且两处副本由测试强制一致。
- 发布流水线恢复三类产物：`latest.json`、桌面 `*.sig`、服务器 `*.sig`。
- 验签硬失败：缺签名、签名不匹配、清单缺字段一律拒绝安装，不降级到 SHA256。
- 发布说明与发布文档同步，写清旧密钥客户端需要手动升级一次。

## 三、方案

### 3.1 密钥生成与保管（实施阶段执行，本设计不生成）

生成命令（Tauri CLI，随 `@tauri-apps/cli` 提供）：

```bash
pnpm tauri signer generate -w ~/.tauri/codeg-updater.key
```

- **私钥** `~/.tauri/codeg-updater.key`（权限 600，建议设密码）：
  - 备份到本机密码管理器；
  - GitHub Actions Secret `TAURI_SIGNING_PRIVATE_KEY`（值为私钥文件的 base64 文本，与 Tauri 官方 CI 用法一致）与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。
- **公钥** `~/.tauri/codeg-updater.key.pub`：写入两处，值必须一致：
  - `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`（Tauri 要求的 base64 文本）；
  - `src-tauri/src/update/verify.rs` → `TAURI_PUBKEY_B64`。
- **防误提交**：`.gitignore` 增补 `*.key`、`*.key.pub`、`.tauri/` 忽略项；任何终端输出不得打印私钥内容。
- **轮换即断代**：客户端内嵌公钥，换了公钥后旧版本客户端无法验证新签名，必须手动安装一次才能回到自动更新通道（迁移策略见第八节）。

### 3.2 桌面：恢复 `*.sig` 与 `latest.json`

1. `build-tauri` 各平台：
   - 移除 `--config` 里的 `createUpdaterArtifacts:false`（`tauri.conf.json` 本身已是 `true`），保留 macOS 的 `hardenedRuntime:true`；
   - 给这些步骤注入 `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 环境变量，由 Tauri CLI 在打包时直接签出 updater 包（macOS `.app.tar.gz`、Windows NSIS `.exe`、Linux AppImage）与同名 `.sig`；
   - `includeUpdaterJson` 保持 `false`（清单由下一步单独生成）。
2. Linux arm64 桌面仍只打 `deb,rpm`（无 AppImage），不产出 updater 资产，`latest.json` 中不出现 `linux-aarch64` 条目（见第十节）。
3. **`latest.json` 生成方式（采用方案 A）**：
   - **A（采用）**：新增独立 job `generate-updater-manifest`（`needs: build-tauri, build-server`，`contents: write`）：列出 draft release 资产 → 逐个读取桌面 updater 包的 `.sig` 内容 → 一次性生成 `latest.json`（`version` 取 tag 对应 `tauri.conf.json` 的版本，无 `v` 前缀；`notes` 取发布说明；`pub_date` 取当前时间；平台键包含各目标的基础键 `{os}-{arch}` 与安装器后缀键 `-app` / `-nsis` / `-appimage`，URL 用 `releases/download/<tag>/<资产名>`）→ `gh release upload --clobber`。
   - **B（不采用）**：直接开 tauri-action 的 `includeUpdaterJson: true`。代码确实更少，但 6 个矩阵 job 会并发读改写同一个 `latest.json`：tauri-action 的 `upload-release-assets.ts` 是「删除同名资产再上传」，两个 job 只要在读取与上传之间重叠，后写者就会用自己那份平台表覆盖先写者，静默丢平台条目；同时也没有单一位置能对全部 `.sig` 做完整性门禁。
   - 方案 A 的 URL 指向当前 tag（不是 `latest`），因此清单内容与 release 一一对应，不依赖发布时机。

### 3.3 服务器：包签名

- `build-server` 在 Unix 打包出 `dist/<artifact>.tar.gz`、Windows 打包出 `dist/<artifact>.zip` 之后，用同一把密钥签名：

  ```bash
  pnpm tauri signer sign dist/<artifact>.tar.gz   # Windows 为 .zip
  ```

- 生成 `<artifact>.tar.gz.sig` / `<artifact>.zip.sig`，与既有 `.sha256` 一起作为资产上传到 draft release。
- 资产命名必须继续与 `install.rs::asset_basename()` 的五个平台（`codeg-server-{linux,darwin,windows}-{x64,arm64}`）一一对应，不得改名。
- Docker job 复用服务器构建产物，不涉及签名。

### 3.4 发布门禁与发布说明

- 新增门禁，统一放在 `generate-updater-manifest` job 内（它同时需要桌面与服务器产物）：
  - `latest.json` 存在，平台键集合等于预期集合（见第九节第 4 条）；
  - 每个桌面 updater 包都能在资产列表里找到同名 `.sig`；
  - 每个 `codeg-server-*` 包都有 `.sig`；
  - 缺任何一项 → `core.setFailed`，draft 不发布。
- 发布说明模板删除「不支持签名自动更新」，改为：
  - 本版本起支持签名自动更新；
  - 旧版本（旧密钥）需手动下载安装一次，之后恢复自动更新；
  - beta 版本不通过 `latest` 通道分发（见第七节）。

### 3.5 运行时与安装入口替换

| 位置 | 现状 | 目标 |
| --- | --- | --- |
| `src-tauri/tauri.conf.json` | endpoint 指向旧仓库；旧公钥 | endpoint、pubkey 切到新仓库/新密钥 |
| `src-tauri/src/update/version.rs` | 两个旧仓库常量 | 改为 `https://github.com/EvanZheng11/codeg/...` |
| `src-tauri/src/update/verify.rs` | 旧公钥常量 | 换新公钥；新增与 `tauri.conf.json` 的一致性测试 |
| `install.sh` / `install.ps1` | `REPO="spacering-net/codeg"`，取 `releases/latest` | 换新仓库 |
| `src/components/layout/status-bar-update.tsx` | `RELEASES_URL` 指向旧仓库 | 换新 |
| `src/components/settings/system-network-settings.tsx` | 项目页/发布页链接指向旧仓库 | 换新 |

## 四、涉及文件

| 文件 | 改动 | 范围 |
| --- | --- | --- |
| `src-tauri/tauri.conf.json` | endpoint 与 pubkey 切换 | 实施 |
| `src-tauri/src/update/version.rs` | 两个 URL 常量切换 | 实施 |
| `src-tauri/src/update/verify.rs` | 公钥常量切换 + 新增一致性测试 | 实施 |
| `.github/workflows/release.yml` | 恢复签名、新增 manifest job、发布门禁、发布说明 | 实施 |
| `src/components/layout/status-bar-update.tsx` | 发布页链接切换 | 实施 |
| `src/components/layout/status-bar-update.test.tsx` | 断言链接同步 | 实施 |
| `src/components/settings/system-network-settings.tsx` | 项目页/发布页链接切换 | 实施 |
| `install.sh` / `install.ps1` | `REPO` 常量切换 | 实施 |
| `docs/releasing/macos-self-signed.md` | 删除「不支持签名自动更新」表述 | 实施 |
| `.gitignore` | 增补签名材料忽略项 | 实施 |
| `docs/superpowers/specs/2026-10-14-github-updater-design.md` | 本设计文件 | 本次交付 |

## 五、数据流

### 5.1 桌面（新密钥版本已安装）

1. `tauri-plugin-updater` 请求 `https://github.com/EvanZheng11/codeg/releases/latest/download/latest.json`。
2. GitHub 302 到当前 latest（非 draft、非 prerelease）release 资产，返回 `{version, notes, pub_date, platforms}`。
3. 插件按 `{os}-{arch}`（及安装器后缀）命中条目，下载 `url`，取出 `signature`。
4. 用 `tauri.conf.json` 的 pubkey 验签；通过后安装（Windows `installMode=passive`）→ 重启。
5. 任一步失败（清单 404、平台条目缺失、验签失败）都中止，不安装。

### 5.2 服务器 / Docker

1. `check_app_update` → `version::fetch_latest_manifest()`（同一 URL）取 `version`，用 `is_newer` 与当前版本比较。
2. `perform_update` 下载 `{RELEASE_DOWNLOAD_BASE}/codeg-server-<os>-<arch>.tar.gz|.zip` 与 `<同路径>.sig`。
3. `verify.rs` 用内嵌公钥验签（外层 base64 解包 + minisign，允许 legacy 格式）；失败即中止。
4. 解压到数据卷临时目录 → 原子替换 `codeg-server`、`codeg-mcp`、`web/`，旧文件保留为 `.bak`。
5. 重启：有 supervisor 时以 `EXIT_RESTART` 退出并交给父进程；无 supervisor 时 re-exec。试用期内崩溃自动回滚。

### 5.3 发布流水线

```
tag push vX.Y.Z（或 workflow_dispatch 指定已有 tag）
  → create-draft-release：创建/复用 draft；prerelease = tag 含 "-"；校验 tag 与 tauri.conf.version 一致
  → build-tauri ×6：createUpdaterArtifacts=true + CI 私钥 → 各平台 updater 包 + *.sig 上传到 draft（Linux arm64 无 AppImage，不产出 updater 资产）
  → build-server ×5：打包 + tauri signer sign → *.tar.gz|.zip + *.sig + *.sha256 上传到 draft
  → generate-updater-manifest（新增，needs build-tauri + build-server）：汇总桌面 *.sig/URL → 生成并上传 latest.json → 执行全部签名门禁
  → build-docker（复用服务器产物）
  → publish-release（needs 包含 generate-updater-manifest）：门禁通过则 draft=false
  → 仅 stable tag：releases/latest/download/latest.json 可用
```

## 六、签名密钥安全边界

- **私钥只在两处**：本机密码管理器（文件权限 600，建议带密码）；GitHub Actions Secret。仓库、Actions 日志、构建产物中不得出现私钥内容。
- **Secret 暴露面**：仅 `release.yml` 使用，`test.yml` 不接触；release 只在 `main` push、tag push、`workflow_dispatch` 触发，不接受 fork PR 输入；工作流内禁止回显私钥。
- **公钥是公开信息**：允许出现于 `tauri.conf.json` 与 `verify.rs`，但两处必须一致；不一致会导致「清单里的签名与端上验签公钥对不上」的硬失败（安全上仍会拒绝安装，排查上很隐蔽），因此用测试直接比对 `tauri.conf.json` 中的 pubkey 与 `verify.rs` 常量。
- **签名点与验证点**：签名只在 CI（桌面由 Tauri 打包器、服务器由 `tauri signer sign`）；验证只在客户端（桌面插件、服务器 `verify.rs`）。
- **硬失败**：无 `.sig`、签名不匹配、清单缺 `signature` 字段 → 拒绝安装。SHA256 仅用于完整性校验，绝不作为身份认证的替代。
- **密钥泄露处置**：立即生成新密钥对并走一次断代（同第八节）；已发布版本的信任无法撤回，只能要求用户手动升级，所以私钥必须设密码并最小化使用范围。
- **旧密钥可用时的平滑迁移（可选）**：在旧仓库发布一个「过渡版本」，用旧密钥签名、内嵌新公钥与 `EvanZheng11/codeg` endpoint；旧客户端自动更新到过渡版本后即可无感接入新通道。是否可行取决于旧私钥是否仍可取得，默认按断代方案执行。

## 七、beta tag 限制

- **事实链**：`create-draft-release` 对 tag 含 `-` 的版本设 `prerelease: true`；GitHub 的 `GET /releases/latest` 只返回「已发布、非 prerelease、非 draft」的最新 release，`releases/latest/download/<asset>` 同理。因此 beta tag 的 `latest.json` 与服务器包虽然都完整带上，却不会被 `latest` 通道命中；客户端更新检查得到 404（桌面显示更新源不可用，服务器报 network 错误）。
- **不采用的绕过方式**：把 beta 发布为非 prerelease，让 `latest` 指向 beta。这会让 stable 用户被推送 beta，并让 `latest` 指针偏离 stable，语义错误。
- **本次决策**：接受 beta 窗口内自动更新不可用。beta 的签名与清单照常生成，可用直链 `releases/download/<beta tag>/latest.json` 和 `<tag>/<asset>.sig` 做流水线验证与人工安装。
- **恢复时点**：首个 stable 发布（建议 `v0.35.1`）落地后，`releases/latest` 立即生效。semver 保证 `0.35.1-beta.1 < 0.35.1`，已装新密钥 beta 的客户端能自动更新到该 stable；beta → 另一个 beta 则始终需要手动安装。
- beta 通道机制（channel 参数、独立 beta 指针 release、端点覆盖）列入未包含范围。

## 八、兼容性风险

1. **密钥断代**：旧版本客户端内嵌旧公钥，无法验证新签名，必须手动安装一次新版本；这是本方案无法消除的一次性成本（可选过渡版本见第六节）。
2. **旧客户端仍指向旧仓库**：切源后旧客户端继续查询 `spacering-net/codeg`；该仓库若保留旧 `latest.json`，旧客户端可能反复提示同一版本，或安装旧仓库仍在分发的旧版本（semver 不会降级）；若仓库被归档/清空，则更新检查报「更新源不可用」。两种情况都无法自动跨到新通道，发布说明必须给出手动下载地址。
3. **`latest.json` 平台键错漏**：客户端拿不到对应平台条目会表现为「没有更新」或下载失败。由生成器统一产出 + 门禁校验键集合来消除。
4. **Linux arm64 桌面缺口**：无 AppImage，`latest.json` 无 `linux-aarch64` 条目，该平台继续手动安装（见第十节）。
5. **Windows 双架构**：x64 与 arm64 的 NSIS 资产名不同，`latest.json` 两个键必须分别正确，避免 arm64 用户命中 x64 包。
6. **Secret 缺失必须硬失败**：若 `createUpdaterArtifacts` 开启而私钥缺失，构建应失败；门禁不得把未签名包发出去。
7. **服务器资产命名回归**：`install.rs::asset_basename()` 与 workflow `artifact` 名必须继续一一对应，改名会让自更新 404。
8. **发布顺序**：`latest.json` 必须在全部桌面 `.sig` 上传后生成，且 `publish-release` 必须 gate 住它，否则会出现「清单指向不存在的资产」。
9. **CDN 短缓存**：`releases/latest/download/...` 由 GitHub 302 重定向，发布后立即验证可能短暂命中旧内容。
10. **网络与代理**：更新路径形态不变（仍是 `releases/latest/download/...`），现有超时、代理采样逻辑无需改动。

## 九、验证标准

1. **密钥**：生成密钥对后，`cargo test --features test-utils` 通过（`verify.rs` 既有测试 + 新增 pubkey 一致性测试）；本地用 `tauri signer sign` 签一个临时文件并用独立 minisign 校验通过。
2. **前端**：`pnpm lint .`、`pnpm test`（链接断言已更新）、`pnpm build` 通过。
3. **CI 干跑**：`gh workflow run release.yml`（tag 留空）时各桌面 job 能产出 `.sig`；在分支上做一次「不配私钥」的对照，确认构建按预期失败（验证后不留分支）。
4. **全量发布检查**（stable tag 发布后）：
   - `curl -sI https://github.com/EvanZheng11/codeg/releases/latest/download/latest.json` 返回 200；
   - `latest.json` 平台键集合 = 预期集合（`darwin-x86_64`、`darwin-aarch64`、`windows-x86_64`、`windows-aarch64`、`linux-x86_64` 及对应安装器后缀键）；
   - 每个桌面上传器包都有同名 `.sig`；每个 `codeg-server-*` 包都有 `.sig`。
5. **桌面端到端**：新密钥版本安装后能读到新版并完成下载/重启/版本变化；旧密钥版本检查更新明确失败并提示手动下载（预期行为）。
6. **服务器端到端**：新版本服务器自更新成功并重启；把下载的包篡改 1 字节或替换 `.sig` 后，更新必须被拒绝且磁盘文件不被替换。
7. **文档回归**：`docs/releasing/macos-self-signed.md` 与发布说明中不再出现「不支持签名自动更新」的表述。
8. **beta 验证**：发一个 beta tag，`.sig` 与 `latest.json` 均已生成；`releases/latest` 未指向该 beta（符合第七节预期）。

## 十、未包含范围

- beta 通道的自动更新机制（channel 参数、端点覆盖、独立 beta 指针 release）。
- linux-aarch64 桌面 AppImage 构建与对应 updater 条目。
- README 与 `docs/readme/` 多语言链接、`merge.sh` / `scripts/test-merge.py` 的上游同步配置（避免与上游合并冲突）。
- 旧密钥客户端的强制升级、遥测与过渡版本（过渡版本仅在旧私钥可取得时另行决定）。
- SHA256 校验流程与安装器 UI 改造（保持原样）。
- 密钥托管服务（Vault/KMS）与签名审计日志。
