import { toHexColor } from "./custom-style"

/** 预设使用不透明 OKLCH；无 Canvas 的首屏与测试环境用同一 sRGB 公式降级。 */
export function themeColorHex(value: string): string | null {
  const oklch = value.trim().match(/^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/)
  if (!oklch) return toHexColor(value)
  const [, lightness, chroma, hue] = oklch
  const L = Number(lightness)
  const C = Number(chroma)
  const h = (Number(hue) * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const channels = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
  return `#${channels
    .map((linear) => {
      const clamped = Math.max(0, Math.min(1, linear))
      const channel =
        clamped <= 0.0031308
          ? 12.92 * clamped
          : 1.055 * clamped ** (1 / 2.4) - 0.055
      return Math.round(channel * 255)
        .toString(16)
        .padStart(2, "0")
    })
    .join("")}`
}
