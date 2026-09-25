/**
 * Remembered window state (`<userData>/window-state.json`): the last theme background colour, so the native
 * window is painted in the right colour before the renderer's first frame (no white/dark flash), and the
 * window's size/position/maximised state. Pure Node (no `electron` import) so it is unit-testable.
 *
 * The file is advisory: anything unreadable or invalid is ignored field by field, never fatal.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'

export const WINDOW_STATE_FILE = 'window-state.json'

/** The `--bg` of the default light and dark themes (src/styles/themes.css), used until the renderer reported one. */
export const DEFAULT_BACKGROUND = { light: '#f4f5f7', dark: '#16181d' } as const

export const DEFAULT_SIZE = { width: 1400, height: 900 } as const
export const MIN_SIZE = { width: 900, height: 600 } as const

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowState {
  /** Normal (un-maximised) bounds. */
  bounds?: Rect
  maximized?: boolean
  /** Opaque `#rrggbb`. */
  backgroundColor?: string
}

const int = z.number().int().min(-100_000).max(100_000)
const rectSchema = z.object({ x: int, y: int, width: int.min(1), height: int.min(1) })

const byte = (s: string, max = 255): number | null => {
  const t = s.trim()
  if (!/^\d+(\.\d+)?%?$/.test(t)) return null
  const n = t.endsWith('%') ? (parseFloat(t) / 100) * 255 : parseFloat(t)
  return n >= 0 && n <= max ? Math.round(n) : null
}
const hex2 = (n: number) => n.toString(16).padStart(2, '0')

/**
 * Parses a CSS hex (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`) or `rgb()`/`rgba()` colour (comma or space syntax)
 * into an opaque lowercase `#rrggbb` (alpha is dropped: a window background is always opaque). Null otherwise.
 */
export function normalizeCssColor(input: string): string | null {
  const s = input.trim().toLowerCase()
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s)
  if (hex) {
    const h = hex[1]!
    const full = h.length <= 4 ? [...h.slice(0, 3)].map((c) => c + c).join('') : h.slice(0, 6)
    return `#${full}`
  }
  const fn = /^rgba?\(([^()]*)\)$/.exec(s)
  if (!fn) return null
  const body = fn[1]!
  let parts: string[]
  if (body.includes(',')) {
    parts = body.split(',') // r, g, b[, a]
  } else {
    const [channels, alpha, ...rest] = body.split('/') // r g b[ / a]
    if (rest.length > 0) return null
    parts = channels!.trim().split(/\s+/)
    if (parts.length !== 3) return null
    if (alpha !== undefined) parts.push(alpha)
  }
  if (parts.length !== 3 && parts.length !== 4) return null
  if (parts[3] !== undefined && !/^\d*\.?\d+%?$/.test(parts[3].trim())) return null
  const rgb = parts.slice(0, 3)
  const bytes = rgb.map((p) => byte(p))
  if (bytes.some((b) => b === null)) return null
  return `#${(bytes as number[]).map(hex2).join('')}`
}

/** zod schema for a CSS colour string; parses to the normalised `#rrggbb`. */
export const cssColorSchema = z
  .string()
  .max(64)
  .transform((s, ctx) => {
    const c = normalizeCssColor(s)
    if (c === null) {
      ctx.addIssue({ code: 'custom', message: 'Expected a CSS hex or rgb() colour' })
      return z.NEVER
    }
    return c
  })

/** Reads the state file; a missing, corrupt or partly invalid file yields only the valid fields. */
export function readWindowState(file: string): WindowState {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const o = raw as Record<string, unknown>
  const out: WindowState = {}
  const bounds = rectSchema.safeParse(o.bounds)
  if (bounds.success) out.bounds = bounds.data
  if (typeof o.maximized === 'boolean') out.maximized = o.maximized
  const bg = cssColorSchema.safeParse(o.backgroundColor)
  if (bg.success) out.backgroundColor = bg.data
  return out
}

/** Writes atomically (temp file + rename); failures are swallowed (the state is only a convenience). */
export function writeWindowState(file: string, state: WindowState): boolean {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2))
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

function overlap(a: Rect, b: Rect): { w: number; h: number } {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? { w, h } : { w: 0, h: 0 }
}

/**
 * Fits remembered bounds onto the current displays (`workAreas`, e.g. screen.getAllDisplays().map(d => d.workArea)).
 * Picks the display the window overlaps most; returns null (use the default size, centred) when no display shows at
 * least a 100 x 40 px piece of it any more. Otherwise shrinks it to that display (never below `min` unless the display
 * is smaller) and moves it fully inside.
 */
export function clampBounds(bounds: Rect, workAreas: Rect[], min: { width: number; height: number } = MIN_SIZE): Rect | null {
  let best: Rect | null = null
  let bestArea = 0
  for (const wa of workAreas) {
    const { w, h } = overlap(bounds, wa)
    if (w < Math.min(bounds.width, 100) || h < Math.min(bounds.height, 40)) continue
    if (w * h > bestArea) {
      best = wa
      bestArea = w * h
    }
  }
  if (!best) return null
  const width = Math.min(Math.max(bounds.width, Math.min(min.width, best.width)), best.width)
  const height = Math.min(Math.max(bounds.height, Math.min(min.height, best.height)), best.height)
  const x = Math.min(Math.max(bounds.x, best.x), best.x + best.width - width)
  const y = Math.min(Math.max(bounds.y, best.y), best.y + best.height - height)
  return { x, y, width, height }
}
