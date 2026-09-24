import type { SlingerIpcApi } from '../../shared/ipc-contract'
import { IpcError } from '../lib/errors'
import type { Core } from '../services/core'

/** The cloud-account + sync half of SlingerIpcApi (every method except the `onSyncEvent` push channel). */
export type SyncIpcApi = Pick<SlingerIpcApi, SyncIpcMethod>
type SyncIpcMethod =
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

const notImplemented = async (): Promise<never> => {
  throw new IpcError({ code: 'sync_blocked', message: 'not_implemented: cloud sync is not available in this build yet' })
}

/** Compile-only stubs (contract commit); replaced by real delegation to the sync service. */
export function createSyncIpc(_core: Core): SyncIpcApi {
  return {
    getCloudConfig: notImplemented,
    setCloudConfig: notImplemented,
    getCloudSession: notImplemented,
    startCloudSignIn: notImplemented,
    cancelCloudSignIn: notImplemented,
    signOutCloud: notImplemented,
    listRemoteWorkspaces: notImplemented,
    previewRemoteWorkspace: notImplemented,
    getSyncStatus: notImplemented,
    listSyncStatuses: notImplemented,
    syncNow: notImplemented,
    setAutoSync: notImplemented,
    publishWorkspace: notImplemented,
    linkRemoteWorkspace: notImplemented,
    unlinkWorkspace: notImplemented,
    listSyncConflicts: notImplemented,
    resolveSyncConflict: notImplemented,
    discardPendingChanges: notImplemented,
  }
}
