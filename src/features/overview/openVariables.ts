import { tabsStore } from '../requests/tabs.svelte'

/**
 * Opens (or focuses) the collection's overview tab on its Variables section; `newVariable` (from the
 * "create variable" action) adds a row for that name.
 */
export function openCollectionVariables(collectionId: string, newVariable?: string): void {
  const tab = tabsStore.openOverview({ kind: 'collection', id: collectionId })
  tab.overviewSection = 'variables'
  if (newVariable) tab.pendingVariable = newVariable
}
