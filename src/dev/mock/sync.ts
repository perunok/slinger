import type { SlingerIpcApi } from '../../../shared/ipc-contract'

/**
 * Placeholder for the cloud-account + sync half of the API (added by the "Sync contract" commit so the
 * mock keeps satisfying SlingerIpcApi). The renderer-UI work package replaces this with a scripted mock.
 */
type SyncApi = Pick<
  SlingerIpcApi,
  | 'getCloudConfig'
  | 'setCloudConfig'
  | 'getCloudSession'
  | 'startCloudSignIn'
  | 'cancelCloudSignIn'
  | 'signOutCloud'
  | 'listRemoteWorkspaces'
  | 'previewRemoteWorkspace'
  | 'getSyncStatus'
  | 'listSyncStatuses'
  | 'syncNow'
  | 'setAutoSync'
  | 'publishWorkspace'
  | 'linkRemoteWorkspace'
  | 'unlinkWorkspace'
  | 'listSyncConflicts'
  | 'resolveSyncConflict'
  | 'discardPendingChanges'
  | 'onSyncEvent'
>

const unavailable = async (): Promise<never> => {
  throw { name: 'IpcError', code: 'sync_blocked', message: 'not_implemented: sync is not available in the mock backend yet' }
}

export function createSyncApi(): SyncApi {
  return {
    getCloudConfig: unavailable,
    setCloudConfig: unavailable,
    getCloudSession: unavailable,
    startCloudSignIn: unavailable,
    cancelCloudSignIn: unavailable,
    signOutCloud: unavailable,
    listRemoteWorkspaces: unavailable,
    previewRemoteWorkspace: unavailable,
    getSyncStatus: unavailable,
    listSyncStatuses: unavailable,
    syncNow: unavailable,
    setAutoSync: unavailable,
    publishWorkspace: unavailable,
    linkRemoteWorkspace: unavailable,
    unlinkWorkspace: unavailable,
    listSyncConflicts: unavailable,
    resolveSyncConflict: unavailable,
    discardPendingChanges: unavailable,
    onSyncEvent: () => () => {},
  }
}
