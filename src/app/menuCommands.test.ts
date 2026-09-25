import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MENU_COMMANDS } from '../../shared/menu'
import { createMockBackend, type MockControls } from '../dev/mockBackend'
import { tabsStore } from '../features/requests/tabs.svelte'
import type { SlingerIpcApi } from '../../shared/ipc-contract'
import { runMenuCommand, subscribeMenuCommands } from './menuCommands'
import { handleShortcut } from './shortcuts'
import { toast } from './toast.svelte'
import { ui } from './ui.svelte'

let backend: SlingerIpcApi & MockControls

function resetUi() {
  ui.settingsOpen = false
  ui.shortcutsOpen = false
  ui.aboutOpen = false
  ui.closeImport()
  ui.exportCollectionId = null
  tabsStore.tabs = []
  tabsStore.activeId = null
  toast.items = []
}

const key = (k: string) => new KeyboardEvent('keydown', { key: k, ctrlKey: true, cancelable: true })

beforeEach(() => {
  backend = createMockBackend({ latencyMs: 0, seed: false })
  window.slinger = backend
  resetUi()
})
afterEach(() => {
  document.body.innerHTML = ''
  resetUi()
})

describe('menu commands in the renderer', () => {
  it('Settings, Keyboard Shortcuts and About open their dialogs', () => {
    expect(runMenuCommand('settings')).toBe(true)
    expect(ui.settingsOpen).toBe(true)
    expect(runMenuCommand('shortcuts')).toBe(true)
    expect(ui.shortcutsOpen).toBe(true)
    // Opening (not toggling): a second Keyboard Shortcuts keeps the dialog open.
    runMenuCommand('shortcuts')
    expect(ui.shortcutsOpen).toBe(true)
    expect(runMenuCommand('about')).toBe(true)
    expect(ui.aboutOpen).toBe(true)
  })

  it('Import opens the Import dialog empty', () => {
    expect(runMenuCommand('import')).toBe(true)
    expect(ui.importOpen).toBe(true)
    expect(ui.importText).toBeNull()
  })

  it('New Request opens a new tab; Close Tab closes the active one', () => {
    expect(runMenuCommand('newRequest')).toBe(true)
    expect(tabsStore.tabs).toHaveLength(1)
    expect(tabsStore.active).toBe(tabsStore.tabs[0])
    expect(runMenuCommand('closeTab')).toBe(true)
    expect(tabsStore.tabs).toHaveLength(0)
    expect(runMenuCommand('closeTab')).toBe(false) // nothing to close
  })

  it('Export Collection exports the active tab’s collection, or explains how to pick one', () => {
    expect(runMenuCommand('exportCollection')).toBe(false)
    expect(ui.exportCollectionId).toBeNull()
    expect(toast.items.map((t) => t.title)).toEqual(['No collection selected'])
    tabsStore.newTab({ collectionId: 'c1' })
    expect(runMenuCommand('exportCollection')).toBe(true)
    expect(ui.exportCollectionId).toBe('c1')
  })

  it('does not act on the page behind a modal dialog (Settings and Shortcuts still open)', () => {
    document.body.innerHTML = '<div role="dialog" aria-modal="true"></div>'
    for (const c of ['newRequest', 'import', 'exportCollection', 'about'] as const) expect(runMenuCommand(c), c).toBe(false)
    expect(tabsStore.tabs).toHaveLength(0)
    expect(ui.importOpen || ui.aboutOpen).toBe(false)
    expect(runMenuCommand('settings')).toBe(true)
  })

  it('ignores unknown commands', () => {
    for (const junk of ['quit', 'openDevTools', '', null, 42, { command: 'about' }]) expect(runMenuCommand(junk)).toBe(false)
    expect(ui.aboutOpen).toBe(false)
  })

  it('receives commands from the main process through onMenuCommand, until unsubscribed', () => {
    const off = subscribeMenuCommands()
    backend.menuCommand('about')
    expect(ui.aboutOpen).toBe(true)
    backend.menuCommand('newRequest')
    expect(tabsStore.tabs).toHaveLength(1)
    off()
    backend.menuCommand('newRequest')
    expect(tabsStore.tabs).toHaveLength(1)
  })

  it('handles every command name', () => {
    tabsStore.newTab({ collectionId: 'c1' })
    for (const c of MENU_COMMANDS) {
      resetUi()
      if (c === 'closeTab' || c === 'exportCollection') tabsStore.newTab({ collectionId: 'c1' })
      expect(runMenuCommand(c), c).toBe(true)
    }
  })

  it('never runs one key press twice (keyboard shortcut, then the menu’s key equivalent)', () => {
    const e = key('t')
    expect(handleShortcut(e)).toBe(true)
    expect(e.defaultPrevented).toBe(true)
    expect(runMenuCommand('newRequest')).toBe(false) // same press delivered by the macOS menu
    expect(tabsStore.tabs).toHaveLength(1)
    expect(runMenuCommand('newRequest')).toBe(true) // a real, separate menu click still works
    expect(tabsStore.tabs).toHaveLength(2)

    handleShortcut(key(','))
    expect(runMenuCommand('settings')).toBe(false)
    expect(ui.settingsOpen).toBe(true)
  })
})
