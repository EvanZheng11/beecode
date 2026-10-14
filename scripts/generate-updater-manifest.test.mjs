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
      browser_download_url: `https://example.test/download/${name}`,
    })
    assets.push({
      name: `${name}.sig`,
      browser_download_url: `https://example.test/download/${name}.sig`,
    })
    writeFileSync(join(sigDir, `${name}.sig`), SIG)
  }
  const releaseJson = join(dir, "release.json")
  writeFileSync(releaseJson, JSON.stringify({ body: "发布说明", assets }))
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
    `https://example.test/download/codeg_${VERSION}_arm64-setup.nsis.zip`
  )
  assert.equal(manifest.platforms["darwin-x86_64"].signature, SIG)
})

test("桌面产物缺少 .sig 资产时拒绝生成", (t) => {
  const { dir, releaseJson, sigDir, assets } = fixture()
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const broken = assets.filter(
    (asset) => asset.name !== `codeg_${VERSION}_x64-setup.nsis.zip.sig`
  )
  writeFileSync(
    releaseJson,
    JSON.stringify({ body: "发布说明", assets: broken })
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
    JSON.stringify({ body: "发布说明", assets: broken })
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
