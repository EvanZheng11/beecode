"use client"

// 仅 CODEG_GALLERY=1 时作为开发路由构建，不进入正式静态导出。
import { useState } from "react"
import { useTranslations } from "next-intl"
import { useTheme } from "next-themes"
import { BarChart3, Inbox, Plus, Search } from "lucide-react"
import { useThemeColor, useZoomLevel } from "@/hooks/use-appearance"
import {
  THEME_COLORS,
  ZOOM_LEVELS,
  type ThemeColor,
  type ZoomLevel,
} from "@/lib/theme-presets"
import { toast } from "sonner"
import { AppToaster } from "@/components/ui/app-toaster"
import { Label } from "@/components/ui/label"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"
import { FolderBadge } from "@/components/ui/folder-badge"
import { AvatarBadge } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { ButtonGroup, ButtonGroupText } from "@/components/ui/button-group"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { SearchInput } from "@/components/ui/search-input"
import { Checkbox } from "@/components/ui/checkbox"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { Avatar, AvatarFallback, AvatarGroup } from "@/components/ui/avatar"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Segmented, SegmentedItem } from "@/components/ui/segmented"
import { PageHeader } from "@/components/ui/page-header"
import { EmptyState } from "@/components/ui/empty-state"
import { StatCard } from "@/components/ui/stat-card"
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableContent,
  DataTableEmpty,
  DataTableFooter,
  DataTableHeader,
  DataTableRow,
} from "@/components/ui/data-table"

// 真实调用方在 DialogContent 上传的宽度/布局 class（按 AST 扫描 143 处调用归并），
// 用来在同一页里并排核对「新默认 560px」对各类显式宽度的影响。
const DIALOG_WIDTH_FIXTURES: { id: string; className?: string }[] = [
  { id: "default" },
  { id: "sm-md", className: "sm:max-w-md" },
  { id: "sm-lg", className: "sm:max-w-lg" },
  { id: "max-lg", className: "max-w-lg" },
  { id: "sm-xl", className: "sm:max-w-xl" },
  { id: "sm-2xl", className: "sm:max-w-2xl" },
  { id: "max-3xl", className: "max-w-3xl" },
  { id: "sm-28rem", className: "sm:max-w-[28rem]" },
  { id: "sm-34rem", className: "sm:max-w-[34rem]" },
  {
    id: "p0-40rem",
    className:
      "flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[40rem]",
  },
  {
    id: "p0-wide",
    className:
      "flex h-[min(47.5rem,calc(100vh-4rem))] max-w-[min(61.25rem,calc(100vw-2rem))] flex-col gap-0 overflow-hidden p-0",
  },
]

