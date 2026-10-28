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
import { uploadReleaseAssets } from "./upload-release-assets.mjs"
import {
  expectedAssets,
  expectedReleaseAssets,
} from "./generate-updater-manifest.mjs"

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
        .find(
          (line) =>
            line.startsWith("node -e '") && line.includes("version:${version}")
        )
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

test("客户端公钥副本一致且为可解析的 Ed25519 公钥", async () => {
  const { createPublicKey } = await import("node:crypto")
  const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"))
  const rust = readFileSync("src-tauri/src/update/verify.rs", "utf8")
  assert.equal(
    rust.match(/const TAURI_PUBKEY_B64: &str = "([^"]+)"/)[1],
    config.plugins.updater.pubkey
  )
  const text = Buffer.from(config.plugins.updater.pubkey, "base64").toString(
    "utf8"
  )
  const key = Buffer.from(text.split(/\r?\n/)[1], "base64")
  assert.equal(key.length, 42)
  assert.equal(key.subarray(0, 2).toString(), "Ed")
  assert.equal(
    key.readBigUInt64LE(2).toString(16).toUpperCase(),
    "AC1565DF083F5E9A"
  )
  assert.equal(config.plugins.updater.requireSignedVersion, true)
  assert.equal(
    createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        key.subarray(10),
      ]),
      format: "der",
      type: "spki",
    }).asymmetricKeyType,
    "ed25519"
  )
})

