/** Non-destructive resolutions of a "changed/deleted remotely" tab notice. Nothing here writes to the database. */
import { app } from '../../app/state.svelte'
import { ui } from '../../app/ui.svelte'
import { locateExample, readExamples } from '../../lib/examples'
import { serverKeyOf, tabsStore, type RequestTab } from '../requests/tabs.svelte'

/** Discard the unsaved edits and load the cloud version. */
export function reloadFromCloud(tab: RequestTab): void {
  const server = tab.requestId ? app.requestById(tab.requestId) : undefined
  if (server) tab.loadFrom(server)
  tab.remoteNotice = null
}

/** Keep the unsaved edits: rebase the tab on the current stored version so the next Save overwrites it on purpose. */
export function keepMine(tab: RequestTab): void {
  const server = tab.requestId ? app.requestById(tab.requestId) : undefined
  if (server && tab.example) {
    // Rebase on the cloud's version of this example (if it still exists) so Save overwrites it on purpose.
    const found = locateExample(readExamples(server.documentJson), tab.example)
    if (found) tab.rebaseExample(server, found.index) // drafts (the unsaved edits) are kept
  } else if (server) {
    tab.baseVersion = server.version
    tab.serverKey = serverKeyOf(server)
    tab.collectionId = server.collectionId
    tab.folderId = server.folderId
  }
  tab.remoteNotice = null
}

/** The request was deleted remotely: offer to save the edits as a new request. */
export function saveAsNew(tab: RequestTab): void {
  ui.saveAsTabId = tab.id
}

export function closeTab(tab: RequestTab): void {
  tabsStore.requestClose([tab.id])
}
