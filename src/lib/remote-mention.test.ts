import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  REMOTE_MENTION_CACHE_MAX_ENTRIES,
  REMOTE_MENTION_CACHE_TTL_MS,
  buildRemoteMentionUri,
  clearRemoteMentionCache,
  classifyRemoteMentionError,
  listRemoteMentionFolders,
  parseRemoteMentionUri,
  isPublicHttpBaseUrl,
  resetRemoteMentionConnectionsForTests,
  refreshRemoteMentionConnections,
  supportsRemoteRun,
  useRemoteMentionConnectionState,
  type RemoteMentionTarget,
} from "./remote-mention"

// 远程列表请求走 shell 传输层；测试里只数调用次数、控制何时落地。
const transport = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock("@/lib/transport", () => ({ getShellTransport: () => transport }))

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

describe("远程列表结构化错误分类", () => {
  it.each([
    [{ code: "authentication_failed", message: "凭据已失效" }, "token"],
    [{ code: "network_error", message: "连接失败" }, "offline"],
    [{ code: "network_error", message: "远程列表请求超时" }, "timeout"],
    [{ code: "invalid_input", message: "参数无效" }, "unknown"],
    [new Error("remote_mention_timeout"), "timeout"],
    ["connection refused", "offline"],
  ] as const)("按真实拒绝体分类：%j", (error, expected) => {
    expect(classifyRemoteMentionError(error)).toBe(expected)
  })
})

describe("远程列表缓存与连接订阅", () => {
  afterEach(() => {
    clearRemoteMentionCache()
    resetRemoteMentionConnectionsForTests()
    transport.call.mockReset()
    vi.restoreAllMocks()
  })

  it("访问超过上限的键会淘汰最旧条目，过期条目不再滞留", async () => {
    transport.call.mockResolvedValue([])
    const now = vi.spyOn(Date, "now")
    let clock = 1_000
    now.mockImplementation(() => clock)

    const total = REMOTE_MENTION_CACHE_MAX_ENTRIES + 5
    for (let id = 1; id <= total; id += 1) {
      clock += 1
      await listRemoteMentionFolders(id)
    }
    expect(transport.call).toHaveBeenCalledTimes(total)

    // 最早的键已被淘汰：再访问要重新请求。
    clock += 1
    await listRemoteMentionFolders(1)
    expect(transport.call).toHaveBeenCalledTimes(total + 1)

    // 最新的键仍在缓存里。
    clock += 1
    await listRemoteMentionFolders(total)
    expect(transport.call).toHaveBeenCalledTimes(total + 1)

    // 整批过期后再访问，缓存里只剩新条目，旧条目全部清掉。
    clock += REMOTE_MENTION_CACHE_TTL_MS + 1
    await listRemoteMentionFolders(1)
    expect(transport.call).toHaveBeenCalledTimes(total + 2)
    await listRemoteMentionFolders(1)
    expect(transport.call).toHaveBeenCalledTimes(total + 2)
  })

  it("清空缓存后，清空前发出的请求不会把旧结果写回新缓存", async () => {
    let resolveStale: (value: unknown) => void = () => {}
    transport.call.mockImplementationOnce(
      () => new Promise((resolve) => (resolveStale = resolve))
    )
    const stale = listRemoteMentionFolders(1)
    clearRemoteMentionCache()
    resolveStale([{ id: 1, name: "旧", path: "/old", alias: null }])
    expect(await stale).toHaveLength(1)

    transport.call.mockResolvedValueOnce([
      { id: 2, name: "新", path: "/new", alias: null },
    ])
    const fresh = await listRemoteMentionFolders(1)
    expect(fresh.map((folder) => folder.id)).toEqual([2])
    expect(transport.call).toHaveBeenCalledTimes(2)
  })

  it("多链接共享一个 focus 监听，无订阅时不监听也不请求", async () => {
    transport.call.mockResolvedValue([])
    const add = vi.spyOn(window, "addEventListener")
    const remove = vi.spyOn(window, "removeEventListener")
    const focusCalls = () =>
      add.mock.calls.filter(([type]) => type === "focus").length
    const focusRemovals = () =>
      remove.mock.calls.filter(([type]) => type === "focus").length

    const views = [1, 2, 3].map((connectionId) =>
      renderHook(() => useRemoteMentionConnectionState(connectionId))
    )
    await act(async () => {})
    expect(focusCalls()).toBe(1)
    // 共享快照只拉一次。
    expect(transport.call).toHaveBeenCalledTimes(1)
    expect(views[0].result.current).toBe("missing")

    for (const view of views) view.unmount()
    expect(focusRemovals()).toBe(1)

    // 没有订阅者后，切焦不再触发请求。
    const before = transport.call.mock.calls.length
    window.dispatchEvent(new Event("focus"))
    await act(async () => {})
    expect(transport.call).toHaveBeenCalledTimes(before)
  })

  it("普通链接不订阅远程连接：不监听 focus，也不发请求", async () => {
    const add = vi.spyOn(window, "addEventListener")
    let renders = 0
    const view = renderHook(() => {
      renders += 1
      return useRemoteMentionConnectionState(null, false)
    })
    await act(async () => {})
    expect(view.result.current).toBe("unknown")
    expect(add.mock.calls.filter(([type]) => type === "focus")).toHaveLength(0)
    expect(transport.call).not.toHaveBeenCalled()

    // 另一个远程徽标刷新共享快照时，普通链接也不应订阅并跟着重渲染。
    const initialRenders = renders
    transport.call.mockResolvedValue([])
    await act(async () => refreshRemoteMentionConnections())
    expect(renders).toBe(initialRenders)
    view.unmount()
  })
})
