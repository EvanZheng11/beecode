"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronRight, Loader2, RotateCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { toErrorMessage } from "@/lib/app-error"
import {
  projectTrustDirectories,
  type ProjectTrustDirectory,
} from "@/lib/project-trust"

// One nesting level, in px. Matches the shared directory browser's own step so
// the tree lines up with every other file/folder tree in the app.
const INDENT_STEP_PX = 16

interface ProjectTrustDirectoryTreeProps {
  /**
   * Whether the tree is on screen. Every transition to `true` starts a fresh
   * session and re-reads the native roots; in-flight reads are discarded on hide
   * so a slow listing can never land in the next session.
   */
  active: boolean
  /** While a review is in flight the tree holds still, so the paths the user is
   *  asked to confirm cannot move underneath them. */
  disabled?: boolean
  /** 明确勾选的目录；只记录用户点过的项，父/子目录互不自动带选。 */
  selectedPaths: string[]
  onToggleSelected: (path: string) => void
  heightClassName?: string
}

/**
 * 批量信任用的只读目录树。
 *
 * 与共享的 `DirectoryBrowser` 分开实现：那个组件服务于通用的“选择单个目录”，
 * 这里的每一行需要“展开”和“勾选”两个互相独立、逐层懒加载的动作，并且要显示
 * 后端返回的真实绝对路径。父目录勾选不会带动子目录，勾选子目录也不会带动父目录。
 */
