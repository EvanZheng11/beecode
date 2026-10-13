# macOS 自签名证书发布（免费包）

本仓库的免费发布工作流（`.github/workflows/release.yml`）用一张**项目自有
的、自签名的代码签名证书**给 macOS 包签名：

- 桌面 DMG / App（`app.codeg`）、`codeg-mcp`、`codeg-computer-helper` 用
  同一张证书严格签名，哈希写成 `CodeDirectory`（SHA-256）。
- computer-use **保留**：主程序与 helper 双向验签，验签条件按证书的
  SHA-1 指纹锚定（macOS 验签语法限制，见下文）。
- 不使用 Apple Developer ID、不使用付费公证（notarization），因此自签名
  证书不在 Apple 信任链内；**不声称受 Apple 系统信任**。
- `bundle.createUpdaterArtifacts` 保持 false：不支持签名自动更新。
- Windows / Linux / Docker 构建路径完全不变；缺少 macOS Secrets 只会让
  macOS 两个 job 在导入步骤提前失败，不会降级成无验签或关闭 computer-use。

## 一、生成一张自签名代码签名证书（一次性，长期复用）

在本地安全环境执行。**私钥与 P12 绝不进仓库**（建议把
`*.p12`、`*.key`、`*.pem`、`*.b64` 加入本机忽略习惯，防止误提交）。
密码用交互输入，不要写入命令历史或脚本。

```bash
# 1) 生成私钥与自签名证书（有效期 10 年；复用这一张即可）
openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 \
  -keyout codeg-selfsigned.key -out codeg-selfsigned.cer \
  -subj "/CN=codeg self-signed/O=codeg/OU=Code Signing/C=CN" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning"

# 2) 导出 P12（密码交互输入，不要写进命令行或脚本）
#    用默认的 PKCS#12 编码（3DES/SHA1）—— 这是**已经实测可用**的配方：导入脚本用
#    runner 上的 `openssl pkcs12` 提取证书校验、再用 `security import` 导入 keychain，
#    两种读法都认它（本机实测：macOS 自带 /usr/bin/openssl 是 LibreSSL 3.3.6，读这种
#    P12 报 MAC verified OK）。macOS 自带的 openssl 默认就是这种编码。
#    如果本机用的是 OpenSSL 3.x（例如 brew 安装），它默认写 AES-256-CBC/SHA-256；
#    为了在所有 runner 上都保持这一种已验证编码，请在命令后面补 `-legacy`。
openssl pkcs12 -export -out codeg-selfsigned.p12 \
  -inkey codeg-selfsigned.key -in codeg-selfsigned.cer
# OpenSSL 3.x：把上面这条命令改成同一行后面追加 -legacy 的版本。

# 3) base64 单行编码，供 Secret 使用（文件中转，不在命令回显秘密）
base64 -i codeg-selfsigned.p12 -o codeg-selfsigned.p12.b64
```

证书要求（导入脚本会在 CI 强制校验，不满足直接失败）：

- **自签名**：issuer 与 subject 相同（因此 Apple 颁发的证书无法借道导入）；
- 用途包含 **Code Signing**（extendedKeyUsage）；
- SHA-1 指纹必须是 40 位十六进制（脚本校验后拼进验签条件）。

这张证书**只需生成一次**：之后所有版本都用它签名；不要每个 tag 重新生成，
否则旧包与新 helper 会互相拒绝验签。

## 二、把证书放进 GitHub Secrets

仓库页面：`https://github.com/<owner>/<repo>/settings/secrets/actions`
（Settings → Secrets and variables → Actions → **Repository secrets** →
New repository secret）。

| Secret 名称 | 内容 |
| --- | --- |
| `CODEG_MACOS_SIGNING_P12` | `codeg-selfsigned.p12.b64` 的**单行 base64** 文本 |
| `CODEG_MACOS_SIGNING_PASSWORD` | 第 1 步导出 P12 时输入的密码 |

