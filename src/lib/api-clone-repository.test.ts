import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Transport } from "./transport/types"
import { RemoteDesktopTransport } from "./transport/remote-desktop-transport"
import { WebTransport } from "./transport/web-transport"

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), getTransport: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }))
vi.mock("@/lib/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./transport")>()),
  getTransport: mocks.getTransport,
}))

import { cloneRepository } from "./api"

const url = "https://example.test/team/repo.git"
const targetDir = "/tmp/clone test/repo"
const credentials = { username: "test-user", password: "test-password" }
const authError = {
  code: "authentication_failed",
  message: "Git authentication failed",
  detail: "Authentication failed for repository",
}

let transport: Transport
const fetchMock = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  mocks.invoke.mockReset()
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
  vi.stubGlobal("localStorage", { getItem: () => null })
})

afterEach(() => {
  transport.destroy?.()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe.each(["web", "remote desktop"] as const)(
  "cloneRepository via %s",
  (mode) => {
    beforeEach(() => {
      transport =
        mode === "web"
          ? new WebTransport("http://remote.example:3080")
          : new RemoteDesktopTransport({
              id: 7,
              name: "Remote",
              baseUrl: "http://remote.example:3080",
              token: "test-token",
              windowInstanceId: "clone-test",
            })
      mocks.getTransport.mockReturnValue(transport)
    })

    it.each([undefined, null, credentials])(
      "finishes after the old deadlines and preserves credentials %j",
      async (creds) => {
        if (mode === "web") {
          fetchMock.mockImplementation(
            (_url: string, init: RequestInit) =>
              new Promise((resolve, reject) => {
                setTimeout(() => resolve(new Response("null")), 90_000)
                init.signal?.addEventListener("abort", () =>
                  reject(new DOMException("Aborted", "AbortError"))
                )
              })
          )
        } else {
          // Model the Rust proxy's default deadline at the IPC boundary.
          mocks.invoke.mockImplementation(
            (_command, args) =>
              new Promise((resolve, reject) => {
                const timeout = setTimeout(
                  () => reject(new Error("operation timed out")),
                  args.timeoutMs ?? 30_000
                )
                setTimeout(() => {
                  clearTimeout(timeout)
                  resolve(null)
                }, 90_000)
              })
          )
        }

        await Promise.all([
          expect(cloneRepository(url, targetDir, creds)).resolves.toBeNull(),
          vi.advanceTimersByTimeAsync(90_000),
        ])

        const args = { url, targetDir, credentials: creds ?? null }
        if (mode === "web") {
          expect(fetchMock).toHaveBeenCalledTimes(1)
          expect(fetchMock).toHaveBeenCalledWith(
            "http://remote.example:3080/api/clone_repository",
            expect.objectContaining({
              method: "POST",
              body: JSON.stringify(args),
            })
          )
        } else {
          expect(mocks.invoke).toHaveBeenCalledTimes(1)
          expect(mocks.invoke).toHaveBeenCalledWith("remote_http_call", {
            connectionId: 7,
            command: "clone_repository",
            args,
            timeoutMs: 600_000,
          })
        }
      }
    )

    it("propagates the backend authentication error without retrying", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(authError), { status: 400 })
      )
      mocks.invoke.mockRejectedValue(authError)

      await expect(
        cloneRepository(url, targetDir, credentials)
      ).rejects.toEqual(authError)
      expect(mode === "web" ? fetchMock : mocks.invoke).toHaveBeenCalledTimes(1)
    })

    if (mode === "web") {
      it("keeps the request alive until the 600000ms budget expires", async () => {
        let signal: AbortSignal
        fetchMock.mockImplementation(
          (_url: string, init: RequestInit) =>
            new Promise((_resolve, reject) => {
              signal = init.signal!
              signal.addEventListener("abort", () =>
                reject(new DOMException("Aborted", "AbortError"))
              )
            })
        )
        const result = cloneRepository(url, targetDir).catch(
          (error: unknown) => error
        )
        await vi.advanceTimersByTimeAsync(599_999)
        expect(signal!.aborted).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        expect(await result).toEqual(new Error("Request timed out"))
        expect(signal!.aborted).toBe(true)
        expect(fetchMock).toHaveBeenCalledTimes(1)
      })
    }
  }
)
