/**
 * Effective palette and contrast audit of a custom theme: the base theme from themes.css (parsed with lib/themeAudit,
 * exactly as the theme tests do), the chosen accent layered on top, then the custom overrides, evaluated with
 * lib/contrast. Uses the same CHECKS (AA targets) as the built-in themes; failures are shown as warnings, never
 * enforced. Colours outside the subset lib/contrast understands (named colours, hsl(), oklch(), ...) are converted
 * through a 1x1 canvas in the browser (`probeColor`).
 */
import themesCss from '../styles/themes.css?raw'
import { contrast, evalColor, toHex, type Rgba } from './contrast'
import { tokenLabel, type CustomThemeData, type ThemeToken } from './customThemes'
import { CHECKS, cascade, parseBlocks, type CssBlock } from './themeAudit'
import { ACCENT_TOKENS } from './themes'

let blocks: CssBlock[] | null = null
function builtinBlocks(): CssBlock[] {
  return (blocks ??= parseBlocks(themesCss))
}

const probed = new Map<string, Rgba | null>()

/** Converts any colour the browser understands to sRGB by painting one pixel; null without a canvas (unit tests). */
export function probeColor(expr: string): Rgba | null {
  if (probed.has(expr)) return probed.get(expr)!
  let out: Rgba | null = null
  try {
    if (typeof OffscreenCanvas === 'function') {
      const ctx = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true })
      if (ctx) {
        ctx.fillStyle = expr
        ctx.fillRect(0, 0, 1, 1)
        const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
        out = { r: r!, g: g!, b: b!, a: a! / 255 }
      }
    }
  } catch {
    out = null
  }
  if (probed.size > 500) probed.clear()
  probed.set(expr, out)
  return out
}

export type Leaf = (expr: string) => Rgba | null

type Palette = Pick<CustomThemeData, 'scheme' | 'base' | 'tokens'>

/** Raw values (CSS text) of every token, as the browser would resolve them on an element showing this theme. */
export function effectiveVars(theme: Palette, accent: string | null): Record<string, string> {
  const vars = cascade(builtinBlocks(), { 'data-theme': theme.base, ...(accent ? { 'data-accent': accent } : {}) })
  vars['color-scheme'] = theme.scheme
  for (const [k, v] of Object.entries(theme.tokens)) {
    if (v === undefined) continue
    if (accent && (ACCENT_TOKENS as readonly string[]).includes(k)) continue
    vars[k] = v
  }
  return vars
}

/** The token's resolved colour, or null when it cannot be evaluated here. */
export function tokenColor(theme: Palette, accent: string | null, token: ThemeToken, leaf: Leaf = probeColor, vars = effectiveVars(theme, accent)): Rgba | null {
  try {
    return evalColor(`var(--${token})`, { vars, scheme: theme.scheme, leaf })
  } catch {
    return null
  }
}

/** `#rrggbb` for colour pickers (alpha dropped), or null. */
export function tokenHex(theme: Palette, accent: string | null, token: ThemeToken, leaf: Leaf = probeColor, vars?: Record<string, string>): string | null {
  const c = tokenColor(theme, accent, token, leaf, vars)
  return c ? toHex(c) : null
}

export interface ContrastWarning {
  fg: string
  bg: string
  ratio: number
  target: number
  why: string
}

export interface CustomThemeAudit {
  failures: ContrastWarning[]
  /** Tokens whose colour could not be evaluated (their pairs are not checked). */
  unchecked: string[]
}

export function auditCustomTheme(theme: Palette, accent: string | null, leaf: Leaf = probeColor): CustomThemeAudit {
  const vars = effectiveVars(theme, accent)
  const cache = new Map<string, Rgba | null>()
  const color = (token: string) => {
    if (!cache.has(token)) cache.set(token, tokenColor(theme, accent, token as ThemeToken, leaf, vars))
    return cache.get(token)!
  }
  const failures: ContrastWarning[] = []
  const unchecked = new Set<string>()
  for (const c of CHECKS) {
    const fg = color(c.fg)
    const bg = color(c.bg)
    if (!fg) unchecked.add(c.fg)
    if (!bg) unchecked.add(c.bg)
    if (!fg || !bg) continue
    const ratio = contrast(fg, bg)
    if (ratio + 1e-9 < c.min) failures.push({ fg: c.fg, bg: c.bg, ratio, target: c.min, why: c.why })
  }
  return { failures, unchecked: [...unchecked] }
}

/** "Muted text on Surface: 3.1:1, needs 4.5:1 (secondary text)" */
export function describeWarning(w: ContrastWarning): string {
  return `${tokenLabel(w.fg)} on ${tokenLabel(w.bg)}: ${formatRatio(w.ratio)}:1, needs ${w.target}:1 (${w.why})`
}

export function formatRatio(r: number): string {
  return (Math.floor(r * 10) / 10).toFixed(1)
}
