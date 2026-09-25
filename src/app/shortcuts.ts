import type { MenuCommand } from '../../shared/menu'
import { tabsStore } from '../features/requests/tabs.svelte'
import { sync } from '../features/sync/syncStore.svelte'
import { toast } from './toast.svelte'
import { ui } from './ui.svelte'

export function dialogOpen(): boolean {
  return !!document.querySelector('[role="dialog"][aria-modal="true"]')
}

// Keys that also appear in the application menu. The menu only shows them (registerAccelerator: false), but macOS
// always registers menu key equivalents, so remember what the keyboard just ran and let the menu skip a duplicate.
const MENU_KEYS: Partial<Record<string, MenuCommand>> = { t: 'newRequest', w: 'closeTab', ',': 'settings', '/': 'shortcuts' }
const DUPLICATE_WINDOW_MS = 300
let lastKeyboard: { command: MenuCommand; at: number } | null = null

/** True when `command` just ran from its keyboard shortcut (so a menu delivery of the same key press is a duplicate). */
export function ranFromKeyboard(command: MenuCommand, now = performance.now()): boolean {
  const recent = lastKeyboard !== null && lastKeyboard.command === command && now - lastKeyboard.at < DUPLICATE_WINDOW_MS
  if (recent) lastKeyboard = null
  return recent
}

/** Global keyboard shortcuts. Returns true when the event was handled. */
export function handleShortcut(e: KeyboardEvent): boolean {
  if (e.defaultPrevented) return false // an editor or widget already handled it
  const mod = e.ctrlKey || e.metaKey
  if (!mod || e.altKey) return false
  const key = e.key.toLowerCase()
  const tab = tabsStore.active

  const act = (fn: () => void): true => {
    e.preventDefault()
    const command = MENU_KEYS[key]
    if (command) lastKeyboard = { command, at: performance.now() }
    fn()
    return true
  }

  if (key === ',') return act(() => (ui.settingsOpen = true))
  if (key === '/') return act(() => (ui.shortcutsOpen = !ui.shortcutsOpen))
  if (dialogOpen()) return false // do not act on the page behind a dialog

  switch (key) {
    case 'enter':
      return tab ? act(() => void tabsStore.send(tab)) : false
    case 's':
      if (sync.blocked) return act(() => toast.info('Read-only workspace', `${sync.blockedMessage} Saving is disabled.`))
      return tab ? act(() => (tab.requestId || tab.overview ? void tabsStore.save(tab) : (ui.saveAsTabId = tab.id))) : act(() => {})
    case 't':
      return act(() => void tabsStore.newTab())
    case 'w':
      return tab ? act(() => tabsStore.requestClose([tab.id])) : false
    case 'k':
      return act(() => (ui.quickOpen = true))
    case 'tab':
      return act(() => tabsStore.cycle(e.shiftKey ? -1 : 1))
  }
  return false
}