用 `gh` 上传时走文件输入（避免把秘密留在命令行或日志里）：

```bash
gh secret set CODEG_MACOS_SIGNING_P12 < codeg-selfsigned.p12.b64
gh secret set CODEG_MACOS_SIGNING_PASSWORD    # 交互输入，不回显
```

> P12 的 base64 可以带换行，导入脚本会自动去空白；密码必须是原始字符串。

## 三、工作流里发生了什么（自动完成）

macOS 的两个 job（桌面 build-tauri、服务器 build-server）在编译前：

1. `bash scripts/import-macos-self-signed-certificate.sh`
   - 解码 P12、校验（自签名 / Code Signing / SHA-1 40 位）；
   - 建**本 job 专属临时 keychain**，把 keychain 临时加入 user 搜索列表；
   - 导出（写入 `GITHUB_ENV`，不含私钥/密码/原始 P12）：
     - `APPLE_SIGNING_IDENTITY` = 证书 SHA-1（供 codesign / Tauri bundler）；
     - `CODEG_COMPUTER_CERT_SHA1` = 证书 SHA-1；
     - `CODEG_MACOS_KEYCHAIN`、`CODEG_MACOS_KEYCHAIN_LIST_FILE` = 清理记录。
2. 由 SHA-1 生成两条 requirement 写入 `GITHUB_ENV`
   （绝**不**写 `CODEG_COMPUTER_TEAM_ID` —— 自签名证书没有 Team ID）：
   - `CODEG_COMPUTER_HELPER_REQUIREMENT`：
     `identifier "app.codeg.computer-helper" and certificate leaf = H"<sha1>"`
   - `CODEG_COMPUTER_PEER_REQUIREMENT`：
     `(identifier "app.codeg" or identifier "codeg-server") and certificate leaf = H"<sha1>"`
3. 构建（签名都在 staging、DMG 生成之前完成）：
   - `codeg-mcp`（裸二进制，`prepare-sidecars.mjs` 用 `-i` 显式签名）与
     `codeg-computer-helper.app` 都用该证书签名，identifier 写死为
     `codeg-mcp` / `app.codeg.computer-helper`，并带 `--options runtime`
     （hardened runtime）与 SHA-256 CodeDirectory；主 app 的 identifier 仍是
     `app.codeg`（由 Tauri 按 `CFBundleIdentifier` 签）；
   - 为什么必须写死 identifier：codesign 重签裸可执行文件时**不带 `-i` 会按
     文件名重推 identifier**，Tauri bundler 正是这样重签 externalBin 侧车的；
     不显式签的话，留在二进制里的就是 Rust linker 生成的 `codeg_mcp-<hash>`，
     与验签条件 `identifier "codeg-mcp"` 不符；
   - bundler 会重签侧车与最外层 bundle，但**不重签嵌套 helper**（`Contents/
     Helpers` 下的 app 只被当作资源封装）—— helper.app 的证书签名只能靠
     staging，少了它最终包里的 helper 仍是 Ad-hoc、验签必然失败；
   - 服务器 job 的 `codeg-server` / `codeg-mcp` / `codeg-computer-helper`
     在打包前用同一证书严格签名（同样带 hardened runtime）并逐个验证；
   - 不加任何 entitlements（`get-task-allow`、`disable-library-validation`
     等一概不加）：helper 的屏幕录制 / 辅助功能权限走正常 TCC 授权；
4. 门禁（打包后、上传前，任一项失败即中断）：
   - 主程序 / `codeg-mcp` / helper.app：`codesign --verify --strict` 通过、
     签名 flags 含 **runtime**、且不携带 entitlements；
   - `codesign --verify --strict -R="$requirement"` 对 main / mcp / helper
     必须直接**通过**（不再验证“永不匹配”，而是验证“必须匹配同一证书”）；
   - 服务器三个二进制同样逐个验 identifier 与 runtime flag；
