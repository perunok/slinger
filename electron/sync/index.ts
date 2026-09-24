/**
 * SyncService: the 18 cloud-account/sync IPC methods over the engine, the cloud client and the scheduler
 * (docs/SYNC_DESIGN.md sections 11, 12). No Electron imports.
 */
import type {
  CloudConfig,
  CloudSession,
  CloudSignInStart,
  LinkRemoteWorkspaceInput,
  RemoteWorkspace,
  RemoteWorkspacePreview,
  ResolveSyncConflictInput,
  SyncConflict,
  SyncEvent,
  SyncStatus,
  Workspace,
} from '../../shared/types'
import { CloudApi, type CloudGateway } from '../cloud/api'
import { CloudAuth } from '../cloud/auth'
import { CloudApiError, ServerUnsupportedError } from '../cloud/errors'
import { CloudHttp } from '../cloud/http'
import type { Db } from '../db/database'
import { IpcError, invalidInput, notFound } from '../lib/errors'
import { realClock, realTimers, type Clock, type Timers } from '../lib/clock'
import { isUuid } from '../lib/ids'
import { toWorkspace, type WorkspaceRow } from '../repositories/common'
import type { SecretStore } from '../services/secrets'
import { getConflict } from './conflictStore'
import { resolveConflict, toSyncConflict } from './conflicts'
import { detachSync } from './detach'
import { SyncEngine } from './engine'
import { createLocalWorkspace, discardAllPending, hasLiveContent, insertLink, markAllLiveDirty } from './linking'
import { SyncScheduler } from './scheduler'
import { applyTx, getLink, listLinks, updateLink } from './store'
import type { ConflictRow } from './conflictStore'

export interface SyncServiceDeps {
  db: Db
  secrets: SecretStore
  emit: (event: SyncEvent) => void
  appVersion: string
  /** Electron's net.fetch in the app; global fetch when omitted. */
  fetchImpl?: typeof fetch
  clock?: Clock
  timers?: Timers
  defaultDeviceName?: string
  random?: () => number
  /** Replaces the HTTP cloud client (tests). */
  cloud?: CloudGateway
  httpTimeoutMs?: number
}

/** Maps anything thrown by a cloud call to the IPC error vocabulary. */
export function toIpcError(err: unknown): unknown {
  if (err instanceof IpcError) return err
  if (err instanceof ServerUnsupportedError) return new IpcError({ code: 'sync_blocked', message: err.message, details: { reason: 'server_unsupported' } })
  if (err instanceof CloudApiError) {
    if (err.status === 401) return new IpcError({ code: 'unauthenticated', message: 'You are not signed in to the cloud' })
    if (err.isNetwork || err.isTransient) return new IpcError({ code: 'network_error', message: err.message })
    if (err.status === 404) return new IpcError({ code: 'not_found', message: err.message })
    return new IpcError({ code: 'sync_blocked', message: err.message, details: { status: err.status, code: err.code } })
  }
  return err
}

export class SyncService {
  readonly auth: CloudAuth
  readonly engine: SyncEngine
  readonly scheduler: SyncScheduler
  private readonly cloud: CloudGateway
  private readonly clock: Clock
  private readonly db: Db

  constructor(private readonly deps: SyncServiceDeps) {
    this.db = deps.db
    this.clock = deps.clock ?? realClock
    const timers = deps.timers ?? realTimers
    const http = new CloudHttp({ fetchImpl: deps.fetchImpl, timeoutMs: deps.httpTimeoutMs })
    const emit = (e: SyncEvent) => this.dispatch(e)
    this.auth = new CloudAuth({ db: deps.db, secrets: deps.secrets, http, clock: this.clock, timers, emit, defaultDeviceName: deps.defaultDeviceName })
    this.cloud = deps.cloud ?? new CloudApi(http, this.auth)
    this.engine = new SyncEngine({
      db: deps.db, secrets: deps.secrets, cloud: this.cloud, auth: this.auth, clock: this.clock, emit, appVersion: deps.appVersion, random: deps.random,
    })
    this.scheduler = new SyncScheduler(deps.db, this.engine, this.clock, timers)
  }

  private dispatch(event: SyncEvent): void {
    this.deps.emit(event)
    if (event.type === 'auth') for (const l of listLinks(this.db)) this.engine.emitStatus(l.workspace_id)
    if (event.type === 'signInResult' && event.result === 'approved') this.scheduler.syncAll(true)
  }

  start(): void {
    this.scheduler.start()
  }
  stop(): void {
    this.scheduler.stop()
  }
  notifyFocus(focused: boolean): void {
    this.scheduler.setFocused(focused)
  }
  notifyOnline(): void {
    this.scheduler.syncAll(true)
  }
  notifyResume(): void {
    this.scheduler.syncAll(true)
  }

