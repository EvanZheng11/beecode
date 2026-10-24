/**
 * Mermaid diagram theme for the chat's ```mermaid blocks
 * (see `./mermaid-block.tsx`).
 *
 * Mermaid's built-in `default` theme is the purple/yellow "poster" palette
 * (`#ececff` nodes, `#ffffde` clusters, Trebuchet MS, spline edges) and it has
 * no notion of the app's colours, so every diagram in a reply read as a
 * foreign screenshot. `base` + explicit `themeVariables` is the documented way
 * to take that over.
 *
 * Kept free of React and the DOM on purpose: the palettes are plain data, so
 * they can be asserted directly instead of through a render.
 */

import type { MermaidConfig } from "@streamdown/mermaid"

/** Mermaid's `flowchart.curve`. `basis` (the default) is the spline that makes
 *  a two-hop edge bulge sideways; `linear` draws axis-aligned right angles,
 *  which is how a process/architecture diagram is usually read. */
export type MermaidCurve = "linear" | "basis" | "stepBefore"

export interface MermaidDiagramOptions {
  isDarkMode: boolean
  /** Resolved UI font stack. Defaults to the app's CSS variable. */
  fontFamily?: string
  curve?: MermaidCurve
}

/**
 * `var(--font-sans)` rather than a resolved stack: the diagram is a static SVG
 * that we deliberately keep across theme switches, so a var() also follows a
 * later font change without a re-render. A `var()` inside Mermaid's injected
 * `<style>` resolves against the host element, which sits inside the app tree.
 */
const DEFAULT_FONT = "var(--font-sans)"

/** Light palette: muted blue on white, matching the app's surfaces. */
const LIGHT = {
  primaryColor: "#dbeafe",
  primaryBorderColor: "#60a5fa",
  primaryTextColor: "#1e293b",
  lineColor: "#94a3b8",
  textColor: "#334155",
  edgeLabelBackground: "#eef2f7",
  clusterBkg: "#f8fafc",
  clusterBorder: "#cbd5e1",
  titleColor: "#475569",
  /** Border of the pill-shaped edge label (see `diagramCss`). */
  edgeLabelBorder: "#e2e8f0",
} as const

/**
 * Dark palette — the same hues darkened, not Mermaid's own `dark` theme (which
 * carries its own accents). `darkMode` additionally flips Mermaid's internal
 * contrast arithmetic for edge labels and cluster titles.
 */
const DARK = {
  primaryColor: "#1e3a5f",
  primaryBorderColor: "#60a5fa",
  primaryTextColor: "#e2e8f0",
  lineColor: "#64748b",
  textColor: "#cbd5e1",
  edgeLabelBackground: "#1e293b",
  clusterBkg: "#1e293b",
  clusterBorder: "#334155",
  titleColor: "#cbd5e1",
  edgeLabelBorder: "#334155",
} as const

/**
 * Rounded nodes/clusters plus the pill-shaped edge label of the target design.
 *
 * The label rule must target `.labelBkg`: that is Mermaid's own class, the one
 * carrying `edgeLabelBackground`, and it is rendered AS the label box.
 * Styling the wrapping `<foreignObject>` (or `.edgeLabel`, which is the inner
 * text only) does nothing visible.
 *
 * `rx`/`ry` go through `themeCSS` rather than the `%%init}%%` route because
 * the node box is a generated `<rect>` with no radius attribute at all.
 */
function diagramCss(edgeLabelBorder: string): string {
  return `
.node rect, .node polygon, .node path { rx: 8; ry: 8; }
.cluster rect { rx: 12; ry: 12; }
.labelBkg {
  border-radius: 999px;
  padding: 1px 7px;
  border: 1px solid ${edgeLabelBorder};
}
`
}

/**
 * Mermaid config for one diagram. Handed straight to
 * `mermaid.getMermaid(config).render(...)`, which re-`initialize`s the engine
 * on every call — that is what makes a light/dark switch take effect.
 */
export function mermaidDiagramConfig(
  options: MermaidDiagramOptions
): MermaidConfig {
  const { isDarkMode, fontFamily = DEFAULT_FONT, curve = "linear" } = options
  const palette = isDarkMode ? DARK : LIGHT
  return {
    theme: "base",
    darkMode: isDarkMode,
    themeVariables: {
      fontFamily,
      fontSize: "14px",
      ...palette,
    },
    themeCSS: diagramCss(palette.edgeLabelBorder),
    flowchart: {
      curve,
      // Tighter than Mermaid's 50/50: the default leaves a wide empty channel
      // between ranks, which reads as padding rather than as flow.
      nodeSpacing: 45,
      rankSpacing: 50,
      padding: 12,
      // The block owns its own sizing (fit / zoom / fullscreen); Mermaid's
      // `width="100%"` + inline `max-width` is stripped anyway.
      useMaxWidth: false,
    },
  }
}
