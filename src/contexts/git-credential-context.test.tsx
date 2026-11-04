import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import type { GitCredentials, GitHubAccount } from "@/lib/types"
import {
  GitCredentialProvider,
  useGitCredential,
} from "./git-credential-context"

const api = vi.hoisted(() => ({
  gitListRemotes: vi.fn(),
  validateGitHubToken: vi.fn(),
  getGitHubAccounts: vi.fn(),
  updateGitHubAccounts: vi.fn(),
  saveAccountToken: vi.fn(),
}))
const toast = vi.hoisted(() => ({ warning: vi.fn() }))
vi.mock("@/lib/api", () => api)
vi.mock("@/lib/platform", () => ({ openUrl: vi.fn() }))
vi.mock("sonner", () => ({ toast }))

const authError = new Error("Authentication failed")
let accounts: GitHubAccount[]
let tokens: Map<string, string>

function Harness({
  operation,
  host = "git.example.com",
}: {
  operation: (credentials?: GitCredentials) => Promise<string>
  host?: string
}) {
  const { withCredentialRetry } = useGitCredential()
  return (
    <button
      onClick={() =>
        void withCredentialRetry(operation, {
          remoteUrl: `https://${host}/org/repo.git`,
        }).catch(() => {})
      }
    >
      更新代码
    </button>
  )
}

function setup(
  operation: (credentials?: GitCredentials) => Promise<string>,
  host?: string
) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <GitCredentialProvider>
        <Harness operation={operation} host={host} />
      </GitCredentialProvider>
    </NextIntlClientProvider>
  )
}

async function submitGeneric(save = true) {
  fireEvent.change(await screen.findByPlaceholderText("Username or email"), {
    target: { value: "alice" },
  })
  fireEvent.change(
    screen.getByPlaceholderText("Password or personal access token"),
    { target: { value: "new-token" } }
  )
  if (!save) fireEvent.click(screen.getByRole("checkbox"))
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: /^Authenticate$/ }))
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  tokens = new Map([["existing", "expired-token"]])
  accounts = [
    {
      id: "existing",
      server_url: "https://git.example.com",
      username: "alice",
      scopes: [],
      avatar_url: null,
      is_default: true,
      created_at: "old",
    },
  ]
  api.getGitHubAccounts.mockImplementation(async () => ({ accounts }))
  api.updateGitHubAccounts.mockImplementation(async (settings) => {
    accounts = settings.accounts
  })
  api.saveAccountToken.mockImplementation(async (id, token) => {
    tokens.set(id, token)
  })
})

describe("GitCredentialProvider 凭据持久化", () => {
  it("更新已有账号的令牌，下一次由后端自动读取后不再弹窗", async () => {
    const operation = vi.fn(async (credentials?: GitCredentials) => {
      if ((credentials?.password ?? tokens.get("existing")) !== "new-token")
        throw authError
      return "updated"
    })
    setup(operation)
    fireEvent.click(screen.getByText("更新代码"))
    await submitGeneric()
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    )
    expect(api.saveAccountToken).toHaveBeenCalledWith("existing", "new-token")
    expect(api.updateGitHubAccounts).not.toHaveBeenCalled()
    await act(async () => fireEvent.click(screen.getByText("更新代码")))
    expect(operation).toHaveBeenCalledTimes(3)
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("非默认端口的凭据不会覆盖同域名另一服务的账号", async () => {
    setup(
      vi.fn().mockRejectedValueOnce(authError).mockResolvedValue("updated"),
      "git.example.com:8443"
    )
    fireEvent.click(screen.getByText("更新代码"))
    await submitGeneric()
    await waitFor(() =>
      expect(api.updateGitHubAccounts).toHaveBeenCalledTimes(1)
    )
    expect(accounts).toHaveLength(2)
    expect(accounts[1].server_url).toBe("https://git.example.com:8443")
    expect(tokens.get("existing")).toBe("expired-token")
  })

  it("不勾选记住凭据时不覆盖已有令牌", async () => {
    setup(vi.fn().mockRejectedValueOnce(authError).mockResolvedValue("updated"))
    fireEvent.click(screen.getByText("更新代码"))
    await submitGeneric(false)
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    )
    expect(api.saveAccountToken).not.toHaveBeenCalled()
  })

  it("新增账号先保存令牌再保存账号信息", async () => {
    accounts = []
    setup(vi.fn().mockRejectedValueOnce(authError).mockResolvedValue("updated"))
    fireEvent.click(screen.getByText("更新代码"))
    await submitGeneric()
    await waitFor(() =>
      expect(api.updateGitHubAccounts).toHaveBeenCalledTimes(1)
    )
    expect(accounts[0]).toMatchObject({
      server_url: "https://git.example.com",
      username: "alice",
    })
    expect(tokens.get(accounts[0].id)).toBe("new-token")
  })

  it("保存失败时提示，但不重复执行已经成功的 Git 操作", async () => {
    api.saveAccountToken.mockRejectedValue(new Error("storage unavailable"))
    const operation = vi
      .fn()
      .mockRejectedValueOnce(authError)
      .mockResolvedValue("updated")
    setup(operation)
    fireEvent.click(screen.getByText("更新代码"))
    await submitGeneric()
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    )
    expect(operation).toHaveBeenCalledTimes(2)
    expect(toast.warning).toHaveBeenCalledTimes(1)
  })

  it("GitHub 重新验证后刷新已有账号令牌，不新增重复账号", async () => {
    accounts[0].server_url = "https://github.com"
    api.validateGitHubToken.mockResolvedValue({
      success: true,
      username: "alice",
      scopes: ["repo"],
      avatar_url: null,
    })
    setup(
      vi.fn().mockRejectedValueOnce(authError).mockResolvedValue("updated"),
      "github.com"
    )
    fireEvent.click(screen.getByText("更新代码"))
    fireEvent.change(await screen.findByPlaceholderText("ghp_xxxxxxxxxxxx"), {
      target: { value: "new-token" },
    })
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: "Validate & Connect" })
      )
    )
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    )
    expect(api.saveAccountToken).toHaveBeenCalledWith("existing", "new-token")
    expect(accounts).toHaveLength(1)
  })

  it("Git 操作认证失败的凭据不能覆盖已有可用凭据", async () => {
    setup(vi.fn().mockRejectedValue(authError))
    fireEvent.click(screen.getByText("更新代码"))
    await submitGeneric()
    await screen.findByText("Invalid credentials. Please try again.")
    expect(api.saveAccountToken).not.toHaveBeenCalled()
  })
})
