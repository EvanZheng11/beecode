import { render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

import SettingsMonitoringPage from "./page"

vi.mock("@/components/settings/resource-monitor-settings", () => ({
  ResourceMonitorSettings: () => <div data-testid="monitor-settings" />,
}))

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({
    children,
    className,
  }: {
    children: ReactNode
    className?: string
  }) => (
    <div data-testid="monitor-scroll-area" className={className}>
      {children}
    </div>
  ),
}))

describe("监控页面布局", () => {
  it("以占满父容器的滚动区域包裹监控内容，并保留响应式内边距", () => {
    render(<SettingsMonitoringPage />)

    const scrollArea = screen.getByTestId("monitor-scroll-area")
    const settings = screen.getByTestId("monitor-settings")
    expect(scrollArea).toHaveClass("h-full")
    expect(scrollArea).toContainElement(settings)
    expect(settings.parentElement).toHaveClass(
      "mx-auto",
      "w-full",
      "max-w-[80rem]",
      "p-4",
      "md:p-6"
    )
  })
})
