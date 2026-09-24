import { tabsStore } from '../features/requests/tabs.svelte'
import { ui } from './ui.svelte'

function dialogOpen(): boolean {
  return !!document.querySelector('[role="dialog"][aria-modal="true"]')
}

/** Global keyboard shortcuts. Returns true when the event was handled. */
export function handleShortcut(e: KeyboardEvent): boolean {
  const mod = e.ctrlKey || e.metaKey
  if (!mod || e.altKey) return false
  const key = e.key.toLowerCase()
  const tab = tabsStore.active

  const act = (fn: () => void): true => {
    e.preventDefault()
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
      return tab ? act(() => (tab.requestId ? void tabsStore.save(tab) : (ui.saveAsTabId = tab.id))) : act(() => {})
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
