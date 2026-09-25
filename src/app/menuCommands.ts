/**
 * Application-menu commands (electron/lib/appMenu.ts -> `menu:command` -> here). Each runs the same action as the
 * matching keyboard shortcut or button, with the same guards (nothing acts on the page behind a modal dialog).
 */
import { parseMenuCommand, type MenuCommand } from '../../shared/menu'
import { tabsStore } from '../features/requests/tabs.svelte'
import { api } from '../lib/ipc'
import { dialogOpen, ranFromKeyboard } from './shortcuts'
import { toast } from './toast.svelte'
import { ui } from './ui.svelte'

/** Runs one menu command. Returns true when it did something. Unknown names are ignored. */
export function runMenuCommand(value: unknown): boolean {
  const command = parseMenuCommand(value)
  if (!command) return false
  // macOS may deliver a menu key equivalent the page already handled: never run one key press twice.
  if (ranFromKeyboard(command)) return false
  switch (command) {
    case 'settings':
      ui.settingsOpen = true
      return true
    case 'shortcuts':
      ui.shortcutsOpen = true
      return true
  }
  if (dialogOpen()) return false
  switch (command) {
    case 'newRequest':
      tabsStore.newTab()
      return true
    case 'closeTab': {
      const tab = tabsStore.active
      if (!tab) return false
      tabsStore.requestClose([tab.id])
      return true
    }
    case 'import':
      ui.openImport()
      return true
    case 'exportCollection': {
      const collectionId = tabsStore.active?.collectionId
      if (!collectionId) {
        toast.info('No collection selected', 'Open a request or overview from the collection you want to export, or use Export in the collection’s menu in the sidebar.')
        return false
      }
      ui.exportCollectionId = collectionId
      return true
    }
    case 'about':
      ui.aboutOpen = true
      return true
  }
  return false
}

/** Subscribes to menu commands from the main process; returns the unsubscribe function. */
export function subscribeMenuCommands(): () => void {
  return api().onMenuCommand?.((command: MenuCommand) => void runMenuCommand(command)) ?? (() => {})
}