test("桌面与服务器签名 key ID 不匹配必须阻断发布", () => {
  const jobs = parse(workflow).jobs
  const steps = [
    ...jobs["build-server"].steps.filter((s) =>
      s.name?.startsWith("用更新签名密钥签服务器包")
    ),
    jobs["build-tauri"].steps.find((s) => s.name === "校验 updater 产物已签名"),
  ]
  const dir = mkdtempSync(join(tmpdir(), "codeg-key-id-test-"))
  try {
    const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"))
    const key = Buffer.from(
      Buffer.from(config.plugins.updater.pubkey, "base64")
        .toString("utf8")
        .split(/\r?\n/)[1],
      "base64"
    )
    const file = join(dir, "artifact.sig")
    for (const s of steps) {
      const command = s.run
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.startsWith("node -e '") && line.includes("key ID"))
      assert.ok(command, s.name)
      const code = command.match(/^node -e '([^']+)'/)[1]
      // 构造签名头检查门禁；内容签名仍由客户端独立测试验证。
      const signature = Buffer.alloc(74)
      signature.write("ED")
      key.copy(signature, 2, 2, 10)
      const write = (bytes) =>
        writeFileSync(
          file,
          Buffer.from(
            `untrusted comment: 测试\n${bytes.toString("base64")}\n`
          ).toString("base64")
        )
      write(signature)
      assert.equal(
        spawnSync(process.execPath, ["-e", code, file]).status,
        0,
        s.name
      )
      signature[2] ^= 1
      write(signature)
      assert.notEqual(
        spawnSync(process.execPath, ["-e", code, file]).status,
        0,
        s.name
      )
      write(Buffer.alloc(0))
      assert.notEqual(
        spawnSync(process.execPath, ["-e", code, file]).status,
        0,
        s.name
      )
      if (s.shell === "pwsh")
        assert.match(s.run, /if \(\$LASTEXITCODE -ne 0\).*公钥校验失败/)
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
  assert.equal(pkg.version, "0.41.2")
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
  assert.match(cargo, /\[package\]\nname = "beecode"\nversion = "0\.41\.2"/)
  assert.match(
    read("src-tauri/Cargo.lock"),
    /name = "beecode"\nversion = "0\.41\.2"/
  )
  assert.match(cargo, /default-run = "codeg"/)
  const lock = read("src-tauri/Cargo.lock")
  assert.equal([...lock.matchAll(/^name = "beecode"$/gm)].length, 1)
  assert.doesNotMatch(lock, /^name = "codeg"$/m)
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

// 真实执行创建步骤，模拟分页结果，任何歧义都必须在写入之前终止。
async function runCreate(releases) {
  const script = parse(workflow).jobs["create-draft-release"].steps.find(
    (step) => step.id === "release"
  ).with.script
  const writes = []
  const failures = []
  const outputs = {}
  const repos = {
    getCommit: async () => ({ data: { commit: { message: "测试发布" } } }),
    listReleases: () => {},
    getReleaseByTag: async () => {
      throw { status: 404 }
    },
    createRelease: async (args) => {
      writes.push(args)
      return { data: { id: 999, html_url: "test" } }
    },
    updateRelease: async (args) => {
      writes.push(args)
      return { data: { ...args, id: args.release_id, html_url: "test" } }
    },
  }
  const github = {
    rest: { repos },
    paginate: async (method, args) => {
      assert.equal(method, repos.listReleases)
      assert.equal(args.per_page, 100)
      return releases
    },
  }
  const core = {
    info() {},
    setFailed: (message) => failures.push(message),
    setOutput: (key, value) => {
      outputs[key] = value
    },
  }
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  await new AsyncFunction("github", "context", "core", "process", script)(
    github,
    { repo: { owner: "test", repo: "repo" } },
    core,
    { env: { TAG: "v0.41.1", SOURCE_REF: "test", PRERELEASE: "false" } }
  )
  return { writes, failures, outputs }
}

test("重复草稿即使位于后续分页也拒绝创建或复用", async () => {
  const releases = Array.from({ length: 100 }, (_, id) => ({
    id,
    tag_name: "v0.40.0",
    draft: false,
  }))
  releases.push(
    { id: 101, tag_name: "v0.41.1", draft: true },
    { id: 102, tag_name: "v0.41.1", draft: true }
  )
  const result = await runCreate(releases)
  assert.equal(result.writes.length, 0)
  assert.match(result.failures.join(""), /多个草稿/)
})

test("分页发现已发布版本时拒绝覆盖，唯一草稿复用固定 ID", async () => {
  const published = await runCreate([
    { id: 42, tag_name: "v0.41.1", draft: false },
  ])
  assert.equal(published.writes.length, 0)
  assert.match(published.failures.join(""), /拒绝覆盖/)
  const draft = await runCreate([{ id: 43, tag_name: "v0.41.1", draft: true }])
  assert.equal(draft.outputs.release_id, "43")
  assert.equal(draft.writes[0].release_id, 43)
  const empty = await runCreate([])
  assert.equal(empty.outputs.release_id, "999")
})

test("所有资产上传使用创建步骤的固定 ID，禁止按 tag 重新解析", () => {
  const jobs = parse(workflow).jobs
  assert.doesNotMatch(workflow, /gh release upload/)
  for (const [job, name] of [
    ["build-tauri", "上传桌面校验文件到草稿发布"],
    ["build-server", "Upload to release (Unix)"],
    ["build-server", "Upload to release (Windows)"],
    ["generate-updater-manifest", "汇总 updater 清单并执行签名门禁"],
  ]) {
    const step = jobs[job].steps.find((step) => step.name === name)
    assert.equal(
      step.env.RELEASE_ID,
      "${{ needs.create-draft-release.outputs.release_id }}"
    )
    assert.match(step.run, /upload-release-assets\.mjs/)
  }
})

test("上传脚本分页查找及替换资产始终限定同一个发布 ID", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "beecode-upload-id-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, "latest.json")
  writeFileSync(file, "{}")
  const calls = []
  const run = (command, args) => {
    assert.equal(command, "gh")
    calls.push(args)
    if (args.includes("DELETE")) return ""
    if (args.includes("POST")) {
      return JSON.stringify({ name: "latest.json", state: "uploaded", size: 2 })
    }
    if (args.includes("--paginate")) {
      return JSON.stringify([
        [{ id: 11, name: "other" }],
        [{ id: 22, name: "latest.json" }],
      ])
    }
    return JSON.stringify({ id: 43, draft: true })
  }
  uploadReleaseAssets({
    repository: "test/repo",
    releaseId: "43",
    files: [file],
    run,
  })
  assert.deepEqual(calls, [
    ["api", "repos/test/repo/releases/43"],
    [
      "api",
      "--paginate",
      "--slurp",
      "repos/test/repo/releases/43/assets?per_page=100",
    ],
    ["api", "--method", "DELETE", "repos/test/repo/releases/assets/22"],
    [
      "api",
      "--method",
      "POST",
      "https://uploads.github.com/repos/test/repo/releases/43/assets?name=latest.json",
      "--header",
      "Content-Type: application/octet-stream",
      "--input",
      file,
    ],
  ])
  assert.throws(
    () =>
      uploadReleaseAssets({
        repository: "test/repo",
        releaseId: "v0.41.1",
        files: [file],
        run,
      }),
    /固定 RELEASE_ID/
  )
  assert.throws(
    () =>
      uploadReleaseAssets({
        repository: "test/repo",
        releaseId: "43",
        files: [file],
        run: () => JSON.stringify({ id: 43, draft: false }),
      }),
    /拒绝上传/
  )
  assert.throws(
    () =>
      uploadReleaseAssets({
        repository: "test/repo",
        releaseId: "43",
        files: [file],
        run: (command, args) =>
          args.includes("POST")
            ? JSON.stringify({ name: "latest.json", state: "starter", size: 0 })
            : run(command, args),
      }),
    /上传结果不匹配/
  )
})

function publishFixture(version = "0.41.1") {
  const manifest = {
    version,
    platforms: Object.fromEntries(
      Object.entries(expectedAssets(version)).map(([platform, name]) => [
        platform,
        {
          url: `https://github.com/test/repo/releases/download/v${version}/${name}`,
          signature: Buffer.from(name).toString("base64"),
        },
      ])
    ),
  }
  const contents = Object.fromEntries(
    Object.values(expectedAssets(version)).map((name) => [
      `${name}.sig`,
      `${Buffer.from(name).toString("base64")}\n`,
    ])
  )
  contents["latest.json"] = JSON.stringify(manifest)
  const assets = expectedReleaseAssets(version).map((name, id) => ({
    id: id + 100,
    name,
    size: 1,
    state: "uploaded",
  }))
  return { manifest, contents, assets }
}

async function runPublish(
  assets,
  release = { id: 43, draft: true, tag_name: "v0.41.1" },
  {
    contents = publishFixture().contents,
    writes = [],
    downloads = [],
    version = "0.41.1",
  } = {}
) {
  const step = parse(workflow).jobs["publish-release"].steps.find(
    (step) => step.name === "Publish draft release"
  )
  const repos = {
    getRelease: async (args) => {
      assert.equal(args.release_id, 43)
      return { data: release }
    },
    listReleaseAssets: () => {},
    getReleaseAsset: async (args) => {
      assert.equal(args.owner, "test")
      assert.equal(args.repo, "repo")
      assert.equal(args.headers.accept, "application/octet-stream")
      const asset = assets.find((asset) => asset.id === args.asset_id)
      assert.ok(asset, "下载必须使用当前 Release 列举到的资产 ID")
      assert.ok(Object.hasOwn(contents, asset.name))
      downloads.push(asset.name)
      // Octokit 对二进制响应返回 ArrayBuffer。
      const data = Buffer.from(contents[asset.name])
      return {
        data: data.buffer.slice(data.byteOffset, data.byteOffset + data.length),
      }
    },
    updateRelease: async (args) => {
      writes.push(args)
    },
  }
  const github = {
    rest: { repos },
    paginate: async (method, args) => {
      assert.equal(method, repos.listReleaseAssets)
      assert.equal(args.release_id, 43)
      assert.equal(args.per_page, 100)
      return assets
    },
  }
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  await new AsyncFunction(
    "github",
    "context",
    "core",
    "process",
    step.with.script
  )(
    github,
    { repo: { owner: "test", repo: "repo" } },
    { info() {} },
    {
      env: {
        RELEASE_ID: "43",
        TAG: `v${version}`,
        PRERELEASE: String(version.includes("-")),
        GITHUB_WORKSPACE: new URL("../", import.meta.url).pathname.replace(
          /\/$/,
          ""
        ),
      },
    }
  )
  return writes
}

test("发布前按固定 ID 重新分页核验真实资产，缺失、空包、未上传均阻止发布", async () => {
  const names = expectedReleaseAssets("0.41.1")
  assert.equal(new Set(names).size, names.length)
  const { assets } = publishFixture()
  const writes = await runPublish(assets)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].release_id, 43)
  assert.equal(writes[0].draft, false)
  // 每一个包、签名、校验文件与 latest.json 都必须存在。
  for (const name of names) {
    await assert.rejects(
      runPublish(assets.filter((asset) => asset.name !== name)),
      /缺少有效资产/
    )
  }
  for (const patch of [{ size: 0 }, { state: "starter" }]) {
    await assert.rejects(
      runPublish(
        assets.map((asset, i) => (i ? asset : { ...asset, ...patch }))
      ),
      /缺少有效资产/
    )
  }
  await assert.rejects(runPublish([...assets, assets[0]]), /缺少有效资产/)
  await assert.rejects(
    runPublish(assets, { draft: false, tag_name: "v0.41.1" }),
    /拒绝发布/
  )
  await assert.rejects(
    runPublish(assets, { draft: true, tag_name: "v0.41.0" }),
    /拒绝发布/
  )
})

