/**
 * Tells the main process the custom title bar's colours (its background and text) and height, so the system window
 * buttons Windows/Linux draw over it match the theme (main remembers the colours for the next launch, like
 * windowBackground.ts). Called from settings.apply() and when the bar resizes; only sends what changed.
 */
import { toHex } from './contrast'
import { probeColor } from './customThemeAudit'

export const TITLE_BAR_SELECTOR = '[data-titlebar]'

/** Main accepts hex and rgb(); a custom theme may give oklch(), color-mix() etc., which are converted here. */
function plainColor(value: string): string {
  const v = value.trim()
  if (/^(#|rgba?\()/i.test(v)) return v
  const rgba = probeColor(v)
  return rgba ? toHex(rgba) : ''
}

let last: string | null = null

export function reportTitleBarOverlay(): void {
  try {
    const bridge = typeof window === 'undefined' ? undefined : window.slinger
    if (typeof bridge?.setTitleBarOverlay !== 'function' || typeof getComputedStyle !== 'function') return
    const bar = document.querySelector<HTMLElement>(TITLE_BAR_SELECTOR)
    if (!bar) return
    const css = getComputedStyle(bar)
    const style = { color: plainColor(css.backgroundColor), symbolColor: plainColor(css.color), height: bar.offsetHeight }
    // Unstyled (unit tests) or not laid out yet.
    if (!style.color || !style.symbolColor || style.height < 16) return
    const key = JSON.stringify(style)
    if (key === last) return
    last = key
    bridge.setTitleBarOverlay(style).catch(() => {
      last = null // retried on the next report
    })
  } catch {
    /* purely cosmetic */
  }
}

/** Test hook. */
export function resetTitleBarOverlayForTests(): void {
  last = null
}
