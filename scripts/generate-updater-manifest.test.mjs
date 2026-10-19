// 生成器自检：`node --test scripts/generate-updater-manifest.test.mjs`。
// 这份清单是更新链路的安全边界（URL + 签名配对），门禁逻辑必须有可运行检查。
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { buildManifest, expectedAssets } from "./generate-updater-manifest.mjs"

const SCRIPT = fileURLToPath(
  new URL("./generate-updater-manifest.mjs", import.meta.url)
)
const VERSION = "0.35.1-beta.1"
const SERVER = "codeg-server-linux-x64.tar.gz"
// 生成器只做 base64 形态门禁；密码学校验在客户端（桌面插件 / verify.rs）。
const SIG = Buffer.from("untrusted comment: signature\nAAAA\n").toString(
  "base64"
)

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "codeg-updater-manifest-"))
  const sigDir = join(dir, "sigs")
  mkdirSync(sigDir)
  const names = [...new Set(Object.values(expectedAssets(VERSION)))]
  const assets = []
  for (const name of [...names, SERVER]) {
    assets.push({
      name,
      browser_download_url: `https://example.test/releases/download/untagged-draft/${name}`,
    })
    assets.push({
      name: `${name}.sig`,
      browser_download_url: `https://example.test/releases/download/untagged-draft/${name}.sig`,
    })
    writeFileSync(join(sigDir, `${name}.sig`), SIG)
  }
  const releaseJson = join(dir, "release.json")
  writeFileSync(
    releaseJson,
    JSON.stringify({ body: "发布说明", tag_name: `v${VERSION}`, assets })
  )
  return { dir, releaseJson, sigDir, assets }
}

test("生成全部平台键、URL 与签名", (t) => {
  const { dir, releaseJson, sigDir } = fixture()
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const manifest = buildManifest({ releaseJson, sigDir, version: VERSION })

  assert.equal(manifest.version, VERSION)
  assert.equal(manifest.notes, "发布说明")
  assert.deepEqual(
    Object.keys(manifest.platforms).sort(),
    Object.keys(expectedAssets(VERSION)).sort()
  )
  assert.equal(
    manifest.platforms["windows-aarch64-nsis"].url,
    `https://example.test/releases/download/v${VERSION}/codeg_${VERSION}_arm64-setup.exe`
  )
  assert.equal(manifest.platforms["darwin-x86_64"].signature, SIG)
})

test("桌面产物缺少 .sig 资产时拒绝生成", (t) => {
  const { dir, releaseJson, sigDir, assets } = fixture()
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const broken = assets.filter(
    (asset) => asset.name !== `codeg_${VERSION}_x64-setup.exe.sig`
  )
  writeFileSync(
    releaseJson,
    JSON.stringify({ body: "发布说明", tag_name: `v${VERSION}`, assets: broken })
  )

  assert.throws(
    () => buildManifest({ releaseJson, sigDir, version: VERSION }),
    /产物缺少同名签名资产/
  )
})

test("服务器包缺少 .sig 资产时拒绝生成", (t) => {
  const { dir, releaseJson, sigDir, assets } = fixture()
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const broken = assets.filter((asset) => asset.name !== `${SERVER}.sig`)
  writeFileSync(
    releaseJson,
    JSON.stringify({ body: "发布说明", tag_name: `v${VERSION}`, assets: broken })
  )

  assert.throws(
    () => buildManifest({ releaseJson, sigDir, version: VERSION }),
    /服务器包缺少签名资产/
  )
})

test("未下载到签名文件时拒绝生成", (t) => {
  const { dir, releaseJson, sigDir } = fixture()
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  rmSync(join(sigDir, "codeg_x64.app.tar.gz.sig"))
  assert.throws(
    () => buildManifest({ releaseJson, sigDir, version: VERSION }),
    /未下载到签名文件/
  )
})

