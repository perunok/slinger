/**
 * Custom title bar: the renderer's top bar is the window's title bar. Windows and Linux draw the system window buttons
 * (Window Controls Overlay) over its right end in the theme's colours; macOS keeps its traffic lights, moved to sit
 * centred in the bar. The page reserves room for them with the `titlebar-area-*` CSS environment variables.
 * Pure (types-only `electron` import) so it is unit-testable.
 */
import type { BrowserWindowConstructorOptions, TitleBarOverlayOptions } from 'electron'
import type { TitleBarStyle } from '../../shared/types'
import { TITLE_BAR_HEIGHT } from './windowState'

/** The top bar's `--surface` / `--text` of the default light and dark themes (src/styles/themes.css). */
export const DEFAULT_TITLE_BAR_COLORS = {
  light: { color: '#ffffff', symbolColor: '#1c2330' },
  dark: { color: '#1e2127', symbolColor: '#e4e7ec' },
} as const

/** Traffic lights are about 14 px tall; keep them vertically centred in the bar. */
const TRAFFIC_LIGHT_X = 14
const TRAFFIC_LIGHT_SIZE = 14

export function titleBarWindowOptions(
  style: TitleBarStyle,
  platform: string,
  colors: { color: string; symbolColor: string },
  height: number = TITLE_BAR_HEIGHT,
): Partial<BrowserWindowConstructorOptions> {
  if (style === 'system') return {}
  if (platform === 'darwin') {
    return {
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: TRAFFIC_LIGHT_X, y: Math.max(0, Math.round((height - TRAFFIC_LIGHT_SIZE) / 2)) },
      // Enables the titlebar-area-* CSS variables (the room the traffic lights take).
      titleBarOverlay: true,
    }
  }
  return { titleBarStyle: 'hidden', titleBarOverlay: overlayOptions(colors, height, 1) }
}

/** Overlay colours plus its height in window pixels: the bar's CSS height times the page zoom factor. */
export function overlayOptions(colors: { color: string; symbolColor: string }, cssHeight: number, zoomFactor: number): TitleBarOverlayOptions {
  const height = Math.round(Math.min(200, Math.max(16, cssHeight * (Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1))))
  return { color: colors.color, symbolColor: colors.symbolColor, height }
}

/** CSS pixel point -> window coordinates for Menu.popup (page zoom scales CSS pixels). */
export function menuPoint(x: number, y: number, zoomFactor: number): { x: number; y: number } {
  const f = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1
  return { x: Math.round(x * f), y: Math.round(y * f) }
}