function Sample({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-3 rounded-2xl border border-border bg-card p-5">
      <h2 className="text-heading-sm font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  )
}

export default function UiGalleryPage() {
  const t = useTranslations()
  const { themeColor, setThemeColor } = useThemeColor()
  const { zoomLevel, setZoomLevel } = useZoomLevel()
  const { theme, setTheme } = useTheme()
  const [view, setView] = useState("light")
  const [query, setQuery] = useState("")
  const title = t("AppearanceSettings.sectionTitle")
  const description = t("AppearanceSettings.sectionDescription")
  const save = t("SystemSettings.save")
  const cancel = t("AppearanceSettings.customStyle.cancel")

  return (
    <TooltipProvider>
      <AppToaster position="bottom-right" closeButton />
      <main className="app-backdrop min-h-screen px-6 py-6 text-foreground">
        <div className="mx-auto max-w-[80rem]">
          <PageHeader
            eyebrow="BeeCode · UI"
            title={title}
            description={description}
          />
          <div className="mb-6 flex flex-wrap items-center gap-3">
            <Select
              value={themeColor}
              onValueChange={(value) => setThemeColor(value as ThemeColor)}
            >
              <SelectTrigger
                aria-label={t("AppearanceSettings.themeColor.sectionTitle")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {THEME_COLORS.map((color) => (
                  <SelectItem key={color} value={color}>
                    {t(`AppearanceSettings.themeColor.options.${color}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={theme ?? "system"} onValueChange={setTheme}>
              <SelectTrigger aria-label={t("AppearanceSettings.themeMode")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["light", "dark", "system"] as const).map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {t(`AppearanceSettings.${mode}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={String(zoomLevel)}
              onValueChange={(value) =>
                setZoomLevel(Number(value) as ZoomLevel)
              }
            >
              <SelectTrigger
                aria-label={t("AppearanceSettings.zoomLevel.sectionTitle")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ZOOM_LEVELS.map((zoom) => (
                  <SelectItem key={zoom} value={String(zoom)}>
                    {zoom}%
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <Sample title="Button / ButtonGroup">
              <div className="flex flex-wrap gap-2">
                {[
                  "default",
                  "secondary",
                  "outline",
                  "ghost",
                  "destructive",
                  "link",
                ].map((variant) => (
                  <Button
                    key={variant}
                    variant={variant as "default"}
                    data-testid={`gallery-button-${variant}`}
                  >
                    {variant}
                  </Button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="xs">xs</Button>
                <Button size="sm">sm</Button>
                <Button>default</Button>
                <Button size="lg">lg</Button>
                <Button disabled>{save}</Button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button size="icon" variant="outline" aria-label={save}>
                      <Plus />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{save}</TooltipContent>
                </Tooltip>
              </div>
              <ButtonGroup>
                <ButtonGroupText>ButtonGroup</ButtonGroupText>
                <Button variant="outline">A</Button>
                <Button variant="outline">B</Button>
              </ButtonGroup>
            </Sample>
            <Sample title="Input / SearchInput / Textarea">
              <Input aria-label="Input" placeholder={title} />
              <Input
                aria-label="Input invalid"
                aria-invalid
                placeholder={title}
              />
              <Input aria-label="Input disabled" disabled placeholder={title} />
              <Input aria-label="Input readonly" readOnly value={title} />
              <SearchInput
                aria-label={t("AppearanceSettings.themeColor.sectionTitle")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <Textarea aria-label="Textarea" placeholder={description} />
            </Sample>
            <Sample title="Checkbox / RadioGroup / Switch / Slider">
              <div className="flex flex-wrap items-center gap-4">
                <Checkbox aria-label="Checkbox" defaultChecked />
                <Checkbox
                  aria-label="Checkbox indeterminate"
                  checked="indeterminate"
                />
                <Checkbox aria-label="Checkbox disabled" disabled />
                <Switch aria-label="Switch" defaultChecked />
                <Switch aria-label="Switch disabled" disabled />
              </div>
              <RadioGroup
                defaultValue="light"
                aria-label={t("AppearanceSettings.themeMode")}
                className="flex gap-4"
              >
                <label className="flex items-center gap-2 text-ui">
                  <RadioGroupItem value="light" />
                  {t("AppearanceSettings.light")}
                </label>
                <label className="flex items-center gap-2 text-ui">
                  <RadioGroupItem value="dark" />
                  {t("AppearanceSettings.dark")}
                </label>
              </RadioGroup>
              <Slider aria-label="Slider" defaultValue={[45]} />
              <Progress aria-label="Progress" value={65} />
            </Sample>
            <Sample title="Tabs / Segmented">
              <Segmented
                type="single"
                value={view}
                onValueChange={(value) => value && setView(value)}
                aria-label={t("AppearanceSettings.themeMode")}
              >
                <SegmentedItem value="light">
                  {t("AppearanceSettings.light")}
                </SegmentedItem>
                <SegmentedItem value="dark">
                  {t("AppearanceSettings.dark")}
                </SegmentedItem>
              </Segmented>
              <Tabs defaultValue="light">
                <TabsList>
                  <TabsTrigger value="light">
                    {t("AppearanceSettings.light")}
                  </TabsTrigger>
                  <TabsTrigger value="dark">
                    {t("AppearanceSettings.dark")}
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="light">{description}</TabsContent>
                <TabsContent value="dark">{title}</TabsContent>
              </Tabs>
              <Tabs defaultValue="light">
                <TabsList variant="line">
                  <TabsTrigger value="light">
                    {t("AppearanceSettings.light")}
                  </TabsTrigger>
                  <TabsTrigger value="dark">
                    {t("AppearanceSettings.dark")}
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="light">{title}</TabsContent>
                <TabsContent value="dark">{description}</TabsContent>
              </Tabs>
            </Sample>
            <Sample title="Dialog / AlertDialog / DropdownMenu / Popover">
              <div className="flex flex-wrap gap-2">
                <Dialog>
                  <DialogTrigger asChild>
                    <Button variant="outline">Dialog</Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>{title}</DialogTitle>
                      <DialogDescription>{description}</DialogDescription>
                    </DialogHeader>
                    <Input aria-label="Dialog input" placeholder={title} />
                    <Select defaultValue="light">
                      <SelectTrigger
                        aria-label={t("AppearanceSettings.themeMode")}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="light">
                          {t("AppearanceSettings.light")}
                        </SelectItem>
                        <SelectItem value="dark">
                          {t("AppearanceSettings.dark")}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <DialogFooter>
                      <DialogClose asChild>
                        <Button variant="outline">{cancel}</Button>
                      </DialogClose>
                      <DialogClose asChild>
                        <Button>{save}</Button>
                      </DialogClose>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline">AlertDialog</Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{title}</AlertDialogTitle>
                      <AlertDialogDescription>
                        {description}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{cancel}</AlertDialogCancel>
                      <AlertDialogAction>{save}</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline">DropdownMenu</Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <DropdownMenuItem>{save}</DropdownMenuItem>
                    <DropdownMenuItem disabled>
                      {t("SystemSettings.loading")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive">
                      {cancel}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline">Popover</Button>
                  </PopoverTrigger>
                  <PopoverContent>
                    <p className="text-ui">{description}</p>
                  </PopoverContent>
                </Popover>
              </div>
            </Sample>
            <Sample title="Card / Badge / Avatar / Skeleton">
              <Card>
                <CardHeader>
                  <CardTitle>{title}</CardTitle>
                  <CardDescription>{description}</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-2">
                    <Badge>default</Badge>
                    <Badge variant="secondary">secondary</Badge>
                    <Badge variant="outline">outline</Badge>
                    <Badge variant="destructive">destructive</Badge>
                  </div>
                </CardContent>
              </Card>
              <AvatarGroup>
                <Avatar>
                  <AvatarFallback>A</AvatarFallback>
                </Avatar>
                <Avatar>
                  <AvatarFallback>B</AvatarFallback>
                </Avatar>
              </AvatarGroup>
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
            </Sample>
            <Sample title="StatCard / EmptyState">
              <StatCard
                label={title}
                value="1,280"
                description={description}
                icon={BarChart3}
              />
              <EmptyState
                icon={Inbox}
                description={t("SystemSettings.none")}
                action={
                  <Button variant="outline" size="sm">
                    <Search />
                    {save}
                  </Button>
                }
              />
            </Sample>
            <Sample title="Dialog widths (real caller classes)">
              <div className="flex flex-wrap gap-2">
                {DIALOG_WIDTH_FIXTURES.map(({ id, className }) => (
                  <Dialog key={id}>
                    <DialogTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        data-testid={`gallery-dialog-${id}`}
                      >
                        {id}
                      </Button>
                    </DialogTrigger>
                    <DialogContent className={className}>
                      <DialogHeader
                        className={
                          className?.includes("p-0") ? "px-6 pt-5" : undefined
                        }
                      >
                        <DialogTitle>{title}</DialogTitle>
                        <DialogDescription>{description}</DialogDescription>
                      </DialogHeader>
                      <p
                        className={
                          className?.includes("p-0")
                            ? "px-6 text-ui"
                            : "text-ui"
                        }
                      >
                        {id}
                      </p>
                      <DialogFooter
                        className={
                          className?.includes("p-0") ? "px-6 py-3.5" : undefined
                        }
                      >
                        <DialogClose asChild>
                          <Button variant="outline">{cancel}</Button>
                        </DialogClose>
                        <DialogClose asChild>
                          <Button>{save}</Button>
                        </DialogClose>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                ))}
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      data-testid="gallery-alert-sm"
                    >
                      alert-sm
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent size="sm">
                    <AlertDialogHeader>
                      <AlertDialogTitle>{title}</AlertDialogTitle>
                      <AlertDialogDescription>
                        {description}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{cancel}</AlertDialogCancel>
                      <AlertDialogAction variant="destructive">
                        {save}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </Sample>
            <Sample title="Toast / Tooltip / HoverCard / ContextMenu">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="gallery-toast-success"
                  onClick={() => toast.success(title, { description })}
                >
                  success
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="gallery-toast-error"
                  onClick={() => toast.error(title, { description })}
                >
                  error
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => toast.warning(title)}
                >
                  warning
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => toast.info(title)}
                >
                  info
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => toast.loading(title, { duration: 3200 })}
                >
                  loading
                </Button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={save}
                      data-testid="gallery-tooltip-ghost"
                    >
                      <Plus />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{save}</TooltipContent>
                </Tooltip>
                <HoverCard>
                  <HoverCardTrigger asChild>
                    <Button variant="link" size="sm">
                      HoverCard
                    </Button>
                  </HoverCardTrigger>
                  <HoverCardContent>
                    <p className="text-ui">{description}</p>
                  </HoverCardContent>
                </HoverCard>
                <ContextMenu>
                  <ContextMenuTrigger asChild>
                    <div className="rounded-lg border border-dashed border-border px-3 py-1.5 text-ui">
                      ContextMenu
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem>{save}</ContextMenuItem>
                    <ContextMenuItem variant="destructive">
                      {cancel}
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              </div>
            </Sample>
            <Sample title="Label / Field / InputGroup">
              <Field>
                <FieldLabel htmlFor="gallery-field">{title}</FieldLabel>
                <Input id="gallery-field" placeholder={description} />
                <FieldDescription>{description}</FieldDescription>
              </Field>
              <Field data-invalid="true">
                <Label htmlFor="gallery-field-invalid">{title}</Label>
                <Input
                  id="gallery-field-invalid"
                  aria-invalid
                  placeholder={description}
                />
                <FieldError>{description}</FieldError>
              </Field>
              <InputGroup>
                <InputGroupAddon>
                  <Search />
                </InputGroupAddon>
                <InputGroupInput aria-label="InputGroup" placeholder={title} />
              </InputGroup>
            </Sample>
            <Sample title="Command / Pagination / Separator / ScrollArea">
              <Command className="h-40 rounded-xl border border-border">
                <CommandInput placeholder={title} />
                <CommandList>
                  <CommandGroup>
                    <CommandItem>{save}</CommandItem>
                    <CommandItem>{cancel}</CommandItem>
                  </CommandGroup>
                </CommandList>
              </Command>
              <Pagination>
                <PaginationContent>
                  <PaginationItem>
                    <PaginationPrevious />
                  </PaginationItem>
                  <PaginationItem>
                    <PaginationLink isActive>1</PaginationLink>
                  </PaginationItem>
                  <PaginationItem>
                    <PaginationLink>2</PaginationLink>
                  </PaginationItem>
                  <PaginationItem>
                    <PaginationNext />
                  </PaginationItem>
                </PaginationContent>
              </Pagination>
              <Separator />
              <ScrollArea className="h-16 rounded-lg border border-border p-2">
                <p className="text-ui">
                  {description} {description} {description}
                </p>
              </ScrollArea>
            </Sample>
            <Sample title="Avatar sizes / FolderBadge">
              <div className="flex items-center gap-3">
                <Avatar size="sm">
                  <AvatarFallback>S</AvatarFallback>
                </Avatar>
                <Avatar>
                  <AvatarFallback>M</AvatarFallback>
                  <AvatarBadge />
                </Avatar>
                <Avatar size="lg">
                  <AvatarFallback>L</AvatarFallback>
                </Avatar>
                <FolderBadge folderId={1} folderName="BeeCode" size="sm" />
                <FolderBadge folderId={2} folderName="Codeg" size="md" />
              </div>
            </Sample>
            <Sample title="DataTable">
              <DataTable>
                <DataTableContent>
                  <caption className="sr-only">DataTable</caption>
                  <DataTableHeader>
                    <tr>
                      <th scope="col">{title}</th>
                      <th scope="col">{t("AppearanceSettings.themeMode")}</th>
                    </tr>
                  </DataTableHeader>
                  <DataTableBody>
                    <DataTableRow>
                      <DataTableCell>{description}</DataTableCell>
                      <DataTableCell>
                        {t("AppearanceSettings.light")}
                      </DataTableCell>
                    </DataTableRow>
                    <DataTableRow>
                      <DataTableCell>BeeCode</DataTableCell>
                      <DataTableCell>
                        {t("AppearanceSettings.dark")}
                      </DataTableCell>
                    </DataTableRow>
                    <DataTableEmpty colSpan={2}>
                      <EmptyState
                        icon={Inbox}
                        description={t("SystemSettings.none")}
                      />
                    </DataTableEmpty>
                  </DataTableBody>
                </DataTableContent>
                <DataTableFooter>
                  <span className="tabular-nums">1 / 1</span>
                  <Button variant="ghost" size="xs" disabled>
                    {cancel}
                  </Button>
                </DataTableFooter>
              </DataTable>
            </Sample>
          </div>
        </div>
      </main>
    </TooltipProvider>
  )
}
