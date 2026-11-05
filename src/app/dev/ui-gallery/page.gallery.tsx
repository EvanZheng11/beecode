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
