import { describe, expect, it } from "vitest"
import {
  buildRemoteMentionUri,
  parseRemoteMentionUri,
  isPublicHttpBaseUrl,
  supportsRemoteRun,
  type RemoteMentionTarget,
} from "./remote-mention"

const targets: RemoteMentionTarget[] = [
  { connectionId: 1, kind: "file", folderId: 2, target: "src/中文 空格.ts" },
  { connectionId: 1, kind: "session", folderId: null, target: "3" },
  { connectionId: 1, kind: "assistant", folderId: 2, target: "4" },
  { connectionId: 1, kind: "agent", folderId: 2, target: "custom-agent" },
]

describe("远程引用 URI 与访问提示", () => {
  it.each(targets)("四类引用可往返：$kind", (target) => {
    const uri = buildRemoteMentionUri(target)
    expect(uri).not.toBeNull()
    expect(parseRemoteMentionUri(uri!)).toEqual(target)
  })

  it.each([
    "codeg://remote/0/file/2/a",
    "codeg://remote/01/session/2",
    "codeg://remote/2147483648/session/2",
    "codeg://remote/1/file/2/../a",
    "codeg://remote/1/file/2/%2E%2E/a",
    "codeg://remote/1/file/2/a%2Fb",
    "codeg://remote/1/file/2/a%5Cb",
    "codeg://remote/1/file/2/%00",
    "codeg://remote/1/file/2/a?folder=3",
    "codeg://remote/1/session/2#fragment",
    "codeg://remote/1/agent/a?folder=2&folder=3",
    "codeg://remote/1/agent/a%2Fb?folder=2",
    "codeg://remote/1/assistant/4?folder=02",
    "codeg://remote/1/file/2/%ZZ",
  ])("拒绝与后端不一致的畸形引用：%s", (uri) => {
    expect(parseRemoteMentionUri(uri)).toBeNull()
  })

  it.each(["../a", "/a", "a//b", "a\\b", "C:a", "."])(
    "不生成不安全路径：%s",
    (target) => {
      expect(
        buildRemoteMentionUri({
          connectionId: 1,
          kind: "file",
          folderId: 2,
          target,
        })
      ).toBeNull()
    }
  )

  it.each([
    "http://localhost:3080",
    "http://127.0.0.1",
    "http://10.0.0.1",
    "http://172.16.0.1",
    "http://192.168.1.2",
    "http://100.64.0.1",
    "http://[::1]",
    "http://[fd00::1]",
    "http://box.local",
    "https://public.example",
  ])("安全传输或本地地址不提示公网明文：%s", (url) => {
    expect(isPublicHttpBaseUrl(url)).toBe(false)
  })

  it.each(["http://public.example", "http://8.8.8.8", "http://172.32.0.1"])(
    "公网 HTTP 提示风险：%s",
    (url) => expect(isPublicHttpBaseUrl(url)).toBe(true)
  )

  it("括号文件名不会被 Markdown 或后端 URI 扫描截断", () => {
    const target: RemoteMentionTarget = {
      connectionId: 1,
      kind: "file",
      folderId: 2,
      target: "src/a(1).ts",
    }
    const uri = buildRemoteMentionUri(target)
    expect(uri).toBe("codeg://remote/1/file/2/src/a%281%29.ts")
    expect(parseRemoteMentionUri(uri!)).toEqual(target)
  })

  it("只有明确 run 能力可启用远程执行", () => {
    expect(supportsRemoteRun(null)).toBe(false)
    expect(
      supportsRemoteRun({
        runtime: "server",
        version: "x",
        apiVersion: 1,
        capabilities: [],
      })
    ).toBe(false)
    expect(
      supportsRemoteRun({
        runtime: "server",
        version: "x",
        apiVersion: 1,
        capabilities: ["run"],
      })
    ).toBe(true)
  })
})
