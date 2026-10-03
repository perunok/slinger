/**
 * Layout commands shared by the keyboard shortcuts, the View menu, the command palette, the status bar and Settings,
 * so every entry point does exactly the same thing.
 */
import { settings, type ResponsePosition } from '../../app/settings.svelte'
import { toast } from '../../app/toast.svelte'
import { rightPanel } from './rightPanelStore.svelte'

/** Shortcut labels (Windows/Linux spelling; Cmd works as well on macOS). The renderer owns these keys (shortcuts.ts). */
export const RESPONSE_POSITION_SHORTCUT = 'Ctrl+Alt+V'
export const RIGHT_PANEL_SHORTCUT = 'Ctrl+Alt+B'
export const SIDEBAR_SHORTCUT = 'Ctrl+B'

/** What the orientation toggle does from the current position. */
export function responsePositionLabel(current: ResponsePosition): string {
  return current === 'below' ? 'Show response beside the request' : 'Show response below the request'
}

export function toggleResponsePosition(): void {
  settings.toggleResponsePosition()
}

const NO_ROOM = 'Widen the window or drag the sidebar narrower to make room next to the request.'

/** Opens or closes the right panel; opening it when the window is too narrow explains why nothing appears. */
export function toggleRightPanel(): void {
  rightPanel.toggle()
  if (rightPanel.open && !rightPanel.room) toast.info('Not enough room for the right panel', NO_ROOM)
}

/** Opens the right panel on one view. */
export function showRightPanel(id: string): void {
  rightPanel.show(id)
  if (!rightPanel.room) toast.info('Not enough room for the right panel', NO_ROOM)
}

export function rightPanelLabel(): string {
  if (!rightPanel.open) return 'Show right panel'
  return rightPanel.room ? 'Hide right panel' : 'Hide right panel (not shown: not enough room)'
}

/** Hides or shows the sidebar (collections, history, workflows); its width is kept for when it comes back. */
export function toggleSidebar(): void {
  settings.setShowSidebar(!settings.showSidebar)
}

export function toggleStatusBar(): void {
  settings.setShowStatusBar(!settings.showStatusBar)
}

/** SplitPane storage key for the request/response split: each orientation remembers its own ratio. */
export function splitKey(base: 'request' | 'example', position: ResponsePosition): string {
  return position === 'below' ? `slinger.split.${base}` : `slinger.split.${base}.beside`
}