5. job 结束（`if: always()`）：执行导入脚本 `cleanup`，还原 keychain 搜索
   列表并删除临时 keychain。

## 四、为什么是 SHA-1 指纹（不是无验签）

- codesign 按 identity 名称或 **证书摘要（SHA-1）** 查找签名身份，
  requirement 语法 `certificate leaf = H"..."` 也是 **SHA-1 证书哈希**；
  WebKit/Chromium 体系同理。macOS 验签锚定用 SHA-1 是系统语法限制。
- **签名数据本体仍是 SHA-256**（`CodeDirectory`），完整性由 SHA-256 保护；
  本任务的 `SHA256SUMS` 文件只做**文件完整性校验**，不是身份认证签名。
- 证书签名一律开 **hardened runtime**（`flags=0x10000(runtime)`）：不开的话
  helper / mcp 的签名 flags 是 `none`，`DYLD_INSERT_LIBRARIES` 这类注入仍可
  生效，等于没有保护。runtime 只限制运行期注入与调试，不需要任何 entitlements；
  本地无证书的 Ad-hoc 构建不开 runtime（保持既有开发语义）。
- 绝不降级：没有证书时流程不会关闭 computer-use、也不会用
  “永不匹配 + 假 Team ID”的关闭模式——直接失败。

## 五、用户端体验（如实说明）

- 首次打开可能被 **Gatekeeper** 阻止：右键 → 打开，或系统设置里手动允许。
  应用每次更新后签名身份不变（同一张证书 + 相同标识），一般不必重复授权。
- 需要辅助功能的权限（TCC，如屏幕录制 / 辅助功能）按正常流程手动授权；
  授权挂在固定签名身份（`app.codeg.computer-helper`）上，签名不变则延续。
- 自签名包**未经 Apple 公证**，也不支持签名自动更新；
  不存在“被 Apple 系统信任、静默无提示启动”的效果。

## 六、本地构建

- 本地 macOS 编译不设置 `APPLE_SIGNING_IDENTITY` 时，staged `codeg-mcp` 与
  helper 退回 Ad-hoc 签名（identity `-`，不开 hardened runtime，仅开发用途），
  只把 identifier 固定成 `codeg-mcp` / `app.codeg.computer-helper`；
- 想本地验证发布链路时，条件必须与 workflow 完全一致 —— 缺一项都会被 `local.rs`
  的编译期断言或运行时 `trust()` 拒绝（绝不会悄悄退回不验签的开发模式）：

  1. 把证书导入本地 keychain（自检签名需要私钥）：
     `security import codeg-selfsigned.p12 -k <本地 keychain> -P <p12 密码> -T /usr/bin/codesign`；
  2. 导出 4 个变量，**都不为空** —— 锚与两条 requirement 缺一不可：

     | 变量 | 值 |
     | --- | --- |
     | `APPLE_SIGNING_IDENTITY` | 40 位大写 SHA-1（`openssl x509 -noout -fingerprint -sha1` 得到） |
     | `CODEG_COMPUTER_CERT_SHA1` | **同一个 SHA-1**（少了它，helper 的编译期断言会直接失败） |
     | `CODEG_COMPUTER_HELPER_REQUIREMENT` | `identifier "app.codeg.computer-helper" and certificate leaf = H"<sha1>"` |
     | `CODEG_COMPUTER_PEER_REQUIREMENT` | `(identifier "app.codeg" or identifier "codeg-server") and certificate leaf = H"<sha1>"` |

     第 5 个变量 `CODEG_COMPUTER_TEAM_ID` **不要设置**：自签名证书没有 Team ID，
     设了会被当成两种锚混用而拒绝。
  3. 之后执行 `pnpm tauri build`（或先 `pnpm tauri:prepare-sidecars` 再构建）；
     也可以直接跑导入脚本，见 `scripts/import-macos-self-signed-certificate.sh`
     顶部注释。

  注意：变量名被 export 成空串同样是错误（与“没有设置”不等价），`trust()` 会拒绝。
