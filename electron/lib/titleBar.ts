/**
 * Custom title bar: the renderer's top bar is the window's title bar. On Windows and Linux the system title bar and its
 * buttons are removed and Slinger draws minimise / maximise / close itself (title bar items the user can place anywhere,
 * see src/lib/titleBarLayout.ts; actions over `windowControl`). macOS keeps its traffic lights, moved to sit centred in the
 * bar; the page reserves their room with the `titlebar-area-*` CSS environment variables. Pure (types-only `electron`
 * import) so it is unit-testable.
 */
import type { BrowserWindowConstructorOptions } from 'electron'
import type { TitleBarStyle } from '../../shared/types'
import { TITLE_BAR_HEIGHT } from './windowState'

/** Traffic lights are about 14 px tall; keep them vertically centred in the bar. */
const TRAFFIC_LIGHT_X = 14
const TRAFFIC_LIGHT_SIZE = 14

export function titleBarWindowOptions(style: TitleBarStyle, platform: string, height: number = TITLE_BAR_HEIGHT): Partial<BrowserWindowConstructorOptions> {
  if (style === 'system') return {}
  if (platform === 'darwin') {
    return {
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: TRAFFIC_LIGHT_X, y: Math.max(0, Math.round((height - TRAFFIC_LIGHT_SIZE) / 2)) },
      // Enables the titlebar-area-* CSS variables (the room the traffic lights take).
      titleBarOverlay: true,
    }
  }
  // No overlay: the window buttons are the page's own (movable) title bar items.
  return { titleBarStyle: 'hidden' }
}

/** CSS pixel point -> window coordinates for Menu.popup (page zoom scales CSS pixels). */
export function menuPoint(x: number, y: number, zoomFactor: number): { x: number; y: number } {
  const f = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1
  return { x: Math.round(x * f), y: Math.round(y * f) }
}
