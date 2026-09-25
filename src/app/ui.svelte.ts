/** Which dialogs/panels are open. Kept out of feature stores so any feature can open any other. */
class UiState {
  sidebar = $state<'collections' | 'history'>('collections')
  settingsOpen = $state(false)
  cloudOpen = $state(false)
  /** Conflict center for the current workspace. */
  conflictsOpen = $state(false)
  /** Publish-to-cloud flow for the current workspace. */
  publishOpen = $state(false)
  /** Link-a-cloud-workspace flow; `remoteId` pre-selects one from the list. */
  linkOpen = $state<{ remoteId: string | null } | null>(null)
  quickOpen = $state(false)
  /** Environment editor; `newVariable` pre-fills a row (from the "create variable" popover). */
  envEditor = $state<{ open: boolean; environmentId?: string; newVariable?: string }>({ open: false })
  runner = $state<{ collectionId: string; folderId: string | null } | null>(null)
  /** Collection- or folder-level scripts editor. */
  scriptsFor = $state<{ kind: 'collection' | 'folder'; id: string } | null>(null)
  versionsFor = $state<string | null>(null)
  saveAsTabId = $state<string | null>(null)
  exportCollectionId = $state<string | null>(null)
  importOpen = $state(false)
  workspacesOpen = $state(false)
  shortcutsOpen = $state(false)
}
export const ui = new UiState()
