# 自动更新签名密钥（Tauri/minisign）

本仓库（`EvanZheng11/beecode`）的桌面自动更新与服务器自更新共用同一把
minisign 密钥：签名只在 CI 产出，验证只在客户端。

- 桌面：Tauri 打包器（`bundle.createUpdaterArtifacts`）在打包时签出 updater
  包与同名 `.sig`；客户端用 `tauri.conf.json` 内嵌公钥验签。
- 服务器：`build-server` 用 `tauri signer sign` 签
  `beecode-server-<os>-<arch>.tar.gz|.zip`；客户端用
  `src-tauri/src/update/verify.rs` 的 `TAURI_PUBKEY_B64` 验签。
- 缺 `.sig`、签名不匹配一律拒绝安装；SHA256 只做完整性校验，不是身份
  认证。

macOS 代码签名与公证限制见 [macos-self-signed.md](./macos-self-signed.md)。

## 一、更新源

桌面 endpoint 与服务器常量都指向
`https://github.com/EvanZheng11/beecode/releases/latest/download/`：

- `src-tauri/tauri.conf.json` → `plugins.updater.endpoints[0]`
  （`latest.json`）；
- `src-tauri/src/update/version.rs` → `UPDATE_MANIFEST_URL` 与
  `RELEASE_DOWNLOAD_BASE`；
- Rust 测试 `update::version::tests::endpoint_matches_version` 强制两边一致；
  服务器在下载基址上再拼 `beecode-server-<os>-<arch>.tar.gz|.zip` 与同名
  `.sig`。

## 二、生成与保管密钥（仓库外）

一次性生成，长期复用；不要每个 tag 重新生成：

```bash
mkdir -p ~/.tauri
pnpm tauri signer generate -w ~/.tauri/codeg-updater.key
chmod 600 ~/.tauri/codeg-updater.key
```

- 私钥 `~/.tauri/codeg-updater.key`（权限 600，仓库外）：只存在于本机
  密码管理器与 GitHub Actions Secrets；不要 `cat`、不要提交、不要粘进
  聊天、日志或报告。
- 生成时会提示设置密码；密码同样只进密码管理器与 Secret。
- 公钥 `~/.tauri/codeg-updater.key.pub`：Tauri CLI 写出的即是单行 base64，
  可以直接公开。它要写入下面两处，值必须逐字节一致（Rust 测试
  `update::verify::tests::embedded_pubkey_matches_tauri_conf` 强制）：
  - `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`；
  - `src-tauri/src/update/verify.rs` → `TAURI_PUBKEY_B64`。

## 三、GitHub Actions Secrets

在 `EvanZheng11/beecode` 的仓库页面配置（Settings → Secrets and variables →
Actions → Repository secrets → New repository secret）。只需要下面两个，
**文档、命令输出与仓库都不得出现 Secret 的值**：

| Secret 名称 | 内容 |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | `~/.tauri/codeg-updater.key` 文件原样文本（不要二次编码、不要改动换行） |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 生成密钥时设置的密码 |

用 `gh` 上传时走文件输入/交互输入，避免把值留在命令行：

```bash
# 在仓库根目录执行
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/codeg-updater.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD   # 交互输入，不回显
```

`release.yml` 的 `build-tauri` 与 `build-server` 都依赖这两个 Secret；缺失时
工作流在构建前硬失败（`缺少 Secret TAURI_SIGNING_PRIVATE_KEY`），不会发布
未签名产物。

## 四、发布产物与 `latest.json`

- 桌面 updater 包 + 同名 `.sig`（Linux arm64 桌面只打 deb/rpm，不产出
  updater 资产）：
  - macOS：`beecode_<version>_{x64,aarch64}.app.tar.gz`；
  - Windows：`beecode_<version>_{x64,arm64}-setup.exe`；
  - Linux x64：`beecode_<version>_amd64.AppImage`、`beecode_<version>_amd64.deb`、
    `beecode_<version>_x86_64.rpm`，三种安装包各签出同名 `.sig`（清单的
    `linux-x86_64-deb` / `linux-x86_64-rpm` 键取自后两份签名；缺键时 deb/rpm
    安装版会回退到 AppImage 并安装失败）。
  （`createUpdaterArtifacts` 为 bool true 时 tauri-cli 直接签原包；
  `.AppImage.tar.gz` / `.nsis.zip` 包装只在 `"v1Compatible"` 模式下产出。）
- 服务器：`beecode-server-{linux,darwin}-{x64,arm64}.tar.gz` 与
  `beecode-server-windows-{x64,arm64}.zip` + 同名 `.sig`。
- `latest.json`：由独立 job `generate-updater-manifest` 在 `build-tauri` 与
  `build-server` 全部成功、且所有 `.sig` 已上传到 draft release 之后统一
  生成并上传；平台键稳定版 12 个、预发布 11 个（预发布不产 rpm，无
  `linux-x86_64-rpm` 键）；清单内各平台 URL 指向当前 tag（不是
  `latest`）。`publish-release` 以该 job 成功为前置，缺任一桌面 updater 包
  或服务器包的 `.sig` 都会让 draft 不发布。

