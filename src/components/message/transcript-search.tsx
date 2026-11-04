"use client"

import { SearchClearButton } from "@/components/ui/search-clear-button"
import { useEffect, useId, useMemo, useState, type RefObject } from "react"
import { ChevronDown, ChevronUp, RefreshCw, Search, X } from "lucide-react"
import { useTranslations } from "next-intl"
import type { MessageTurn } from "@/lib/types"

export interface SearchHit {
  index: number
  text: string
  start: number
  end: number
}

function values(text: string | null | undefined): string[] {
  if (!text) return []
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === "object") {
      const strings = (value: unknown): string[] => {
        if (typeof value === "string") return [value]
        if (typeof value === "number" || typeof value === "boolean")
          return [String(value)]
        if (Array.isArray(value)) return value.flatMap(strings)
        if (value && typeof value === "object")
          return Object.values(value).flatMap(strings)
        return []
      }
      return strings(parsed)
    }
  } catch {
    // A parser can truncate a JSON preview in the middle of a value.
    if (/^\s*[\[{]\s*["{[]/.test(text)) {
      return Array.from(text.matchAll(/"(?:\\.|[^"\\])*"?/g)).flatMap(
        (match) => {
          const token = match[0]
          const closed = token.endsWith('"') && token.length > 1
          if (closed && /^\s*:/.test(text.slice(match.index + token.length)))
            return []
          try {
            return [JSON.parse(closed ? token : `${token}"`) as string]
          } catch {
            return [token.slice(1, closed ? -1 : undefined)]
          }
        }
      )
    }
  }
  return [text]
}

export function searchTranscript(
  rows: readonly (readonly MessageTurn[])[],
  query: string
): SearchHit[] {
  if (!query) return []
  const pattern = new RegExp(
    query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "giu"
  )
  const hits: SearchHit[] = []
  rows.forEach((turns, index) => {
    for (const turn of turns)
      for (const block of turn.blocks) {
        let texts: string[] = []
        switch (block.type) {
          case "text":
          case "thinking":
            texts = [block.text]
            break
          case "tool_use":
            texts = values(block.input_preview)
            break
          case "tool_result":
            texts = values(block.output_preview)
            break
          case "turn_error":
            texts = [block.message]
            break
          case "image_generation":
            texts = values(block.revised_prompt)
            break
          case "plan":
            texts = block.entries.map((entry) => entry.content)
            break
        }
        for (const text of texts) {
          pattern.lastIndex = 0
          for (const match of text.matchAll(pattern)) {
            hits.push({
              index,
              text,
              start: match.index,
              end: match.index + match[0].length,
            })
          }
        }
      }
  })
  return hits
}

export function useTranscriptSearch({
  scope,
  rows,
  hasOlder = false,
  loadAll,
}: {
  scope: string | number
  rows: readonly (readonly MessageTurn[])[]
  hasOlder?: boolean
  loadAll?: () => Promise<boolean>
}) {
  const [state, setState] = useState({
    scope,
    open: false,
    query: "",
    selected: 0,
    retry: 0,
    jump: 0,
  })
  if (state.scope !== scope)
    setState({ scope, open: false, query: "", selected: 0, retry: 0, jump: 0 })
  const current =
    state.scope === scope
      ? state
      : { scope, open: false, query: "", selected: 0, retry: 0, jump: 0 }
  const [result, setResult] = useState<{
    scope: string | number
    attempt: number
    status: "ready" | "error"
  } | null>(null)
  const loading = !hasOlder
    ? "ready"
    : result?.scope === scope && result.attempt === current.retry
      ? result.status
      : "loading"
  useEffect(() => {
    if (!current.open || !hasOlder) return
    let cancelled = false
    void (loadAll?.() ?? Promise.resolve(false)).then(
      (ok) => {
        if (!cancelled)
          setResult({
            scope,
            attempt: current.retry,
            status: ok ? "ready" : "error",
          })
      },
      () => {
        if (!cancelled)
          setResult({ scope, attempt: current.retry, status: "error" })
      }
    )
    return () => {
      cancelled = true
    }
  }, [scope, current.open, current.retry, hasOlder, loadAll])
  const hits = useMemo(
    () => (current.open ? searchTranscript(rows, current.query) : []),
    [rows, current.open, current.query]
  )
  const selected = hits.length ? Math.min(current.selected, hits.length - 1) : 0
  return {
    open: current.open,
    query: current.query,
    hits,
    selected,
    jump: current.jump,
    loading,
    hit: hits[selected] ?? null,
    setOpen: (open: boolean) =>
      setState((s) => ({ ...s, open, retry: open ? s.retry + 1 : s.retry })),
    setQuery: (query: string) =>
      setState((s) => ({ ...s, query, selected: 0, jump: s.jump + 1 })),
    move: (delta: number) =>
      setState((s) => ({
        ...s,
        jump: s.jump + 1,
        selected: hits.length
          ? (selected + delta + hits.length) % hits.length
          : 0,
      })),
    retry: () => setState((s) => ({ ...s, retry: s.retry + 1 })),
  }
}

export function TranscriptSearchBar({
  search,
}: {
  search: ReturnType<typeof useTranscriptSearch>
}) {
  const t = useTranslations("Folder.chat.messageList")
  const button =
    "inline-flex size-7 shrink-0 items-center justify-center rounded hover:bg-muted disabled:opacity-40"
  if (!search.open)
    return (
      <div className="flex shrink-0 justify-end px-2 pt-1">
        <button
          type="button"
          className={button}
          title={t("searchOpen")}
          aria-label={t("searchOpen")}
          onClick={() => search.setOpen(true)}
        >
          <Search className="size-4" />
        </button>
      </div>
    )
  return (
    <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
      <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <input
        autoFocus
        className="min-w-0 flex-1 bg-transparent px-1 text-sm outline-none"
        value={search.query}
        placeholder={t("searchPlaceholder")}
        aria-label={t("searchPlaceholder")}
        onChange={(e) => search.setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return
          if (e.key === "Enter") {
            e.preventDefault()
            search.move(e.shiftKey ? -1 : 1)
          }
          if (e.key === "Escape") {
            e.preventDefault()
            e.stopPropagation()
            search.setOpen(false)
          }
        }}
      />
      {search.query && <SearchClearButton />}
      <span
        aria-live="polite"
        className="shrink-0 text-xs text-muted-foreground"
      >
        {search.loading === "loading"
          ? t("searchLoading")
          : search.loading === "error"
            ? t("searchIncomplete")
            : `${search.hits.length ? search.selected + 1 : 0} / ${search.hits.length}`}
      </span>
      {search.loading === "error" && (
        <button
          type="button"
          className={button}
          title={t("searchRetry")}
          aria-label={t("searchRetry")}
          onClick={search.retry}
        >
          <RefreshCw className="size-4" />
        </button>
      )}
      <button
        type="button"
        className={button}
        title={t("searchPrevious")}
        aria-label={t("searchPrevious")}
        disabled={!search.hits.length}
        onClick={() => search.move(-1)}
      >
        <ChevronUp className="size-4" />
      </button>
      <button
        type="button"
        className={button}
        title={t("searchNext")}
        aria-label={t("searchNext")}
        disabled={!search.hits.length}
        onClick={() => search.move(1)}
      >
        <ChevronDown className="size-4" />
      </button>
      <button
        type="button"
        className={button}
        title={t("searchClose")}
        aria-label={t("searchClose")}
        onClick={() => search.setOpen(false)}
      >
        <X className="size-4" />
      </button>
    </div>
  )
}