  // ---- cloud account -----------------------------------------------------------------------------------------------

  getCloudConfig = async (): Promise<CloudConfig> => this.auth.getConfig()
  setCloudConfig = async (config: CloudConfig): Promise<CloudConfig> => {
    try {
      return this.auth.setConfig(config)
    } catch (err) {
      throw invalidInput(err instanceof Error ? err.message : 'invalid cloud configuration')
    }
  }
  getCloudSession = async (): Promise<CloudSession> => this.auth.getSession()
  startCloudSignIn = async (): Promise<CloudSignInStart> => {
    try {
      return await this.auth.startSignIn()
    } catch (err) {
      throw toIpcError(err)
    }
  }
  cancelCloudSignIn = async (): Promise<void> => this.auth.cancelSignIn()
  signOutCloud = async (): Promise<void> => this.auth.signOut()

  private requireSignedIn(): void {
    if (!this.auth.isSignedIn()) throw new IpcError({ code: 'unauthenticated', message: 'Sign in to the cloud first' })
  }

  listRemoteWorkspaces = async (): Promise<RemoteWorkspace[]> => {
    this.requireSignedIn()
    try {
      const remote = await this.cloud.listWorkspaces()
      const base = this.auth.baseUrl()
      const linked = new Map(
        (this.db.prepare('SELECT workspace_id, remote_workspace_id FROM cloud_links WHERE api_base_url = ?').all(base) as Array<{ workspace_id: string; remote_workspace_id: string }>).map(
          (r) => [r.remote_workspace_id, r.workspace_id],
        ),
      )
      return remote.map((w) => ({ id: w.id, name: w.name, slug: w.slug, role: w.role ?? 'viewer', linkedLocalWorkspaceId: linked.get(w.id) ?? null }))
    } catch (err) {
      throw toIpcError(err)
    }
  }

  previewRemoteWorkspace = async (remoteWorkspaceId: string): Promise<RemoteWorkspacePreview> => {
    this.requireSignedIn()
    const base = this.auth.baseUrl()
    try {
      const info = await this.cloud.getWorkspace(remoteWorkspaceId)
      let remoteEmpty: boolean | null = null
      try {
        const clientId = await this.engine.ensureClient(base)
        remoteEmpty = (await this.cloud.pull(remoteWorkspaceId, clientId, 0, 1)).operations.length === 0
      } catch (err) {
        if (!(err instanceof CloudApiError && err.isNetwork)) throw err
      }
      const row = this.db.prepare('SELECT workspace_id FROM cloud_links WHERE api_base_url = ? AND remote_workspace_id = ?').get(base, remoteWorkspaceId) as { workspace_id: string } | undefined
      return { id: info.id, name: info.name, role: info.role ?? 'viewer', remoteEmpty, linkedLocalWorkspaceId: row?.workspace_id ?? null }
    } catch (err) {
      throw toIpcError(err)
    }
  }

  // ---- sync --------------------------------------------------------------------------------------------------------

  getSyncStatus = async (workspaceId: string): Promise<SyncStatus> => this.engine.status(workspaceId)
  listSyncStatuses = async (): Promise<SyncStatus[]> => listLinks(this.db).map((l) => this.engine.status(l.workspace_id))

  syncNow = async (workspaceId: string): Promise<SyncStatus> => {
    const rt = this.engine.rt(workspaceId)
    rt.nextRetryAtMs = null
    return this.engine.runCycle(workspaceId, { manual: true })
  }

  setAutoSync = async (workspaceId: string, enabled: boolean): Promise<SyncStatus> => {
    if (!getLink(this.db, workspaceId)) throw new IpcError({ code: 'sync_blocked', message: 'This workspace is not linked to the cloud' })
    updateLink(this.db, workspaceId, { auto_sync: enabled ? 1 : 0 })
    this.engine.emitStatus(workspaceId)
    return this.engine.status(workspaceId)
  }

  private liveWorkspace(workspaceId: string): WorkspaceRow {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE id = ? AND deleted = 0').get(workspaceId) as WorkspaceRow | undefined
    if (!row) throw notFound('workspace')
    return row
  }

  publishWorkspace = async (workspaceId: string): Promise<SyncStatus> => {
    const ws = this.liveWorkspace(workspaceId)
    if (getLink(this.db, workspaceId)) throw new IpcError({ code: 'sync_blocked', message: 'This workspace is already linked to the cloud' })
    this.requireSignedIn()
    const cfg = this.auth.getConfig()
    try {
      const clientId = await this.engine.ensureClient(cfg.apiBaseUrl)
      const res = await this.cloud.publish(ws.name, clientId, cfg.deviceName)
      const nowS = Math.floor(this.clock.now() / 1000)
      applyTx(this.db, () => {
        insertLink(this.db, {
          workspaceId, apiBaseUrl: cfg.apiBaseUrl, remoteWorkspaceId: res.workspace.id, remoteName: res.workspace.name, role: res.role,
          clientId: res.clientId, checkpoint: res.checkpoint, snapshotCursor: null, userId: this.auth.currentUserId(), nowS,
        })
        markAllLiveDirty(this.db, workspaceId)
      })
    } catch (err) {
      throw toIpcError(err)
    }
    void this.engine.runCycle(workspaceId)
    return this.engine.status(workspaceId)
  }

