/**
 * Layout commands shared by the keyboard shortcuts, the View menu, the command palette, the status bar and Settings,
 * so every entry point does exactly the same thing.
 */
import { settings, type ResponsePosition } from '../../app/settings.svelte'

/** Shortcut labels (Windows/Linux spelling; Cmd works as well on macOS). The renderer owns these keys (shortcuts.ts). */
export const RESPONSE_POSITION_SHORTCUT = 'Ctrl+Alt+V'

/** What the orientation toggle does from the current position. */
export function responsePositionLabel(current: ResponsePosition): string {
  return current === 'below' ? 'Show response beside the request' : 'Show response below the request'
}

export function toggleResponsePosition(): void {
  settings.toggleResponsePosition()
}

export function toggleStatusBar(): void {
  settings.setShowStatusBar(!settings.showStatusBar)
}

/** SplitPane storage key for the request/response split: each orientation remembers its own ratio. */
export function splitKey(base: 'request' | 'example', position: ResponsePosition): string {
  return position === 'below' ? `slinger.split.${base}` : `slinger.split.${base}.beside`
}