test("旧标签重跑的上传脚本和最终资产清单均检出 workflow SHA", () => {
  const jobs = parse(workflow).jobs
  for (const job of ["build-tauri", "build-server"]) {
    const step = jobs[job].steps.find(
      (step) => step.name === "检出当前发布上传脚本"
    )
    assert.equal(step.with.ref, "${{ github.sha }}")
    assert.equal(step.with.path, ".release-tools")
    assert.equal(
      step.with["sparse-checkout"],
      "scripts/upload-release-assets.mjs"
    )
  }
  for (const job of ["generate-updater-manifest", "publish-release"]) {
    assert.equal(jobs[job].steps[0].with.ref, "${{ github.sha }}")
  }
  for (const step of jobs["build-tauri"].steps.filter((step) =>
    step.uses?.startsWith("tauri-apps/tauri-action@")
  )) {
    assert.equal(
      step.with.releaseId,
      "${{ needs.create-draft-release.outputs.release_id }}"
    )
  }
})

for (const [version, count] of [
  ["0.41.2", 40],
  ["0.41.2-beta.1", 37],
  ["0.41.1", 40],
  ["0.41.1-beta.1", 37],
]) {
  test(`发布资产独立契约：${version} 必须有 ${count} 项`, () => {
    const names = expectedReleaseAssets(version)
    assert.equal(names.length, count)
    assert.equal(new Set(names).size, count)
    for (const name of [
      "latest.json",
      `beecode_${version}_arm64-setup.exe`,
      `beecode_${version}_arm64-setup.exe.sig`,
      ...[
        "beecode-server-linux-x64.tar.gz",
        "beecode-server-linux-arm64.tar.gz",
        "beecode-server-darwin-x64.tar.gz",
        "beecode-server-darwin-arm64.tar.gz",
        "beecode-server-windows-x64.zip",
      ].flatMap((name) => [name, `${name}.sig`, `${name}.sha256`]),
    ])
      assert.ok(names.includes(name), `缺少契约资产：${name}`)
  })

  test(`发布内容一致时按资产 ID 下载并放行：${version}`, async () => {
    const { assets, contents, manifest } = publishFixture(version)
    assert.equal(
      Object.keys(manifest.platforms).length,
      version.includes("-") ? 11 : 12
    )
    const downloads = []
    const writes = await runPublish(
      assets,
      { id: 43, draft: true, tag_name: `v${version}` },
      { version, contents, downloads }
    )
    assert.deepEqual(downloads.sort(), Object.keys(contents).sort())
    assert.equal(writes.length, 1)
    assert.equal(writes[0].prerelease, version.includes("-"))
  })
}

