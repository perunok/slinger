/**
 * Which unsaved edits quitting would lose, reported to main (setUnsavedChanges) so it can ask before the app quits or
 * its window closes for good (electron/lib/quitGuard.ts). With "Restore open tabs" on, only edits the last tab autosave
 * could not keep (too large, storage full; see tabsPersistence.ts) count, plus the edits of a workspace whose stored
 * tabs are still waiting to be restored (nothing of it is written until then). With the setting off, every unsaved
 * edit in every open workspace counts.
 */
import { settings } from '../../app/settings.svelte'
import { api } from '../../lib/ipc'
import { tabsStore } from './tabs.svelte'
import { onUnpersistedChange, unpersistedTitles } from './tabsPersistence'

const persisted = $state({ tick: 0 })
onUnpersistedChange(() => void persisted.tick++)

/** Titles of the tabs whose unsaved edits would be lost on quit now (reactive). */
export function unsavedAtRisk(workspaceId: string | null): string[] {
  const dirty = (tabs: { dirty: boolean; title: string }[]) => tabs.filter((t) => t.dirty).map((t) => t.title)
  if (!settings.restoreTabsOnStartup) return dirty(tabsStore.allTabs())
  void persisted.tick
  const titles = unpersistedTitles()
  if (workspaceId && tabsStore.restorePending(workspaceId)) titles.push(...dirty(tabsStore.tabs))
  return titles
}

let lastSent = '[]'

/** Sends the list to main when it changed. */
export function reportUnsaved(titles: string[]): void {
  const list = titles.map((t) => t.slice(0, 200))
  const key = JSON.stringify(list)
  if (key === lastSent) return
  lastSent = key
  api()
    .setUnsavedChanges(list)
    .catch(() => {
      lastSent = '' // send again on the next change
    })
}
