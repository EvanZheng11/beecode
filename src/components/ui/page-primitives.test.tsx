import { fireEvent, render, screen } from "@testing-library/react"
import { Inbox } from "lucide-react"
import { Segmented, SegmentedItem } from "./segmented"
import { PageHeader } from "./page-header"
import { EmptyState } from "./empty-state"
import { StatCard } from "./stat-card"
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableContent,
  DataTableEmpty,
  DataTableFooter,
  DataTableHeader,
  DataTableRow,
} from "./data-table"

describe("页面级基础外壳", () => {
  it("页头保留语义、操作和调用者属性，不内置业务文案", () => {
    const onClick = vi.fn()
    render(
      <PageHeader
        title="项目"
        eyebrow="工作区"
        description="项目列表"
        actions={<button onClick={onClick}>新建</button>}
        aria-label="项目页头"
      />
    )
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("项目")
    expect(screen.getByText("工作区")).toHaveClass("text-primary-text")
    expect(screen.getByText("项目列表")).toHaveClass("text-muted-foreground")
    fireEvent.click(screen.getByRole("button", { name: "新建" }))
    expect(onClick).toHaveBeenCalledOnce()
    expect(screen.getByLabelText("项目页头")).toHaveAttribute(
      "data-slot",
      "page-header"
    )
  })

  it("空状态保持图标装饰性，操作由调用者提供", () => {
    render(
      <EmptyState
        icon={Inbox}
        description="还没有项目"
        action={<button>添加项目</button>}
        data-testid="empty"
      />
    )
    expect(screen.getByText("还没有项目")).toBeVisible()
    expect(screen.getByRole("button", { name: "添加项目" })).toBeEnabled()
    expect(screen.getByTestId("empty").querySelector("svg")).toHaveAttribute(
      "aria-hidden",
      "true"
    )
  })

  it("统计卡数字和标签语义不受尺寸覆盖影响", () => {
    render(
      <StatCard
        label="会话"
        value="1,280"
        icon={Inbox}
        description="本周"
        className="p-3"
        data-testid="stat"
      />
    )
    expect(screen.getByText("1,280")).toHaveClass("tabular-nums")
    expect(screen.getByTestId("stat")).toHaveClass("p-3")
    expect(screen.getByTestId("stat")).not.toHaveClass("p-5")
    expect(screen.getByText("本周")).toBeVisible()
  })

  it("分段控件沿用 Radix 的受控选择与禁用语义", () => {
    const onValueChange = vi.fn()
    render(
      <Segmented
        type="single"
        value="list"
        onValueChange={onValueChange}
        aria-label="视图"
      >
        <SegmentedItem value="list">列表</SegmentedItem>
        <SegmentedItem value="cards">卡片</SegmentedItem>
        <SegmentedItem value="disabled" disabled>
          不可用
        </SegmentedItem>
      </Segmented>
    )
    expect(screen.getByRole("radio", { name: "列表" })).toHaveAttribute(
      "aria-checked",
      "true"
    )
    fireEvent.click(screen.getByRole("radio", { name: "卡片" }))
    expect(onValueChange).toHaveBeenCalledWith("cards")
    expect(screen.getByRole("radio", { name: "不可用" })).toBeDisabled()
  })

  it("表格保留原生语义、全文标题、空行和分页外壳", () => {
    render(
      <DataTable>
        <DataTableContent aria-label="项目列表">
          <DataTableHeader>
            <tr>
              <th scope="col">名称</th>
            </tr>
          </DataTableHeader>
          <DataTableBody>
            <DataTableRow>
              <DataTableCell>长项目名称</DataTableCell>
            </DataTableRow>
            <DataTableEmpty colSpan={1}>暂无结果</DataTableEmpty>
          </DataTableBody>
        </DataTableContent>
        <DataTableFooter>
          <button>下一页</button>
        </DataTableFooter>
      </DataTable>
    )
    expect(screen.getByRole("table", { name: "项目列表" })).toBeVisible()
    expect(screen.getByRole("columnheader", { name: "名称" })).toBeVisible()
    expect(screen.getByRole("cell", { name: "长项目名称" })).toHaveAttribute(
      "title",
      "长项目名称"
    )
    expect(screen.getByRole("cell", { name: "暂无结果" })).toHaveAttribute(
      "colspan",
      "1"
    )
    expect(screen.getByRole("button", { name: "下一页" })).toBeEnabled()
  })
})
