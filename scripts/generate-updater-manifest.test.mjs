// 生成器自检：`node --test scripts/generate-updater-manifest.test.mjs`。
// 这份清单是更新链路的安全边界（URL + 签名配对），门禁逻辑必须有可运行检查。
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { parse } from "yaml"

import { buildManifest, expectedAssets } from "./generate-updater-manifest.mjs"

const SCRIPT = fileURLToPath(
  new URL("./generate-updater-manifest.mjs", import.meta.url)
)
const VERSION = "0.35.1-beta.1"
const SERVER = "beecode-server-linux-x64.tar.gz"
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
    `https://example.test/releases/download/v${VERSION}/beecode_${VERSION}_arm64-setup.exe`
  )
  assert.equal(manifest.platforms["darwin-x86_64"].signature, SIG)
})

test("桌面产物缺少 .sig 资产时拒绝生成", (t) => {
  const { dir, releaseJson, sigDir, assets } = fixture()
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const broken = assets.filter(
    (asset) => asset.name !== `beecode_${VERSION}_x64-setup.exe.sig`
  )
  writeFileSync(
    releaseJson,
    JSON.stringify({
      body: "发布说明",
      tag_name: `v${VERSION}`,
      assets: broken,
    })
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
    JSON.stringify({
      body: "发布说明",
      tag_name: `v${VERSION}`,
      assets: broken,
    })
  )

  assert.throws(
    () => buildManifest({ releaseJson, sigDir, version: VERSION }),
    /服务器包缺少签名资产/
  )
})

test("未下载到签名文件时拒绝生成", (t) => {
  const { dir, releaseJson, sigDir } = fixture()
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  rmSync(join(sigDir, `beecode_${VERSION}_x64.app.tar.gz.sig`))
  assert.throws(
    () => buildManifest({ releaseJson, sigDir, version: VERSION }),
    /未下载到签名文件/
  )
})

