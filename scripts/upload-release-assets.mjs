// 所有非 tauri-action 资产只上传到创建步骤给出的固定发布 ID。
import { execFileSync } from "node:child_process"
import { statSync } from "node:fs"
import { basename } from "node:path"
import { pathToFileURL } from "node:url"

export function uploadReleaseAssets({
  repository,
  releaseId,
  files,
  run = execFileSync,
}) {
  if (
    !/^[^/\s]+\/[^/\s]+$/.test(repository ?? "") ||
    !/^[1-9]\d*$/.test(releaseId ?? "")
  ) {
    throw new Error("上传必须指定有效仓库和固定 RELEASE_ID")
  }
  if (!files.length) throw new Error("缺少待上传文件")
  // 在删除重跑时的旧资产之前检查所有本地文件。
  for (const file of files) {
    if (!statSync(file).isFile() || statSync(file).size <= 0) {
      throw new Error(`待上传文件为空或不是普通文件：${file}`)
    }
  }
  const api = (...args) =>
    JSON.parse(run("gh", ["api", ...args], { encoding: "utf8" }) || "null")
  const endpoint = `repos/${repository}/releases/${releaseId}`
  const release = api(endpoint)
  if (!release.draft || String(release.id) !== String(releaseId)) {
    throw new Error(`发布 #${releaseId} 不是目标草稿，拒绝上传`)
  }
  const assets = api(
    "--paginate",
    "--slurp",
    `${endpoint}/assets?per_page=100`
  ).flat()
  for (const file of files) {
    const name = basename(file)
    for (const asset of assets.filter((asset) => asset.name === name)) {
      api(
        "--method",
        "DELETE",
        `repos/${repository}/releases/assets/${asset.id}`
      )
    }
    const uploaded = api(
      "--method",
      "POST",
      `https://uploads.github.com/${endpoint}/assets?name=${encodeURIComponent(name)}`,
      "--header",
      "Content-Type: application/octet-stream",
      "--input",
      file
    )
    if (
      uploaded.name !== name ||
      uploaded.state !== "uploaded" ||
      uploaded.size !== statSync(file).size
    ) {
      throw new Error(`发布 #${releaseId} 上传结果不匹配：${name}`)
    }
    console.log(`发布 #${releaseId} 已上传：${name}（${uploaded.size} 字节）`)
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  uploadReleaseAssets({
    repository: process.env.GITHUB_REPOSITORY,
    releaseId: process.env.RELEASE_ID,
    files: process.argv.slice(2),
  })
}
