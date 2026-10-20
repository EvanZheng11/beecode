// 发布签名版本门禁：node --test scripts/release-signing-version.test.mjs
// 手动 workflow_dispatch 时 GITHUB_REF_NAME 是分支名，不能写入 minisign 可信注释。
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

const workflow = readFileSync(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8"
)

function step(name) {
  const start = workflow.indexOf(`- name: ${name}`)
  assert.notEqual(start, -1, `缺少步骤：${name}`)
  const rest = workflow.slice(start + name.length)
  const next = rest.search(/\n {6}- name: /)
  return next === -1 ? rest : rest.slice(0, next)
}

test("服务器签名使用已解析发布标签，并校验可信注释版本", () => {
  for (const name of [
    "用更新签名密钥签服务器包（Unix）",
    "用更新签名密钥签服务器包（Windows）",
  ]) {
    const body = step(name)
    assert.match(body, /RELEASE_TAG: \$\{\{ needs\.create-draft-release\.outputs\.tag \}\}/)
    assert.doesNotMatch(body, /GITHUB_REF_NAME/)
    assert.match(body, /version:/)
  }
  assert.match(step("用更新签名密钥签服务器包（Unix）"), /version:\$\{RELEASE_TAG#v\}/)
  assert.match(step("用更新签名密钥签服务器包（Windows）"), /version:\$version/)
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
