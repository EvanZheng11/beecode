import { useState } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, expect, it, vi } from "vitest"
import messages from "@/i18n/messages/en.json"
import type { ProjectTrustDirectory } from "@/lib/project-trust"
import { ProjectTrustDirectoryTree } from "./project-trust-directory-tree"

const mock = vi.hoisted(() => ({ directories: vi.fn() }))
vi.mock("@/lib/project-trust", () => ({
  projectTrustDirectories: mock.directories,
}))

const dir = (name: string, path: string, hasChildren = true) =>
  ({ name, path, hasChildren }) as ProjectTrustDirectory

const selectedText = () => screen.getByTestId("selected").textContent

// 受控宿主：勾选状态由测试持有，和真实设置面板一致，逐层独立勾选才有意义。
function Harness({ disabled = false }: { disabled?: boolean }) {
  const [selected, setSelected] = useState<string[]>([])
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      <div data-testid="selected">{selected.join("|")}</div>
      <ProjectTrustDirectoryTree
        active
        disabled={disabled}
        selectedPaths={selected}
        onToggleSelected={(path) =>
          setSelected((old) =>
            old.includes(path) ? old.filter((p) => p !== path) : [...old, path]
          )
        }
      />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  mock.directories.mockReset()
})

it("根节点缺失 path 时列出本机根，展开后显示隐藏目录", async () => {
  mock.directories.mockImplementation(async (path?: string | null) => {
    if (path == null) return [dir("/", "/")]
    if (path === "/") return [dir(".hidden", "/.hidden")]
    if (path === "/.hidden") return [dir("nested", "/.hidden/nested", false)]
    return []
  })
  render(<Harness />)

  // 根列表来自不带 path 的调用。
  expect(await screen.findByRole("checkbox", { name: "/" })).toBeInTheDocument()
  expect(mock.directories).toHaveBeenCalledWith()
  expect(screen.queryByText(".hidden")).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole("button", { name: "展开 /" }))
  expect(await screen.findByText(".hidden")).toBeInTheDocument()
  expect(mock.directories).toHaveBeenCalledWith("/")

  // 隐藏目录同样可以继续展开。
  fireEvent.click(screen.getByRole("button", { name: "展开 /.hidden" }))
  expect(await screen.findByText("nested")).toBeInTheDocument()
  expect(mock.directories).toHaveBeenCalledWith("/.hidden")
})

it("展开与勾选互相独立，父子勾选不互相带动", async () => {
  mock.directories.mockImplementation(async (path?: string | null) => {
    if (path == null) return [dir("/", "/")]
    if (path === "/") return [dir("parent", "/parent")]
    if (path === "/parent") return [dir("child", "/parent/child", false)]
    return []
  })
  render(<Harness />)
  await screen.findByRole("checkbox", { name: "/" })

  // 勾选父目录不应展开它，也不应自动勾选子目录。
  fireEvent.click(screen.getByRole("checkbox", { name: "/" }))
  expect(selectedText()).toBe("/")
  expect(mock.directories).not.toHaveBeenCalledWith("/")

  // 展开父目录不改变勾选。
  fireEvent.click(screen.getByRole("button", { name: "展开 /" }))
  await screen.findByText("parent")
  expect(selectedText()).toBe("/")

  fireEvent.click(screen.getByRole("checkbox", { name: "/parent" }))
  fireEvent.click(screen.getByRole("button", { name: "展开 /parent" }))
  await screen.findByText("child")
  // 勾选父目录不会自动勾选子目录。
  expect(
    screen.getByRole("checkbox", { name: "/parent/child" })
  ).not.toBeChecked()

  fireEvent.click(screen.getByRole("checkbox", { name: "/parent/child" }))
  expect(selectedText()).toBe("/|/parent|/parent/child")
  // 取消勾选子目录不影响父目录。
  fireEvent.click(screen.getByRole("checkbox", { name: "/parent/child" }))
  expect(selectedText()).toBe("/|/parent")
  expect(screen.getByRole("checkbox", { name: "/parent" })).toBeChecked()
})

it("目录读取失败时可重试", async () => {
  let failRoot = true
  mock.directories.mockImplementation(async (path?: string | null) => {
    if (path == null) {
      if (failRoot) throw new Error("permission denied")
      return [dir("/", "/")]
    }
    return [dir("child", "/child", false)]
  })
  render(<Harness />)

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "permission denied"
  )
  failRoot = false
  fireEvent.click(screen.getByRole("button", { name: "重试" }))
  expect(await screen.findByRole("checkbox", { name: "/" })).toBeInTheDocument()
})

it("禁用时不响应展开与勾选", async () => {
  mock.directories.mockImplementation(async () => [dir("/", "/")])
  render(<Harness disabled />)
  await screen.findByRole("checkbox", { name: "/" })

  expect(screen.getByRole("checkbox", { name: "/" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "展开 /" })).toBeDisabled()
  expect(selectedText()).toBe("")
})
