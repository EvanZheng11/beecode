import { useState } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SearchInput } from "./search-input"
import { Command, CommandInput, CommandItem, CommandList } from "./command"

vi.mock("next-intl", () => ({ useTranslations: () => () => "Clear search" }))
afterEach(cleanup)

describe("search clear", () => {
  it("clears a controlled input and restores focus", () => {
    function Example() {
      const [value, setValue] = useState("text")
      return (
        <SearchInput
          aria-label="Search"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      )
    }
    render(<Example />)
    const input = screen.getByLabelText("Search")
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }))
    expect(input).toHaveValue("")
    expect(input).toHaveFocus()
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull()
  })

  it.each([false, true])("clears cmdk with controlled=%s", (controlled) => {
    function Example() {
      const [value, setValue] = useState("")
      return (
        <Command>
          <CommandInput
            aria-label="Search"
            {...(controlled ? { value, onValueChange: setValue } : {})}
          />
          <CommandList>
            <CommandItem>alpha</CommandItem>
            <CommandItem>beta</CommandItem>
          </CommandList>
        </Command>
      )
    }
    render(<Example />)
    const input = screen.getByLabelText("Search")
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull()
    fireEvent.change(input, { target: { value: "alpha" } })
    expect(screen.queryByText("beta")).toBeNull()
    const clear = screen.getByRole("button", { name: "Clear search" })
    fireEvent.keyDown(clear, { key: "Enter" })
    fireEvent.click(clear)
    expect(screen.getByText("beta")).toBeInTheDocument()
    expect(input).toHaveValue("")
    expect(input).toHaveFocus()
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull()
  })
})