  linkRemoteWorkspace = async (input: LinkRemoteWorkspaceInput): Promise<{ workspace: Workspace; status: SyncStatus }> => {
    this.requireSignedIn()
    const cfg = this.auth.getConfig()
    const remoteId = input.remoteWorkspaceId
    let local: WorkspaceRow | null = null
    if (input.localWorkspaceId !== null) {
      local = this.liveWorkspace(input.localWorkspaceId)
      if (getLink(this.db, local.id)) throw new IpcError({ code: 'sync_blocked', message: 'This workspace is already linked to the cloud' })
    }
    if (this.db.prepare('SELECT 1 FROM cloud_links WHERE api_base_url = ? AND remote_workspace_id = ?').get(cfg.apiBaseUrl, remoteId)) {
      throw new IpcError({ code: 'sync_blocked', message: 'This cloud workspace is already linked to a workspace on this device' })
    }
    let info
    let clientId: string
    try {
      info = await this.cloud.getWorkspace(remoteId)
      clientId = await this.engine.ensureClient(cfg.apiBaseUrl)
    } catch (err) {
      throw toIpcError(err)
    }
    const readOnly = info.role === 'viewer'
    if (local && readOnly && hasLiveContent(this.db, local.id)) {
      throw new IpcError({
        code: 'sync_blocked',
        message: 'You have view-only access to this cloud workspace, so local content cannot be merged into it. Download it into a new workspace instead.',
        details: { reason: 'viewer_with_local_content' },
      })
    }
    const nowS = Math.floor(this.clock.now() / 1000)
    const workspaceId = applyTx(this.db, () => {
      const id = local?.id ?? createLocalWorkspace(this.db, info.name, nowS)
      insertLink(this.db, {
        workspaceId: id, apiBaseUrl: cfg.apiBaseUrl, remoteWorkspaceId: remoteId, remoteName: info.name, role: info.role, clientId,
        checkpoint: 0, snapshotCursor: '', userId: this.auth.currentUserId(), nowS,
      })
      if (local && !readOnly) markAllLiveDirty(this.db, id)
      return id
    })
    void this.engine.runCycle(workspaceId)
    const row = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) as WorkspaceRow
    return { workspace: toWorkspace(row), status: this.engine.status(workspaceId) }
  }

  unlinkWorkspace = async (workspaceId: string): Promise<void> => {
    if (!getLink(this.db, workspaceId)) return
    this.db.transaction(() => detachSync(this.db, workspaceId))()
    this.engine.forget(workspaceId)
    this.engine.emitStatus(workspaceId)
    this.dispatch({ type: 'conflicts', workspaceId, open: 0 })
  }

  listSyncConflicts = async (workspaceId: string, includeResolved = false): Promise<SyncConflict[]> => {
    const rows = this.db
      .prepare(`SELECT * FROM sync_conflicts WHERE workspace_id = ?${includeResolved ? '' : " AND status = 'open'"} ORDER BY created_at DESC, id`)
      .all(workspaceId) as ConflictRow[]
    return rows.map((r) => toSyncConflict(this.db, r))
  }

  resolveSyncConflict = async (input: ResolveSyncConflictInput): Promise<SyncStatus> => {
    if (!isUuid(input.conflictId)) throw invalidInput('conflictId must be a valid UUID')
    const conflict = getConflict(this.db, input.conflictId.toLowerCase())
    if (!conflict) throw notFound('conflict')
    this.engine.runApply(conflict.workspace_id, (ctx) => resolveConflict(ctx, conflict, input))
    this.engine.emitStatus(conflict.workspace_id)
    void this.engine.runCycle(conflict.workspace_id, { manual: true })
    return this.engine.status(conflict.workspace_id)
  }

  discardPendingChanges = async (workspaceId: string): Promise<SyncStatus> => {
    if (!getLink(this.db, workspaceId)) throw new IpcError({ code: 'sync_blocked', message: 'This workspace is not linked to the cloud' })
    this.engine.runApply(workspaceId, (ctx) => discardAllPending(ctx))
    this.engine.emitStatus(workspaceId)
    return this.engine.status(workspaceId)
  }
}

export function createSyncService(deps: SyncServiceDeps): SyncService {
  return new SyncService(deps)
}
