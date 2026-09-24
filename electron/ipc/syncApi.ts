import { z } from 'zod'
import type { SlingerIpcApi } from '../../shared/ipc-contract'
import { isUuid } from '../lib/ids'
import type { Core } from '../services/core'
import { toIpcError } from '../sync'
import { parseArgs } from './validate'

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

const uuid = z.string().refine(isUuid, { message: 'must be a valid UUID' })
const remoteId = z.string().min(1).max(64)
const cloudConfig = z.object({ apiBaseUrl: z.string().min(1).max(2048), deviceName: z.string().min(1).max(200) })
const groupChoice = z.enum(['local', 'remote'])
const resolveInput = z.object({
  conflictId: uuid,
  resolution: z.enum(['keep_local', 'keep_remote', 'merge', 'duplicate']),
  fieldChoices: z
    .object({ name: groupChoice, content: groupChoice, location: groupChoice, order: groupChoice, key: groupChoice, value: groupChoice })
    .partial()
    .optional(),
  newVersion: z.string().min(1).max(128).optional(),
})
const linkInput = z.object({ remoteWorkspaceId: remoteId, localWorkspaceId: uuid.nullable() })

/** Validation boundary + delegation to `core.sync`; cloud failures are mapped to the IPC error vocabulary. */
export function createSyncIpc(core: Core): SyncIpcApi {
  const s = core.sync
  const guarded =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      try {
        return await fn(...args)
      } catch (err) {
        throw toIpcError(err)
      }
    }
  return {
    getCloudConfig: async (...a) => (parseArgs(z.tuple([]), a), s.getCloudConfig()),
    setCloudConfig: async (...a) => s.setCloudConfig(parseArgs(z.tuple([cloudConfig]), a)[0]),
    getCloudSession: async (...a) => (parseArgs(z.tuple([]), a), s.getCloudSession()),
    startCloudSignIn: async (...a) => (parseArgs(z.tuple([]), a), guarded(s.startCloudSignIn)()),
    cancelCloudSignIn: async (...a) => (parseArgs(z.tuple([]), a), s.cancelCloudSignIn()),
    signOutCloud: async (...a) => (parseArgs(z.tuple([]), a), s.signOutCloud()),
    listRemoteWorkspaces: async (...a) => (parseArgs(z.tuple([]), a), guarded(s.listRemoteWorkspaces)()),
    previewRemoteWorkspace: async (...a) => guarded(s.previewRemoteWorkspace)(parseArgs(z.tuple([remoteId]), a)[0]),
    getSyncStatus: async (...a) => s.getSyncStatus(parseArgs(z.tuple([uuid]), a)[0]),
    listSyncStatuses: async (...a) => (parseArgs(z.tuple([]), a), s.listSyncStatuses()),
    syncNow: async (...a) => s.syncNow(parseArgs(z.tuple([uuid]), a)[0]),
    setAutoSync: async (...a) => {
      const [id, enabled] = parseArgs(z.tuple([uuid, z.boolean()]), a)
      return s.setAutoSync(id, enabled)
    },
    publishWorkspace: async (...a) => guarded(s.publishWorkspace)(parseArgs(z.tuple([uuid]), a)[0]),
    linkRemoteWorkspace: async (...a) => guarded(s.linkRemoteWorkspace)(parseArgs(z.tuple([linkInput]), a)[0]),
    unlinkWorkspace: async (...a) => s.unlinkWorkspace(parseArgs(z.tuple([uuid]), a)[0]),
    listSyncConflicts: async (...a) => {
      const [id, includeResolved] = parseArgs(z.tuple([uuid, z.boolean().optional()]), a)
      return s.listSyncConflicts(id, includeResolved ?? false)
    },
    resolveSyncConflict: async (...a) => s.resolveSyncConflict(parseArgs(z.tuple([resolveInput]), a)[0]),
    discardPendingChanges: async (...a) => s.discardPendingChanges(parseArgs(z.tuple([uuid]), a)[0]),
  }
}
