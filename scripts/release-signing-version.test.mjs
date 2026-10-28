// 发布签名版本门禁：node --test scripts/release-signing-version.test.mjs
// 手动 workflow_dispatch 时 GITHUB_REF_NAME 是分支名，不能写入 minisign 可信注释。
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
import { join } from "node:path"
import { test } from "node:test"
import { parse } from "yaml"

const workflow = readFileSync(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8"
)

function step(name) {
  const start = workflow.indexOf(`- name: ${name}`)
  assert.notEqual(start, -1, `缺少步骤：${name}`)
  const rest = workflow.slice(start)
  const next = rest.search(/\n {6}- name: /)
  return next === -1 ? rest : rest.slice(0, next)
}

test("服务器签名使用已解析发布标签，并校验可信注释版本", () => {
  for (const name of [
    "用更新签名密钥签服务器包（Unix）",
    "用更新签名密钥签服务器包（Windows）",
  ]) {
    const body = step(name)
    assert.match(
      body,
      /RELEASE_TAG: \$\{\{ needs\.create-draft-release\.outputs\.tag \}\}/
    )
    assert.doesNotMatch(body, /GITHUB_REF_NAME/)
    assert.match(body, /version:/)
  }
  assert.match(
    step("用更新签名密钥签服务器包（Unix）"),
    /--app-version "\$\{RELEASE_TAG#v\}"/
  )
  assert.match(
    step("用更新签名密钥签服务器包（Windows）"),
    /--app-version \$version/
  )
})

test("Unix 与 Windows 校验命令解码真实格式并拒绝错误版本", () => {
  const steps = parse(workflow).jobs["build-server"].steps
  const dir = mkdtempSync(join(tmpdir(), "codeg-signature-test-"))
  const file = join(dir, "artifact.sig")
  try {
    writeFileSync(
      file,
      Buffer.from(
        "untrusted comment: signature\nAAAA\ntrusted comment: timestamp:1\tfile:artifact\tversion:0.38.1\nBBBB\n"
      ).toString("base64")
    )
    for (const step of steps.filter((step) =>
      step.name?.startsWith("用更新签名密钥签服务器包")
    )) {
      const command = step.run
        .split("\n")
        .find((line) => line.startsWith("node -e '"))
      assert.ok(command, step.name)
      const code = command.match(/^node -e '([^']+)'/)[1]
      assert.match(
        execFileSync(process.execPath, ["-e", code, file, "0.38.1"], {
          encoding: "utf8",
        }),
        /version:0.38.1/
      )
      assert.notEqual(
        spawnSync(process.execPath, ["-e", code, file, "0.38.10"]).status,
        0
      )
      assert.notEqual(
        spawnSync(process.execPath, ["-e", code, file, "main"]).status,
        0
      )
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("标签推送仍从 GITHUB_REF_NAME 解析发布标签", () => {
  const start = workflow.indexOf("name: 解析源码与发布通道")
  assert.notEqual(start, -1)
  const meta = workflow.slice(start, start + 2500)
  assert.match(meta, /workflow_dispatch/)
  assert.match(meta, /refs\/tags\/\*/)
  assert.match(meta, /TAG="\$GITHUB_REF_NAME"/)
  assert.match(meta, /tag=%s/)
})

test("仅构建 Artifacts 时使用源码版本，已解析标签优先", () => {
  const steps = parse(workflow).jobs["build-server"].steps
  const unix = steps.find(
    (step) => step.name === "用更新签名密钥签服务器包（Unix）"
  )
  const prelude = unix.run.slice(0, unix.run.indexOf("file="))
  const version = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url))
  ).version
  for (const tag of ["", "v0.38.1", "v0.38.1-rc.1+test"]) {
    const result = execFileSync(
      "bash",
      ["-c", prelude + 'printf "%s" "$RELEASE_TAG"'],
      {
        cwd: new URL("../", import.meta.url),
        env: {
          ...process.env,
          TAURI_SIGNING_PRIVATE_KEY: "test",
          RELEASE_TAG: tag,
        },
        encoding: "utf8",
      }
    )
    assert.equal(result, tag || "v" + version)
  }
  const windows = steps.find(
    (step) => step.name === "用更新签名密钥签服务器包（Windows）"
  )
  assert.ok(windows.run.includes("IsNullOrEmpty($env:RELEASE_TAG)"))
  assert.ok(windows.run.includes('require("./package.json").version'))
})