不交给 tauri-action 的 `includeUpdaterJson` 生成的原因：多个矩阵 job 会
并发读改写同一个 `latest.json`，后写者会静默覆盖先写者的平台条目。

## 五、beta tag 限制

tag 含 `-` 的版本是 prerelease，GitHub 的 `releases/latest`（以及
`releases/latest/download/...`）不会指向它，因此 beta 期间自动更新检查会
得到 404。这是接受的行为，不绕过（不把 beta 设为非 prerelease）。

- `.sig` 与 `latest.json` 照常生成，可用直链手动安装或验证：
  `https://github.com/EvanZheng11/beecode/releases/download/<beta tag>/latest.json`；
- 首个 stable（例如 `v0.35.1`）发布后 `releases/latest` 立即生效；semver
  保证已装新密钥 beta 的客户端能自动更新到该 stable。

## 六、旧客户端与密钥断代

客户端内嵌公钥，换密钥即断代：

- 旧版本（旧公钥）无法验证新签名，自动更新会明确失败；
- 旧客户端必须手动下载并安装一次新版本，之后恢复自动更新；
- 发布说明已包含该提示，切换密钥后的首次发布必须在说明里保留。

## 七、轮换与泄露处理

- **轮换**：按第二节在仓库外生成新密钥对 → 更新本机密码管理器备份 →
  更新两处公钥（`tauri.conf.json` / `verify.rs`）→ 更新 GitHub Secret →
  提交后发一版新 release，并在发布说明写明「旧版本需手动安装一次」。
  客户端不支持同时信任两把公钥，每次轮换都伴随一次断代。
- **泄露**：立即按轮换流程生成并启用新密钥，替换（而不是并存）GitHub
  Secret，并删除旧 Secret；已发布版本内嵌的旧公钥无法撤回，攻击者仍可能
  对未升级的旧客户端伪造更新，只能靠“手动安装一次”阻断。因此私钥必须
  设密码，且只出现在密码管理器与 Actions Secret。
- 本机私钥文件只是工作副本；丢失时从密码管理器恢复。不要重新生成后
  直接覆盖 Secret——会造成 Secret 与仓库内两处公钥不一致。

## 八、macOS 免费自签名/未公证的实际限制

- 免费包的 macOS 代码签名用项目自签名证书（见
  [macos-self-signed.md](./macos-self-signed.md)），**不在 Apple 信任链
  内、不做 Apple 公证**；不声称受 Apple 系统信任。
- 首次打开（以及部分更新后的首次启动）可能被 Gatekeeper 阻止，需要右键
  → 打开或在系统设置里手动允许；不会静默通过。
- minisign 更新签名只证明“更新包来自本仓库私钥、内容未被篡改”，不能替代
  Apple Developer ID/公证，也不会消除 Gatekeeper 提示。
- computer-use 的双向验签仍按自签名证书 SHA-1 指纹锚定，不受更新签名
  影响。

## 九、本地验证（注意执行目录）

**所有 `pnpm` 命令都必须在仓库根目录（`package.json` 所在目录）执行**：
在仓库外的目录执行 `pnpm` 时，pnpm 会向上找到家目录的 `package.json` 并
扫描整个家目录，导致内存耗尽（OOM），签名命令根本不会执行。

```bash
# 在仓库根目录执行
cd /path/to/codeg
test -f package.json

# 1) 签一个临时文件；私钥带密码时会交互提示，也可先 export
#    TAURI_SIGNING_PRIVATE_KEY_PASSWORD（只进本次 shell，不落盘）
printf 'codeg updater signing smoke\n' > /tmp/codeg-sign-smoke.txt
pnpm tauri signer sign -f ~/.tauri/codeg-updater.key /tmp/codeg-sign-smoke.txt
test -s /tmp/codeg-sign-smoke.txt.sig && echo sig-ok

# 2) 用独立 minisign 验签：.sig 与 .pub 都是「minisign 文本的 base64」
#    macOS（BSD base64）：
base64 -D -i /tmp/codeg-sign-smoke.txt.sig -o /tmp/codeg-sign-smoke.minisig
base64 -D -i ~/.tauri/codeg-updater.key.pub -o /tmp/codeg-updater.pub
#    Linux（GNU coreutils）改用：
#    base64 -d /tmp/codeg-sign-smoke.txt.sig > /tmp/codeg-sign-smoke.minisig
#    base64 -d ~/.tauri/codeg-updater.key.pub > /tmp/codeg-updater.pub
#    未安装 minisign：macOS `brew install minisign`；Debian/Ubuntu
#    `apt install minisign`
minisign -V -m /tmp/codeg-sign-smoke.txt -x /tmp/codeg-sign-smoke.minisig \
  -p /tmp/codeg-updater.pub
rm -f /tmp/codeg-sign-smoke* /tmp/codeg-updater.pub
```

期望 `minisign` 输出 `Signature and comment signature verified`。