for (const [title, mutate, error] of [
  [
    "错误版本",
    (m) => {
      m.version = "0.41.0"
    },
    /版本/,
  ],
  [
    "错误 tag URL",
    (m) => {
      m.platforms["windows-aarch64"].url = m.platforms[
        "windows-aarch64"
      ].url.replace("v0.41.1", "v0.41.0")
    },
    /URL/,
  ],
  [
    "错误仓库 URL",
    (m) => {
      m.platforms["windows-aarch64"].url = m.platforms[
        "windows-aarch64"
      ].url.replace("test/repo", "other/repo")
    },
    /URL/,
  ],
  [
    "签名不一致",
    (m) => {
      m.platforms["windows-aarch64"].signature = "AAAA"
    },
    /签名/,
  ],
  [
    "缺少平台",
    (m) => {
      delete m.platforms["windows-aarch64"]
    },
    /平台/,
  ],
  [
    "多余平台",
    (m) => {
      m.platforms.extra = m.platforms["windows-aarch64"]
    },
    /平台/,
  ],
]) {
  test(`发布前拒绝 latest.json ${title}，且不执行发布`, async () => {
    const { assets, contents, manifest } = publishFixture()
    mutate(manifest)
    contents["latest.json"] = JSON.stringify(manifest)
    const writes = []
    await assert.rejects(
      runPublish(assets, undefined, { contents, writes }),
      error
    )
    assert.deepEqual(writes, [])
  })
}

test("发布前拒绝损坏的 JSON 和空签名，且不执行发布", async () => {
  for (const broken of [
    { "latest.json": "{" },
    { "beecode_0.41.1_arm64-setup.exe.sig": "\n" },
  ]) {
    const { assets, contents } = publishFixture()
    Object.assign(contents, broken)
    const writes = []
    await assert.rejects(runPublish(assets, undefined, { contents, writes }))
    assert.deepEqual(writes, [])
  }
})