test("签名文件内容不是 base64 时拒绝生成", (t) => {
  const { dir, releaseJson, sigDir } = fixture()
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  writeFileSync(join(sigDir, "codeg_x64.app.tar.gz.sig"), "not@@base64")
  assert.throws(
    () => buildManifest({ releaseJson, sigDir, version: VERSION }),
    /签名文件不是 base64 文本/
  )
})

test("CLI 入口写出完整的 latest.json", (t) => {
  const { dir, releaseJson, sigDir } = fixture()
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const out = join(dir, "latest.json")
  const stdout = execFileSync(
    process.execPath,
    [
      SCRIPT,
      "--release-json",
      releaseJson,
      "--sig-dir",
      sigDir,
      "--version",
      VERSION,
      "--out",
      out,
    ],
    { encoding: "utf8" }
  )
  assert.match(stdout, /平台键 10 个/)

  const written = JSON.parse(readFileSync(out, "utf8"))
  assert.deepEqual(
    Object.keys(written.platforms).sort(),
    Object.keys(expectedAssets(VERSION)).sort()
  )
})

// v0.35.2 发布事故（run 38522104695）回归：createUpdaterArtifacts 为 bool true
// 时（v2 模式）tauri-cli 2.11.4 直接签原包——Linux 是 *.AppImage.sig，Windows 是
// *-setup.exe.sig，不再有 tar.gz/zip 包装。这里用事故版本的字面量资产名构造
// release（不经 expectedAssets 推导），断言生成器按 v2 名字取资产与签名。
test("v0.35.2 回归：Linux/Windows 期望资产是 .AppImage / -setup.exe", (t) => {
  const v2Version = "0.35.2"
  const names = [
    `codeg_${v2Version}_amd64.AppImage`,
    `codeg_${v2Version}_x64-setup.exe`,
    `codeg_${v2Version}_arm64-setup.exe`,
    "codeg_x64.app.tar.gz",
    "codeg_aarch64.app.tar.gz",
  ]

  const assets = expectedAssets(v2Version)
  assert.equal(assets["linux-x86_64"], names[0])
  assert.equal(assets["linux-x86_64-appimage"], names[0])
  assert.equal(assets["windows-x86_64"], names[1])
  assert.equal(assets["windows-x86_64-nsis"], names[1])
  assert.equal(assets["windows-aarch64"], names[2])
  assert.equal(assets["windows-aarch64-nsis"], names[2])
  // macOS 在 v2 下仍产 .app.tar.gz，不受本修复影响。
  assert.equal(assets["darwin-x86_64"], names[3])
  assert.equal(assets["darwin-aarch64"], names[4])

  const dir = mkdtempSync(join(tmpdir(), "codeg-updater-manifest-v2-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const sigDir = join(dir, "sigs")
  mkdirSync(sigDir)
  const releaseAssets = []
  for (const name of names) {
    writeFileSync(join(sigDir, `${name}.sig`), SIG)
    releaseAssets.push(
    {
      name,
      browser_download_url: `https://example.test/releases/download/untagged-draft/${name}`,
    },
      {
        name: `${name}.sig`,
        browser_download_url: `https://example.test/releases/download/untagged-draft/${name}.sig`,
      }
    )
  }
  const releaseJson = join(dir, "release.json")
  writeFileSync(
    releaseJson,
    JSON.stringify({
      body: "发布说明",
      tag_name: `v${v2Version}`,
      assets: releaseAssets,
    })
  )

  const platforms = buildManifest({
    releaseJson,
    sigDir,
    version: v2Version,
  }).platforms
  assert.equal(
    platforms["linux-x86_64"].url,
    `https://example.test/releases/download/v${v2Version}/${names[0]}`
  )
  assert.equal(
    platforms["windows-x86_64-nsis"].url,
    `https://example.test/releases/download/v${v2Version}/${names[1]}`
  )
  assert.equal(
    platforms["windows-aarch64-nsis"].url,
    `https://example.test/releases/download/v${v2Version}/${names[2]}`
  )
})