test("BeeCode 版本、更新源及兼容契约一致", () => {
  const read = (file) =>
    readFileSync(new URL(`../${file}`, import.meta.url), "utf8")
  const pkg = JSON.parse(read("package.json"))
  const config = JSON.parse(read("src-tauri/tauri.conf.json"))
  const cargo = read("src-tauri/Cargo.toml")
  assert.equal(pkg.name, "beecode")
  assert.equal(pkg.version, "0.41.1")
  assert.equal(config.version, pkg.version)
  assert.equal(config.productName, "BeeCode")
  assert.equal(config.mainBinaryName, "codeg")
  assert.equal(config.identifier, "app.codeg")
  assert.deepEqual(config.bundle.linux.deb.conflicts, ["codeg"])
  assert.deepEqual(config.bundle.linux.deb.replaces, ["codeg"])
  assert.deepEqual(config.bundle.linux.rpm.obsoletes, ["codeg"])
  assert.deepEqual(config.bundle.linux.rpm.provides, ["codeg"])
  assert.deepEqual(config.plugins["deep-link"].desktop.schemes, ["codeg"])
  assert.deepEqual(config.plugins.updater.endpoints, [
    "https://github.com/EvanZheng11/beecode/releases/latest/download/latest.json",
  ])
  assert.match(cargo, /\[package\]\nname = "beecode"\nversion = "0\.41\.1"/)
  assert.match(
    read("src-tauri/Cargo.lock"),
    /name = "beecode"\nversion = "0\.41\.1"/
  )
  assert.match(cargo, /default-run = "codeg"/)
  assert.match(cargo, /\[lib\][\s\S]*?name = "codeg_lib"/)
  assert.match(cargo, /tauri-plugin-opener = \{ version = "2"/)
  assert.match(cargo, /webview2-com = \{ version = "0\.39"/)
  assert.match(cargo, /windows = \{ version = "0\.62"/)
  assert.equal(pkg.dependencies["@tauri-apps/plugin-opener"], "^2.7.2")
  assert.match(read("src-tauri/src/cli/connect.rs"), /base\.join\("codeg"\)/)
  assert.match(
    read("src-tauri/src/cli/commands.rs"),
    /open_url\("codeg:\/\/open"/
  )
})

test("BeeCode 发布保留六桌面、五服务器和完整发布依赖", () => {
  const jobs = parse(workflow).jobs
  const desktop = jobs["build-tauri"]
  assert.equal(desktop.strategy["fail-fast"], false)
  assert.deepEqual(
    desktop.strategy.matrix.include.map((cell) => cell.target).sort(),
    [
      "x86_64-unknown-linux-gnu",
      "aarch64-unknown-linux-gnu",
      "x86_64-pc-windows-msvc",
      "aarch64-pc-windows-msvc",
      "x86_64-apple-darwin",
      "aarch64-apple-darwin",
    ].sort()
  )
  const server = jobs["build-server"]
  assert.equal(server.strategy["fail-fast"], false)
  assert.equal(server.strategy.matrix.include.length, 5)
  const install = readFileSync(
    new URL("../src-tauri/src/update/install.rs", import.meta.url),
    "utf8"
  )
  for (const cell of server.strategy.matrix.include) {
    assert.ok(cell.artifact.startsWith("beecode-server-"))
    assert.ok(install.includes(`"${cell.artifact}"`))
  }
  for (const need of [
    "build-tauri",
    "build-server",
    "build-docker",
    "generate-updater-manifest",
  ]) {
    assert.ok(jobs["publish-release"].needs.includes(need))
    assert.ok(
      jobs["publish-release"].if.includes(`needs.${need}.result == 'success'`)
    )
  }
  for (const need of ["build-tauri", "build-server"]) {
    assert.ok(jobs["generate-updater-manifest"].needs.includes(need))
  }
  const actions = desktop.steps.filter((step) =>
    step.uses?.startsWith("tauri-apps/tauri-action@")
  )
  assert.equal(actions.length, 4)
  for (const action of actions) {
    assert.equal(action.uses, "tauri-apps/tauri-action@v0.6.1")
    assert.equal(
      action.with.assetNamePattern,
      "beecode_[version]_[arch][setup][ext]"
    )
    assert.equal(action.with.includeUpdaterJson, false)
  }
  assert.match(workflow, /format\('\{0\}\/beecode:/)
})

test("BeeCode 安装包校验文件与上传资产同名（Unix）", () => {
  const run = parse(workflow).jobs["build-tauri"].steps.find(
    (step) => step.name === "生成桌面安装包 SHA256SUMS（Unix）"
  ).run
  const dir = mkdtempSync(join(tmpdir(), "beecode-installers-"))
  try {
    const fixtures = [
      [
        "x86_64-unknown-linux-gnu",
        [
          ["deb", "BeeCode_0.41.1_amd64.deb", "beecode_0.41.1_amd64.deb"],
          ["rpm", "BeeCode-0.41.1-1.x86_64.rpm", "beecode_0.41.1_x86_64.rpm"],
          [
            "appimage",
            "BeeCode_0.41.1_amd64.AppImage",
            "beecode_0.41.1_amd64.AppImage",
          ],
        ],
      ],
      [
        "aarch64-unknown-linux-gnu",
        [
          ["deb", "BeeCode_0.41.1_arm64.deb", "beecode_0.41.1_arm64.deb"],
          ["rpm", "BeeCode-0.41.1-1.aarch64.rpm", "beecode_0.41.1_aarch64.rpm"],
        ],
      ],
      [
        "x86_64-apple-darwin",
        [["dmg", "BeeCode_0.41.1_x64.dmg", "beecode_0.41.1_x64.dmg"]],
      ],
      [
        "aarch64-apple-darwin",
        [["dmg", "BeeCode_0.41.1_aarch64.dmg", "beecode_0.41.1_aarch64.dmg"]],
      ],
    ]
    for (const [target, files] of fixtures) {
      const bundle = join(
        dir,
        "src-tauri",
        "target",
        target,
        "release",
        "bundle"
      )
      for (const [kind, name] of files) {
        mkdirSync(join(bundle, kind), { recursive: true })
        writeFileSync(join(bundle, kind, name), "测试安装包")
      }
      execFileSync("bash", ["-c", run], {
        cwd: dir,
        env: { ...process.env, TARGET: target },
      })
      const sums = readFileSync(
        join(bundle, "installers", `SHA256SUMS-${target}.txt`),
        "utf8"
      )
      for (const [, , name] of files)
        assert.ok(sums.includes(`  ${name}\n`), sums)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
