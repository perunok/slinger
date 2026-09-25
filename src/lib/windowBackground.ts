/**
 * Tells the main process the active theme's background (`--bg`), so the native window is painted in that colour
 * right away and on the next launch before the first frame (main keeps it in window-state.json). Called from
 * settings.apply() on startup and on every theme/accent change; only sends when the colour actually changed.
 */
let last: string | null = null

export function reportWindowBackground(): void {
  try {
    const bridge = typeof window === 'undefined' ? undefined : window.slinger
    if (typeof bridge?.setWindowBackground !== 'function' || typeof getComputedStyle !== 'function') return
    const color = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
    if (!color || color === last) return // empty: stylesheet not loaded (unit tests)
    last = color
    bridge.setWindowBackground(color).catch(() => {
      last = null // retried on the next apply()
    })
  } catch {
    /* purely cosmetic */
  }
}

/** Test hook. */
export function resetWindowBackgroundForTests(): void {
  last = null
}