export function SearchExcerpt({ hit }: { hit: SearchHit }) {
  const t = useTranslations("Folder.chat.messageList")
  const before = Math.max(0, hit.start - 100)
  const after = Math.min(hit.text.length, hit.end + 100)
  return (
    <div
      data-search-excerpt=""
      className="my-2 whitespace-pre-wrap break-words rounded border bg-muted/50 px-3 py-2 text-xs"
      aria-label={t("searchExcerpt")}
    >
      {before > 0 && "…"}
      {hit.text.slice(before, hit.start)}
      <mark>{hit.text.slice(hit.start, hit.end)}</mark>
      {hit.text.slice(hit.end, after)}
      {after < hit.text.length && "…"}
    </div>
  )
}

export function TranscriptTextHighlights({
  containerRef,
  query,
}: {
  containerRef: RefObject<HTMLElement | null>
  query: string
}) {
  const name = `transcript-search-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`
  useEffect(() => {
    const root = containerRef.current
    if (!root || !query || typeof Highlight === "undefined" || !CSS.highlights)
      return
    let frame = 0
    const update = () => {
      const highlight = new Highlight()
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      const pattern = new RegExp(
        query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "giu"
      )
      let node: Node | null
      while ((node = walker.nextNode())) {
        if (
          node.parentElement?.closest(
            "button,input,textarea,style,script,[data-search-excerpt]"
          )
        )
          continue
        pattern.lastIndex = 0
        for (const match of (node.textContent ?? "").matchAll(pattern)) {
          const range = document.createRange()
          range.setStart(node, match.index)
          range.setEnd(node, match.index + match[0].length)
          highlight.add(range)
        }
      }
      CSS.highlights.set(name, highlight)
    }
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(update)
    })
    update()
    observer.observe(root, {
      childList: true,
      characterData: true,
      subtree: true,
    })
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      CSS.highlights.delete(name)
    }
  }, [containerRef, name, query])
  return query ? (
    <style>{`::highlight(${name}) { background-color: #fde047; color: #171717; }`}</style>
  ) : null
}
