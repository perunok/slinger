import type { MenuCommand } from '../../shared/menu'
import { toggleResponsePosition, toggleRightPanel, toggleStatusBar } from '../features/layout/layoutActions'
import { tabsStore } from '../features/requests/tabs.svelte'
import { sync } from '../features/sync/syncStore.svelte'
import { toast } from './toast.svelte'
import { ui } from './ui.svelte'
import { workflowCommands } from '../features/workflows/commands'

export function dialogOpen(): boolean {
  return !!document.querySelector('[role="dialog"][aria-modal="true"]')
}

// Keys that also appear in the application menu. The menu only shows them (registerAccelerator: false), but macOS
// always registers menu key equivalents, so remember what the keyboard just ran and let the menu skip a duplicate.
const MENU_KEYS: Partial<Record<string, MenuCommand>> = { t: 'newRequest', w: 'closeTab', ',': 'settings', '/': 'shortcuts' }
// Ctrl/Cmd+Alt+<letter> layout toggles (also View menu items, label-only there): V response position, B right panel.
const ALT_MENU_KEYS: Partial<Record<string, MenuCommand>> = { v: 'toggleResponsePosition', b: 'toggleRightPanel' }
const DUPLICATE_WINDOW_MS = 300
let lastKeyboard: { command: MenuCommand; at: number } | null = null

/** True when `command` just ran from its keyboard shortcut (so a menu delivery of the same key press is a duplicate). */
export function ranFromKeyboard(command: MenuCommand, now = performance.now()): boolean {
  const recent = lastKeyboard !== null && lastKeyboard.command === command && now - lastKeyboard.at < DUPLICATE_WINDOW_MS
  if (recent) lastKeyboard = null
  return recent
}

/**
 * The letter of a Ctrl/Cmd+Alt+<letter> press, or null. On macOS Option changes `key` (Cmd+Option+V gives "√"), so
 * with Cmd the physical key decides. With Ctrl, only an unchanged letter counts: AltGr is reported as Ctrl+Alt on
 * Windows, and AltGr+V types "@" on some layouts, which must stay typing.
 */
function altLetter(e: KeyboardEvent): string | null {
  if (!e.altKey || e.shiftKey || e.getModifierState?.('AltGraph')) return null
  if (e.metaKey && /^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase()
  if (e.ctrlKey && /^[a-z]$/i.test(e.key)) return e.key.toLowerCase()
  return null
}

/** Global keyboard shortcuts. Returns true when the event was handled. */
export function handleShortcut(e: KeyboardEvent): boolean {
  if (e.defaultPrevented) return false // an editor or widget already handled it
  const mod = e.ctrlKey || e.metaKey
  if (!mod) return false
  if (e.altKey) return handleAltShortcut(e)
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
      if (tab?.workflowId) {
        const id = tab.workflowId
        return act(() => workflowCommands.run?.(id))
      }
      return tab ? act(() => void tabsStore.send(tab)) : false
    case 's':
      // Workflows save as they are edited (local-only, so also in read-only workspaces); Ctrl+S just saves now.
      if (tab?.workflowId) {
        const id = tab.workflowId
        return act(() => workflowCommands.saveNow?.(id))
      }
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

/** Ctrl/Cmd+Alt shortcuts: layout toggles. Like the other page shortcuts, they do nothing behind a modal dialog. */
function handleAltShortcut(e: KeyboardEvent): boolean {
  const letter = altLetter(e)
  const command = letter ? ALT_MENU_KEYS[letter] : undefined
  if (!command || dialogOpen()) return false
  e.preventDefault()
  lastKeyboard = { command, at: performance.now() }
  runLayoutCommand(command)
  return true
}

/** Runs a layout toggle (keyboard, menu). Returns true for layout commands. */
export function runLayoutCommand(command: MenuCommand): boolean {
  switch (command) {
    case 'toggleResponsePosition':
      toggleResponsePosition()
      return true
    case 'toggleStatusBar':
      toggleStatusBar()
      return true
    case 'toggleRightPanel':
      toggleRightPanel()
      return true
  }
  return false
}