export function ProjectTrustDirectoryTree({
  active,
  disabled = false,
  selectedPaths,
  onToggleSelected,
  heightClassName = "h-[18.75rem]",
}: ProjectTrustDirectoryTreeProps) {
  const t = useTranslations("ProjectTrust")
  const [roots, setRoots] = useState<ProjectTrustDirectory[] | null>(null)
  const [rootsError, setRootsError] = useState("")
  const [children, setChildren] = useState<
    Map<string, ProjectTrustDirectory[]>
  >(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [failed, setFailed] = useState<Map<string, string>>(new Map())

  // Bumped synchronously whenever the tree is hidden (or the panel unmounts);
  // a listing that resolves afterwards belongs to a session nobody is looking
  // at and must not repopulate it.
  const sessionGen = useRef(0)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const loadRoots = useCallback(async (gen: number) => {
    setRoots(null)
    setRootsError("")
    try {
      const list = await projectTrustDirectories()
      if (gen !== sessionGen.current || !mounted.current) return
      setRoots(list)
    } catch (err) {
      if (gen !== sessionGen.current || !mounted.current) return
      setRootsError(toErrorMessage(err))
    }
  }, [])

  useEffect(() => {
    sessionGen.current += 1
    const gen = sessionGen.current
    setChildren(new Map())
    setExpanded(new Set())
    setLoading(new Set())
    setFailed(new Map())
    if (!active) {
      setRoots(null)
      setRootsError("")
      return
    }
    void loadRoots(gen)
  }, [active, loadRoots])

  const loadChildren = useCallback(
    async (path: string) => {
      if (children.has(path)) return
      const gen = sessionGen.current
      setLoading((prev) => new Set(prev).add(path))
      setFailed((prev) => {
        if (!prev.has(path)) return prev
        const next = new Map(prev)
        next.delete(path)
        return next
      })
      try {
        const list = await projectTrustDirectories(path)
        if (gen !== sessionGen.current || !mounted.current) return
        setChildren((prev) => new Map(prev).set(path, list))
      } catch (err) {
        if (gen !== sessionGen.current || !mounted.current) return
        setFailed((prev) => new Map(prev).set(path, toErrorMessage(err)))
      } finally {
        if (gen === sessionGen.current && mounted.current) {
          setLoading((prev) => {
            const next = new Set(prev)
            next.delete(path)
            return next
          })
        }
      }
    },
    [children]
  )

  // 展开与勾选互不影响：点名字只展开/收起，点勾选框只记录这一项。
  const toggleExpand = useCallback(
    (path: string) => {
      if (disabled) return
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(path)) {
          next.delete(path)
        } else {
          next.add(path)
        }
        return next
      })
      // 收起时不再读盘；已缓存的目录展开时也不会重复请求。
      if (!expanded.has(path)) void loadChildren(path)
    },
    [disabled, expanded, loadChildren]
  )

  const renderRow = (
    entry: ProjectTrustDirectory,
    depth: number
  ): React.ReactNode => {
    const isExpanded = expanded.has(entry.path)
    const isSelected = selectedPaths.includes(entry.path)
    const expandLabel = entry.hasChildren
      ? `${isExpanded ? t("collapse") : t("expand")} ${entry.path}`
      : undefined
    return (
      <div key={entry.path}>
        <div
          className="flex items-center gap-1 rounded-md py-1 pe-1 hover:bg-muted/50"
          style={{ paddingInlineStart: `${depth * INDENT_STEP_PX + 4}px` }}
        >
          {entry.hasChildren ? (
            <button
              type="button"
              aria-label={expandLabel}
              aria-expanded={isExpanded}
              disabled={disabled}
              onClick={() => toggleExpand(entry.path)}
              className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
            >
              <ChevronRight
                className={cn(
                  "size-3.5 transition-transform",
                  isExpanded && "rotate-90"
                )}
                aria-hidden
              />
            </button>
          ) : (
            <span className="size-5 shrink-0" aria-hidden />
          )}
          <input
            type="checkbox"
            aria-label={entry.path}
            checked={isSelected}
            disabled={disabled}
            onChange={() => onToggleSelected(entry.path)}
            className="size-4 shrink-0 accent-primary disabled:opacity-40"
          />
          <button
            type="button"
            onClick={() => toggleExpand(entry.path)}
            disabled={disabled || !entry.hasChildren}
            className="flex min-w-0 flex-1 items-center gap-2 text-start disabled:cursor-default"
          >
            <span className="truncate text-sm">{entry.name}</span>
            {/* 后端返回的真实完整路径，供逐层确认时核对。 */}
            <span
              className="truncate font-mono text-xs text-muted-foreground"
              title={entry.path}
            >
              {entry.path}
            </span>
          </button>
        </div>
        {isExpanded && (
          <div>
            {loading.has(entry.path) ? (
              <div
                className="flex items-center gap-2 py-1.5 text-xs text-muted-foreground"
                style={{
                  paddingInlineStart: `${(depth + 1) * INDENT_STEP_PX + 28}px`,
                }}
              >
                <Loader2 className="size-3.5 animate-spin" />
                {t("loadingTree")}
              </div>
            ) : failed.has(entry.path) ? (
              <div
                className="flex items-center gap-2 py-1.5 text-xs text-destructive"
                style={{
                  paddingInlineStart: `${(depth + 1) * INDENT_STEP_PX + 28}px`,
                }}
              >
                <span className="break-all">
                  {failed.get(entry.path) || t("treeError")}
                </span>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => void loadChildren(entry.path)}
                >
                  <RotateCw className="size-3" />
                  {t("retry")}
                </Button>
              </div>
            ) : (
              renderChildren(entry.path, depth + 1)
            )}
          </div>
        )}
      </div>
    )
  }

  const renderChildren = (
    parentPath: string,
    depth: number
  ): React.ReactNode => {
    const list = children.get(parentPath)
    if (!list) return null
    if (list.length === 0) {
      return (
        <div
          className="py-1.5 text-xs text-muted-foreground"
          style={{ paddingInlineStart: `${depth * INDENT_STEP_PX + 28}px` }}
        >
          {t("emptyTree")}
        </div>
      )
    }
    return list.map((child) => renderRow(child, depth))
  }

  return (
    <div className={cn("overflow-auto rounded-md border p-1", heightClassName)}>
      {rootsError ? (
        <div
          role="alert"
          className="flex items-center gap-2 p-3 text-sm text-destructive"
        >
          <span className="break-all">{rootsError}</span>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() => {
              sessionGen.current += 1
              void loadRoots(sessionGen.current)
            }}
          >
            <RotateCw className="size-3" />
            {t("retry")}
          </Button>
        </div>
      ) : roots === null ? (
        <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          {t("loadingTree")}
        </div>
      ) : roots.length === 0 ? (
        <div className="p-3 text-sm text-muted-foreground">
          {t("emptyTree")}
        </div>
      ) : (
        roots.map((root) => renderRow(root, 0))
      )}
    </div>
  )
}