test("签名文件内容不是 base64 时拒绝生成", (t) => {
  const { dir, releaseJson, sigDir } = fixture()
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  writeFileSync(
    join(sigDir, `beecode_${VERSION}_x64.app.tar.gz.sig`),
    "not@@base64"
  )
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
  assert.match(
    stdout,
    new RegExp(`平台键 ${Object.keys(expectedAssets(VERSION)).length} 个`)
  )

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

// v2 模式下发布页上的真实资产名（字面量，不经 expectedAssets 推导）。
function literalNames(version) {
  return [
    `beecode_${version}_amd64.AppImage`,
    `beecode_${version}_amd64.deb`,
    `beecode_${version}_x86_64.rpm`,
    `beecode_${version}_x64-setup.exe`,
    `beecode_${version}_arm64-setup.exe`,
    `beecode_${version}_x64.app.tar.gz`,
    `beecode_${version}_aarch64.app.tar.gz`,
  ]
}

// 每个资产配一份可区分的签名，便于断言 URL 与签名没有串到别的安装包上。
function signatureOf(name) {
  return Buffer.from(`untrusted comment: ${name}\nAAAA\n`).toString("base64")
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// omit：资产名后缀，命中的安装包整份不发布（模拟缺包）。
// omitSig：资产名后缀，只发布安装包、不发布同名签名资产（本地 sig 文件仍在）。
function literalRelease(t, version, { omit = [], omitSig = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "codeg-updater-manifest-literal-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const sigDir = join(dir, "sigs")
  mkdirSync(sigDir)
  const has = (suffixes, name) =>
    suffixes.some((suffix) => name.endsWith(suffix))
  const asset = (name) => ({
    name,
    browser_download_url: `https://example.test/releases/download/untagged-draft/${name}`,
  })
  const assets = []
  for (const name of literalNames(version)) {
    if (has(omit, name)) continue
    writeFileSync(join(sigDir, `${name}.sig`), signatureOf(name))
    assets.push(asset(name))
    if (!has(omitSig, name)) assets.push(asset(`${name}.sig`))
  }
  const releaseJson = join(dir, "release.json")
  writeFileSync(
    releaseJson,
    JSON.stringify({ body: "发布说明", tag_name: `v${version}`, assets })
  )
  return { releaseJson, sigDir, assets }
}

const assetUrl = (version, name) =>
  `https://example.test/releases/download/v${version}/${name}`

// 0.40.4 事故：deb 安装版升级时下载到 AppImage，安装阶段报
// "update is not a valid deb package"。tauri-plugin-updater 2.14.0 的 get_urls
// 先找 `{os}-{arch}-deb` / `{os}-{arch}-rpm`，都缺失才回退 `{os}-{arch}`
// （AppImage），但安装方式仍按当前安装包类型（install_deb / install_rpm）。
// 断言用 0.40.4 发布页的真实资产名，三种 Linux x64 安装方式各选中同格式。
test("v0.40.4 回归：Linux x64 的 deb/rpm 键指向同格式安装包", (t) => {
  const v = "0.40.4"
  const [appImage, deb, rpm] = literalNames(v)

  // 资产命名：通用键与 -appimage 键保持 AppImage，deb/rpm 用专用键。
  const expected = expectedAssets(v)
  assert.equal(expected["linux-x86_64"], appImage)
  assert.equal(expected["linux-x86_64-appimage"], appImage)
  assert.equal(expected["linux-x86_64-deb"], deb)
  assert.equal(expected["linux-x86_64-rpm"], rpm)

  const { releaseJson, sigDir } = literalRelease(t, v)
  const platforms = buildManifest({ releaseJson, sigDir, version: v }).platforms

  assert.equal(platforms["linux-x86_64"].url, assetUrl(v, appImage))
  assert.equal(platforms["linux-x86_64"].signature, signatureOf(appImage))
  assert.equal(platforms["linux-x86_64-appimage"].url, assetUrl(v, appImage))
  assert.equal(platforms["linux-x86_64-deb"].url, assetUrl(v, deb))
  assert.equal(
    platforms["linux-x86_64-deb"].signature,
    signatureOf(deb),
    "deb 键必须配 deb 自己的签名"
  )
  assert.equal(platforms["linux-x86_64-rpm"].url, assetUrl(v, rpm))
  assert.equal(
    platforms["linux-x86_64-rpm"].signature,
    signatureOf(rpm),
    "rpm 键必须配 rpm 自己的签名"
  )
})

// 预发布（x.y.z-beta.N / rc）按发布工作流只构建 deb + AppImage：RPM 不接受
// 版本号里的 "-"。因此不生成 rpm 键、也不要求 rpm 资产；deb 键与签名仍必须齐全。
test("预发布版本不生成 rpm 键，但仍生成 deb 键及其签名", (t) => {
  const v = "0.41.0-beta.1"
  const [appImage, deb, , nsisX64] = literalNames(v)

  const expected = expectedAssets(v)
  assert.equal(expected["linux-x86_64-rpm"], undefined, "预发布不应生成 rpm 键")
  assert.equal(expected["linux-x86_64-deb"], deb)
  assert.equal(expected["linux-x86_64-appimage"], appImage)

  const { releaseJson, sigDir } = literalRelease(t, v, { omit: [".rpm"] })
  const platforms = buildManifest({ releaseJson, sigDir, version: v }).platforms

  assert.equal(platforms["linux-x86_64-rpm"], undefined)
  assert.equal(platforms["linux-x86_64"].url, assetUrl(v, appImage))
  assert.equal(platforms["linux-x86_64-deb"].url, assetUrl(v, deb))
  assert.equal(platforms["linux-x86_64-deb"].signature, signatureOf(deb))
  assert.equal(platforms["windows-x86_64-nsis"].url, assetUrl(v, nsisX64))
})

// 门禁矩阵：稳定版 deb/rpm 缺包或缺签名一律阻断；预发布不查 rpm，但 deb
// 缺包/缺签名同样阻断。宁可发布失败，也不能再让 deb/rpm 用户拿到错误格式的包。
const GATE_CASES = [
  {
    title: "稳定版缺少 deb 安装包",
    version: "0.40.4",
    options: { omit: [".deb"] },
    error: "缺少平台 linux-x86_64-deb 的产物：beecode_0.40.4_amd64.deb",
  },
  {
    title: "稳定版缺少 rpm 安装包",
    version: "0.40.4",
    options: { omit: [".rpm"] },
    error: "缺少平台 linux-x86_64-rpm 的产物：beecode_0.40.4_x86_64.rpm",
  },
  {
    title: "稳定版 deb 缺少同名签名",
    version: "0.40.4",
    options: { omitSig: [".deb"] },
    error: "产物缺少同名签名资产：beecode_0.40.4_amd64.deb.sig",
  },
  {
    title: "稳定版 rpm 缺少同名签名",
    version: "0.40.4",
    options: { omitSig: [".rpm"] },
    error: "产物缺少同名签名资产：beecode_0.40.4_x86_64.rpm.sig",
  },
  {
    title: "预发布缺少 deb 安装包",
    version: "0.41.0-beta.1",
    options: { omit: [".rpm", ".deb"] },
    error: "缺少平台 linux-x86_64-deb 的产物：beecode_0.41.0-beta.1_amd64.deb",
  },
  {
    title: "预发布 deb 缺少同名签名",
    version: "0.41.0-beta.1",
    options: { omit: [".rpm"], omitSig: [".deb"] },
    error: "产物缺少同名签名资产：beecode_0.41.0-beta.1_amd64.deb.sig",
  },
]

for (const { title, version, options, error } of GATE_CASES) {
  test(`Linux x64 门禁：${title}时拒绝生成`, (t) => {
    const { releaseJson, sigDir } = literalRelease(t, version, options)
    assert.throws(
      () => buildManifest({ releaseJson, sigDir, version }),
      new RegExp(escapeRe(error))
    )
  })
}

test("v0.35.2 回归：Linux/Windows 期望资产是 .AppImage / -setup.exe", (t) => {
  const v2Version = "0.35.2"
  const names = literalNames(v2Version)

  const assets = expectedAssets(v2Version)
  assert.equal(assets["linux-x86_64"], names[0])
  assert.equal(assets["linux-x86_64-appimage"], names[0])
  assert.equal(assets["windows-x86_64"], names[3])
  assert.equal(assets["windows-x86_64-nsis"], names[3])
  assert.equal(assets["windows-aarch64"], names[4])
  assert.equal(assets["windows-aarch64-nsis"], names[4])
  // macOS 在 v2 下仍产 .app.tar.gz，不受本修复影响。
  assert.equal(assets["darwin-x86_64"], names[5])
  assert.equal(assets["darwin-aarch64"], names[6])

  const { releaseJson, sigDir } = literalRelease(t, v2Version)
  const platforms = buildManifest({
    releaseJson,
    sigDir,
    version: v2Version,
  }).platforms
  assert.equal(platforms["linux-x86_64"].url, assetUrl(v2Version, names[0]))
  assert.equal(
    platforms["windows-x86_64-nsis"].url,
    assetUrl(v2Version, names[3])
  )
  assert.equal(
    platforms["windows-aarch64-nsis"].url,
    assetUrl(v2Version, names[4])
  )
})

// 发布通道判断必须来自检出源码里的实际版本（src-tauri/tauri.conf.json），不能用
// GITHUB_REF_NAME：workflow_dispatch 的 ref_name 是启动分支名，与实际发布标签
// 无关。启动分支名带 "-" 却发稳定 tag 时会漏构建 rpm，而稳定版 manifest 要求
// rpm 键；启动分支名不带 "-" 却发预发布 tag 时又会去构建 RPM 不接受的版本号。
// 下面真实执行 workflow 的版本解析片段与签名门禁片段，并对两个构建步骤的 args
// 表达式按 Actions 语义求值，避免只镜像文本。
const RELEASE_TARGETS = {
  arm64: "aarch64-unknown-linux-gnu",
  x64: "x86_64-unknown-linux-gnu",
}

function buildTauriSteps() {
  const workflow = readFileSync(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8"
  )
  return parse(workflow).jobs["build-tauri"].steps
}

function stepBy(property, value) {
  const matches = buildTauriSteps().filter((step) => step[property] === value)
  assert.equal(matches.length, 1, `缺少唯一步骤 ${property}: ${value}`)
  return matches[0]
}

// 按 Actions 语义渲染 `${{ ... }}`：只注入构建版本输出与 matrix.target，
// `&&` / `||` 的短路求值与 Actions 一致。
function render(template, prerelease, target) {
  return template.replace(/\$\{\{([\s\S]+?)\}\}/g, (_, expression) =>
    String(
      new Function("steps", "matrix", `return (${expression})`)(
        { version: { outputs: { prerelease } } },
        { target }
      )
    )
  )
}

// 在临时目录造出「检出源码」后，真实执行 workflow 的版本解析步骤。
function resolveVersion(version, refName) {
  const dir = mkdtempSync(join(tmpdir(), "codeg-release-version-"))
  const output = join(dir, "github_output")
  try {
    mkdirSync(join(dir, "src-tauri"))
    writeFileSync(
      join(dir, "src-tauri/tauri.conf.json"),
      JSON.stringify({ version })
    )
    writeFileSync(output, "")
    execFileSync("bash", ["-c", stepBy("id", "version").run], {
      cwd: dir,
      env: { ...process.env, GITHUB_REF_NAME: refName, GITHUB_OUTPUT: output },
      encoding: "utf8",
    })
    return Object.fromEntries(
      readFileSync(output, "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split("="))
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function linuxBuildArgs(prerelease) {
  const argsOf = (name, target) =>
    render(stepBy("name", name).with.args, prerelease, target)
  return {
    arm64: argsOf(
      "Build and upload to draft release (Linux arm64)",
      RELEASE_TARGETS.arm64
    ),
    x64: argsOf(
      "Build and upload to draft release (Linux x64)",
      RELEASE_TARGETS.x64
    ),
  }
}

// 版本解析只看检出源码里的版本；启动分支名带不带 "-" 都不影响结果，
// 纯 Artifacts 构建（无 tag）与 tag 构建走同一条路径。
test("版本解析只依赖检出源码版本，不看启动分支名", () => {
  const step = stepBy("id", "version")
  assert.doesNotMatch(step.run, /REF_NAME|RELEASE_TAG|refs\/tags/)
  for (const refName of ["main", "fix-updater-packages", "v0.41.0-beta.1"]) {
    assert.deepEqual(resolveVersion("0.41.0", refName), {
      version: "0.41.0",
      prerelease: "false",
    })
    assert.deepEqual(resolveVersion("0.41.0-beta.1", refName), {
      version: "0.41.0-beta.1",
      prerelease: "true",
    })
  }
})

const BUNDLE_CASES = [
  {
    title: "启动分支名带 - 但实际稳定版仍构建 rpm",
    refName: "fix-updater-packages",
    version: "0.41.0",
    arm64: "deb,rpm",
  },
  {
    title: "启动分支名不带 - 但实际预发布跳过 rpm",
    refName: "main",
    version: "0.41.0-rc.1",
    arm64: "deb",
  },
]

// 两个 Linux 构建步骤必须按同一个版本判断出包：稳定版 deb+rpm，预发布只有
// deb（x64 另加 AppImage）；x64 稳定版不带 --bundles，沿用 bundler 默认（含 rpm）。
for (const { title, refName, version, arm64 } of BUNDLE_CASES) {
  test(`Linux 构建参数：${title}`, () => {
    const { prerelease } = resolveVersion(version, refName)
    const args = linuxBuildArgs(prerelease)
    assert.match(args.arm64, new RegExp(`--bundles ${arm64}( |$)`))
    if (prerelease === "true") {
      assert.ok(args.x64.endsWith(" --bundles deb,appimage"), args.x64)
    } else {
      assert.doesNotMatch(args.x64, /--bundles/)
    }
  })
}

function runSignGate({ prerelease, files }) {
  const dir = mkdtempSync(join(tmpdir(), "codeg-sign-gate-"))
  try {
    const bundle = join(
      dir,
      "src-tauri/target",
      RELEASE_TARGETS.x64,
      "release/bundle"
    )
    for (const file of files) {
      mkdirSync(join(bundle, dirname(file)), { recursive: true })
      writeFileSync(join(bundle, file), "sig")
    }
    const script = stepBy("name", "校验 updater 产物已签名").run.replaceAll(
      "${{ matrix.target }}",
      RELEASE_TARGETS.x64
    )
    return spawnSync("bash", ["-c", script], {
      cwd: dir,
      env: { ...process.env, PRERELEASE: prerelease },
      encoding: "utf8",
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const APPIMAGE_SIG = "appimage/beecode_0.41.0_amd64.AppImage.sig"
const DEB_SIG = "deb/beecode_0.41.0_amd64.deb.sig"
const RPM_SIG = "rpm/beecode_0.41.0_x86_64.rpm.sig"

// 签名门禁与构建步骤共用同一个版本判断：稳定版必须查到 rpm 签名，预发布不查；
// AppImage / deb 签名两边都必须查。
test("签名门禁按检出源码版本要求 rpm 签名", () => {
  const missingRpm = runSignGate({
    prerelease: "false",
    files: [APPIMAGE_SIG, DEB_SIG],
  })
  assert.notEqual(missingRpm.status, 0)
  assert.match(missingRpm.stdout, /缺少 updater 签名产物：.*rpm\/\*\.rpm\.sig/)

  assert.equal(
    runSignGate({
      prerelease: "false",
      files: [APPIMAGE_SIG, DEB_SIG, RPM_SIG],
    }).status,
    0
  )
  assert.equal(
    runSignGate({ prerelease: "true", files: [APPIMAGE_SIG, DEB_SIG] }).status,
    0
  )

  const missingDeb = runSignGate({
    prerelease: "true",
    files: [APPIMAGE_SIG],
  })
  assert.notEqual(missingDeb.status, 0)
  assert.match(missingDeb.stdout, /缺少 updater 签名产物：.*deb\/\*\.deb\.sig/)
})

// 结构断言：整个 build-tauri 都不许再用 GITHUB_REF_NAME 判断发布通道。
test("build-tauri 不使用 GITHUB_REF_NAME 判断发布通道", () => {
  for (const step of buildTauriSteps()) {
    assert.doesNotMatch(JSON.stringify(step), /ref_name|REF_NAME/, step.name)
  }
  const gate = stepBy("name", "校验 updater 产物已签名")
  assert.match(gate.env.PRERELEASE, /steps\.version\.outputs\.prerelease/)
  for (const name of [
    "Build and upload to draft release (Linux arm64)",
    "Build and upload to draft release (Linux x64)",
  ]) {
    assert.match(
      stepBy("name", name).with.args,
      /steps\.version\.outputs\.prerelease/
    )
  }
})

test("BeeCode 0.41.1 模拟发布覆盖 12 平台键和五服务器签名门禁", (t) => {
  const version = "0.41.1"
  const { releaseJson, sigDir } = literalRelease(t, version)
  const release = JSON.parse(readFileSync(releaseJson, "utf8"))
  const names = [
    "linux-x64.tar.gz",
    "linux-arm64.tar.gz",
    "darwin-x64.tar.gz",
    "darwin-arm64.tar.gz",
    "windows-x64.zip",
  ].map((suffix) => `beecode-server-${suffix}`)
  for (const name of names) {
    for (const asset of [name, `${name}.sig`]) {
      release.assets.push({
        name: asset,
        browser_download_url: `https://github.com/EvanZheng11/beecode/releases/download/v${version}/${asset}`,
      })
    }
    writeFileSync(join(sigDir, `${name}.sig`), signatureOf(name))
  }
  for (const asset of release.assets) {
    asset.browser_download_url = `https://github.com/EvanZheng11/beecode/releases/download/v${version}/${asset.name}`
  }
  writeFileSync(releaseJson, JSON.stringify(release))
  const manifest = buildManifest({ releaseJson, sigDir, version })
  assert.equal(Object.keys(manifest.platforms).length, 12)
  assert.equal(
    manifest.platforms["windows-aarch64-nsis"].url,
    `https://github.com/EvanZheng11/beecode/releases/download/v${version}/beecode_${version}_arm64-setup.exe`
  )
  for (const [platform, entry] of Object.entries(manifest.platforms)) {
    assert.ok(entry.url.endsWith(expectedAssets(version)[platform]))
    assert.equal(
      entry.signature,
      signatureOf(expectedAssets(version)[platform])
    )
  }
  for (const name of names) {
    writeFileSync(
      releaseJson,
      JSON.stringify({
        ...release,
        assets: release.assets.filter((asset) => asset.name !== `${name}.sig`),
      })
    )
    assert.throws(
      () => buildManifest({ releaseJson, sigDir, version }),
      /服务器包缺少签名资产/
    )
  }
})
