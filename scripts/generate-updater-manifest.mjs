// 汇总 draft release 上的 updater 资产并生成 tauri-plugin-updater 使用的
// `latest.json`，写盘前执行平台键与签名门禁。
//
// 为什么不由 tauri-action 的 includeUpdaterJson 生成：6 个桌面矩阵 job 会
// 并发读改写同一个 latest.json（tauri-action 上传前先删同名资产），后写者会
// 用自己那份平台表覆盖先写者，静默丢平台条目；这里等全部产物就位后一次性
// 生成，并在发布前校验签名资产齐全。
//
// 资产命名对照 tauri-cli 2.11.4（createUpdaterArtifacts 为 bool true 即 v2
// 模式，tauri-bundler updater_bundle.rs 只在 "v1Compatible" 下才产 tar.gz/zip
// 包装）。tauri-action v0.6.1 使用 assetNamePattern 统一发布名：
// `beecode_[version]_[arch][setup][ext]`；本地安装包保留 productName 的 BeeCode 大小写。
// macOS `beecode_<v>_{x64,aarch64}.app.tar.gz`；Windows `beecode_<v>_{x64,arm64}-setup.exe`；
// Linux x64 `beecode_<v>_amd64.AppImage`、`beecode_<v>_amd64.deb`、`beecode_<v>_x86_64.rpm`
// （三个安装包都由 createUpdaterArtifacts 直接签出同名 .sig）。预发布（版本号带
// "-"）的发布工作流只构建 deb + AppImage（RPM 不接受带 "-" 的版本号）。
//
// 用法：
//   node scripts/generate-updater-manifest.mjs \
//     --release-json release.json \
//     --sig-dir sigs \
//     --version 0.35.1-beta.1 \
//     --out latest.json

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

// 平台键 → updater 资产名。基础键与 -app / -nsis / -appimage / -deb / -rpm 后缀键
// 都要有：tauri-plugin-updater 先找 `{os}-{arch}-{installer}`，找不到才回退
// `{os}-{arch}`，而安装始终按当前安装包类型（install_deb / install_rpm /
// install_appimage）。缺 -deb / -rpm 键时 deb 安装版会回退到 AppImage，下载后报
// "update is not a valid deb package"（0.40.3 → 0.40.4 实际事故）。
// 预发布（版本号带 "-"）的发布工作流只构建 deb + AppImage，不生成 rpm 键，
// 否则门禁会阻断现有 beta / rc 发布；稳定版 deb / rpm 必须齐全。
export function expectedAssets(version) {
  const macX64 = `beecode_${version}_x64.app.tar.gz`
  const macArm = `beecode_${version}_aarch64.app.tar.gz`
  const appImage = `beecode_${version}_amd64.AppImage`
  const deb = `beecode_${version}_amd64.deb`
  const rpm = `beecode_${version}_x86_64.rpm`
  const nsisX64 = `beecode_${version}_x64-setup.exe`
  const nsisArm = `beecode_${version}_arm64-setup.exe`
  const assets = {
    "darwin-x86_64": macX64,
    "darwin-x86_64-app": macX64,
    "darwin-aarch64": macArm,
    "darwin-aarch64-app": macArm,
    "linux-x86_64": appImage,
    "linux-x86_64-appimage": appImage,
    "linux-x86_64-deb": deb,
    "windows-x86_64": nsisX64,
    "windows-x86_64-nsis": nsisX64,
    "windows-aarch64": nsisArm,
    "windows-aarch64-nsis": nsisArm,
  }
  if (!version.includes("-")) assets["linux-x86_64-rpm"] = rpm
  return assets
}

function fail(message) {
  throw new Error(message)
}

function readSignature(sigDir, assetName) {
  const path = join(sigDir, `${assetName}.sig`)
  let signature = ""
  try {
    signature = readFileSync(path, "utf8").trim()
  } catch {
    fail(`未下载到签名文件：${path}`)
  }
  // .sig 是 tauri signer 写的「minisign 文本的 base64」；这里只做形态校验，
  // 密码学校验在客户端完成（桌面插件 / verify.rs）。
  if (!signature || !/^[A-Za-z0-9+/=\r\n]+$/.test(signature)) {
    fail(`签名文件不是 base64 文本：${path}`)
  }
  return signature
}

function releaseAssetUrl(release, asset, version) {
  const tag = release.tag_name ?? `v${version}`
  return asset.browser_download_url.replace(
    /\/releases\/download\/[^/]+(?=\/)/,
    `/releases/download/${tag}`
  )
}

export function buildManifest({
  releaseJson,
  sigDir,
  version,
  now = new Date(),
}) {
  const release = JSON.parse(readFileSync(releaseJson, "utf8"))
  const assets = new Map(
    (release.assets ?? []).map((asset) => [asset.name, asset])
  )

  const platforms = {}
  for (const [target, assetName] of Object.entries(expectedAssets(version))) {
    const asset = assets.get(assetName)
    if (!asset) {
      fail(`latest.json 缺少平台 ${target} 的产物：${assetName}`)
    }
    if (!assets.has(`${assetName}.sig`)) {
      fail(`产物缺少同名签名资产：${assetName}.sig`)
    }
    platforms[target] = {
      signature: readSignature(sigDir, assetName),
      url: releaseAssetUrl(release, asset, version),
    }
  }

  // 服务器自更新同样下载 `<包名>.sig`（install.rs），缺签名的包不得发布。
  for (const name of assets.keys()) {
    const isServerPackage =
      name.startsWith("beecode-server-") &&
      (name.endsWith(".tar.gz") || name.endsWith(".zip"))
    if (isServerPackage && !assets.has(`${name}.sig`)) {
      fail(`服务器包缺少签名资产：${name}.sig`)
    }
  }

  return {
    version,
    notes: release.body ?? "",
    pub_date: now.toISOString(),
    platforms,
  }
}

function main() {
  const args = process.argv.slice(2)
  const value = (flag) => {
    const index = args.indexOf(flag)
    return index === -1 ? undefined : args[index + 1]
  }
  const releaseJson = value("--release-json")
  const sigDir = value("--sig-dir")
  const version = value("--version")
  const out = value("--out")
  if (!releaseJson || !sigDir || !version || !out) {
    fail(
      "用法：--release-json <file> --sig-dir <dir> --version <x.y.z> --out <file>"
    )
  }
  const manifest = buildManifest({ releaseJson, sigDir, version })
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`)
  const count = Object.keys(manifest.platforms).length
  console.log(
    `latest.json 已生成：version=${manifest.version}，平台键 ${count} 个`
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main()
}
