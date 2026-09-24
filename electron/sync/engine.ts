/**
 * The sync engine: cycle (pull then push), status model, backoff, snapshot phase, role handling
 * (docs/SYNC_DESIGN.md sections 7, 10). No Electron imports: fetch, clock, timers and events are injected.
 */
import type { CloudRole, SyncEntityType, SyncEvent, SyncState, SyncStatus } from '../../shared/types'
import type { CloudAuth } from '../cloud/auth'
import type { CloudGateway } from '../cloud/api'
import { CloudApiError, ServerUnsupportedError } from '../cloud/errors'
import type { Db } from '../db/database'
import type { Clock } from '../lib/clock'
import type { SecretStore } from '../services/secrets'
import { applyRemoteOp, applySnapshotEntity, fixFolderCycles, makeApplyCtx, type ApplyCtx } from './apply'
import { recordAutoResolved } from './conflictStore'
import { reevaluateOpenConflicts } from './conflicts'
import { dedupeEnvironments } from './linking'
import {
  MAX_BYTES_PER_PUSH,
  MAX_OPS_PER_PUSH,
  applyPushResponse,
  buildOps,
  chunkOps,
  orderOps,
  quarantine,
  type BuiltOp,
  type PushOutcome,
} from './outbox'
import {
  applyTx,
  deleteSetting,
  dirtyCount,
  getLink,
  getSetting,
  listLinks,
  openConflictCount,
  setSetting,
  updateLink,
} from './store'
import type { ChangeLog, LinkRow } from './types'

const PULL_LIMIT = 200
const SNAPSHOT_LIMIT = 200
const MAX_ROUNDS = 4
const ROLE_CHECK_INTERVAL_MS = 30_000
const SENT_OPS_TTL_S = 14 * 24 * 3600
const BACKOFF_BASE_MS = 5_000
const BACKOFF_MAX_MS = 5 * 60_000

export interface EngineDeps {
  db: Db
  secrets: SecretStore
  cloud: CloudGateway
  auth: CloudAuth
  clock: Clock
  emit: (event: SyncEvent) => void
  appVersion: string
  /** 0..1, injectable so tests get deterministic jitter. */
  random?: () => number
}

interface Runtime {
  running: Promise<SyncStatus> | null
  progress: SyncStatus['progress']
  state: 'idle' | 'offline' | 'error' | 'serverUnsupported'
  failures: number
  nextRetryAtMs: number | null
  lastCycleAtMs: number
  lastRoleCheckMs: number
  dirtySince: number | null
  debounce: unknown
  /** Counts last announced in a status event (the scheduler's watcher announces local edits). */
  announced: { pending: number; open: number } | null
}

/** Raised inside a cycle when the workspace is gone or the user lost access (not an error state). */
class AccessLost extends Error {}

export class SyncEngine {
  private readonly rts = new Map<string, Runtime>()
  private readonly random: () => number

  constructor(private readonly deps: EngineDeps) {
    this.random = deps.random ?? Math.random
  }

  rt(workspaceId: string): Runtime {
    let r = this.rts.get(workspaceId)
    if (!r) {
      r = { running: null, progress: null, state: 'idle', failures: 0, nextRetryAtMs: null, lastCycleAtMs: 0, lastRoleCheckMs: 0, dirtySince: null, debounce: null, announced: null }
      this.rts.set(workspaceId, r)
    }
    return r
  }

  forget(workspaceId: string): void {
    this.rts.delete(workspaceId)
  }

  // ---- status ------------------------------------------------------------------------------------------------------

  status(workspaceId: string): SyncStatus {
    const { db } = this.deps
    const link = getLink(db, workspaceId)
    if (!link) {
      return {
        workspaceId, linked: false, state: 'unlinked', apiBaseUrl: null, remoteWorkspaceId: null, remoteName: null, role: null,
        readOnly: false, autoSync: false, pendingChanges: 0, openConflicts: 0, initialSyncPending: false, lastSyncedAt: null,
        lastError: null, nextRetryAt: null, progress: null,
      }
    }
    const rt = this.rt(workspaceId)
    let state: SyncState
    if (rt.running) state = 'syncing'
    else if (!this.deps.auth.isSignedIn()) state = 'signedOut'
    else if (link.access_state !== 'ok') state = 'accessRevoked'
    else if (rt.state === 'serverUnsupported') state = 'serverUnsupported'
    else if (rt.state === 'offline') state = 'offline'
    else if (rt.state === 'error') state = 'error'
    else state = 'idle'
    return {
      workspaceId,
      linked: true,
      state,
      apiBaseUrl: link.api_base_url,
      remoteWorkspaceId: link.remote_workspace_id,
      remoteName: link.remote_name,
      role: (link.remote_role as CloudRole | null) ?? null,
      readOnly: link.read_only === 1,
      autoSync: link.auto_sync === 1,
      pendingChanges: dirtyCount(db, workspaceId),
      openConflicts: openConflictCount(db, workspaceId),
      initialSyncPending: link.link_state === 'initial',
      lastSyncedAt: link.last_synced_at,
      lastError: link.last_error_code ? { code: link.last_error_code, message: link.last_error_message ?? '' } : null,
      nextRetryAt: rt.nextRetryAtMs && !rt.running ? Math.ceil(rt.nextRetryAtMs / 1000) : null,
      progress: rt.running ? rt.progress : null,
    }
  }

  emitStatus(workspaceId: string): void {
    const status = this.status(workspaceId)
    this.rt(workspaceId).announced = { pending: status.pendingChanges, open: status.openConflicts }
    this.deps.emit({ type: 'status', status })
  }

  emitApplied(workspaceId: string, changed: ChangeLog): void {
    if (!changed.size) return
    const all = [...changed.values()]
    this.deps.emit({ type: 'applied', workspaceId, changed: all.slice(0, 500), truncated: all.length > 500 })
  }

  /** Runs a DB mutation the engine owns (triggers suppressed), then keychain effects and events. */
  runApply<T>(workspaceId: string, fn: (ctx: ApplyCtx) => T): T {
    const { db } = this.deps
    const before = openConflictCount(db, workspaceId)
    const ctx = makeApplyCtx({ db, secrets: this.deps.secrets, nowS: Math.floor(this.deps.clock.now() / 1000), effects: [] }, workspaceId)
    const result = applyTx(db, () => fn(ctx))
    for (const effect of ctx.effects) {
      try {
        effect()
      } catch (err) {
        console.warn('[slinger] sync side effect failed:', err instanceof Error ? err.message : err)
      }
    }
    this.emitApplied(workspaceId, ctx.changed)
    const after = openConflictCount(db, workspaceId)
    if (after !== before) this.deps.emit({ type: 'conflicts', workspaceId, open: after })
    return result
  }

  // ---- cycle -------------------------------------------------------------------------------------------------------

  /** Runs (or joins) a sync cycle for a workspace and resolves with its final status. Never rejects. */
  runCycle(workspaceId: string, opts: { manual?: boolean } = {}): Promise<SyncStatus> {
    const rt = this.rt(workspaceId)
    if (rt.running) return rt.running
    if (!getLink(this.deps.db, workspaceId)) return Promise.resolve(this.status(workspaceId))
    const p: Promise<SyncStatus> = this.cycle(workspaceId, opts.manual === true)
      .catch((err) => this.fail(workspaceId, err))
      .then(() => {
        rt.running = null
        rt.progress = null
        rt.lastCycleAtMs = this.deps.clock.now()
        const s = this.status(workspaceId)
        this.deps.emit({ type: 'status', status: s })
        return s
      })
    rt.running = p
    this.emitStatus(workspaceId)
    return p
  }

  private async cycle(workspaceId: string, manual: boolean): Promise<void> {
    const { db, auth, clock } = this.deps
    const rt = this.rt(workspaceId)
    let link = getLink(db, workspaceId)!
    if (!auth.isSignedIn()) return
    if (link.access_state !== 'ok' && !manual) return

    const clientId = await this.ensureClient(link.api_base_url, workspaceId)
    await this.refreshRole(workspaceId, manual)
    link = getLink(db, workspaceId)!

    db.prepare('DELETE FROM sync_sent_ops WHERE sent_at < ?').run(Math.floor(clock.now() / 1000) - SENT_OPS_TTL_S)

    if (link.link_state === 'initial' && link.snapshot_cursor !== null) await this.snapshotPhase(workspaceId, clientId)

    // Pull before every push, except right after a push whose rejections were settled from the rejection itself
    // (v2 `current_payload` merges, remote deletes): the retry then goes out at once (design 7.4, implementation notes).
    let pullFirst = true
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const pulled = pullFirst ? await this.pull(workspaceId, clientId) : null
      link = getLink(db, workspaceId)!
      if (link.read_only === 1) break
      const built = buildOps(db, workspaceId, clock.now())
      if (!built.ops.length) break
      const outcome = await this.pushAll(workspaceId, clientId, built.ops)
      if (outcome.transient) throw new CloudApiError({ kind: 'http', status: 500, code: 'internal_error', message: 'The cloud could not process some changes; retrying later' })
      if (outcome.denied === 'read_only') {
        // Per-operation `read_only` (reserved by the server): same as the whole-push 403 for a viewer.
        updateLink(db, workspaceId, { read_only: 1 })
        break
      }
      if (outcome.denied === 'forbidden') {
        await this.refreshRole(workspaceId, true) // lost access -> AccessLost
        throw new CloudApiError({ kind: 'http', status: 403, code: 'forbidden', message: 'The cloud refused some changes for this account; they stay on this device.' })
      }
      if (getLink(db, workspaceId)!.read_only === 1) break
      if (outcome.retry.length) {
        if ((pulled === 0 && round >= 2) || round === MAX_ROUNDS) {
          // Defensive: the server keeps refusing although a fresh pull brought nothing new. Never loop forever.
          this.runApply(workspaceId, (ctx) => {
            for (const b of outcome.retry) {
              const why = b.rejection ? `The cloud rejected this item: ${b.rejection}` : 'The cloud keeps refusing this change although this device is up to date. Choose which version to keep.'
              quarantine(ctx.db, ctx.nowS, workspaceId, b.type, b.id, why, b.op.op === 'upsert' ? b.op.payload : null)
            }
          })
          break
        }
        pullFirst = true
        continue
      }
      if (outcome.resolved) {
        pullFirst = false
        continue
      }
      // A push may have created new local work (renamed variables); loop only when something is still pending.
      if (!outcome.conflicts) break
      pullFirst = true
    }

    link = getLink(db, workspaceId)!
    if (link.link_state === 'initial' && link.snapshot_cursor === null && !this.hasPushable(workspaceId)) {
      updateLink(db, workspaceId, { link_state: 'active' })
    }
    updateLink(db, workspaceId, {
      last_synced_at: Math.floor(clock.now() / 1000), last_error_code: null, last_error_message: null, updated_at: Math.floor(clock.now() / 1000),
    })
    rt.state = 'idle'
    rt.failures = 0
    rt.nextRetryAtMs = null
  }

  /** Dirty entities that are not frozen in a conflict (i.e. that a push could still send). */
  private hasPushable(workspaceId: string): boolean {
    return (
      this.deps.db
        .prepare(
          `SELECT 1 FROM sync_dirty d LEFT JOIN sync_entities e ON e.entity_type = d.entity_type AND e.entity_id = d.entity_id
           WHERE d.workspace_id = ? AND COALESCE(e.state, 'synced') != 'conflict' LIMIT 1`,
        )
        .get(workspaceId) !== undefined
    )
  }

  // ---- failure handling --------------------------------------------------------------------------------------------

  private fail(workspaceId: string, err: unknown): void {
    const { db, clock } = this.deps
    const rt = this.rt(workspaceId)
    if (!getLink(db, workspaceId)) return
    const nowS = Math.floor(clock.now() / 1000)
    let code = 'internal_error'
    let message = err instanceof Error ? err.message : String(err)
    let backoff = false
    let retryAfterMs: number | null = null

    if (err instanceof AccessLost) {
      code = getLink(db, workspaceId)!.access_state === 'remote_deleted' ? 'workspace_deleted' : 'access_revoked'
      rt.state = 'idle'
    } else if (err instanceof ServerUnsupportedError) {
      code = 'server_unsupported'
      rt.state = 'serverUnsupported'
      backoff = true
    } else if (err instanceof CloudApiError) {
      code = err.code
      if (err.status === 401) {
        code = 'unauthenticated'
        message = 'Your cloud session ended. Sign in again to continue syncing.'
        rt.state = 'idle'
      } else if (err.isNetwork) {
        rt.state = 'offline'
        backoff = true
      } else if (err.isTransient) {
        rt.state = 'error'
        backoff = true
        retryAfterMs = err.retryAfterMs
      } else {
        rt.state = 'error'
        backoff = true
      }
    } else {
      rt.state = 'error'
      backoff = true
      console.error('[slinger] sync cycle failed:', err)
    }
    updateLink(db, workspaceId, { last_error_code: code, last_error_message: message.slice(0, 500), updated_at: nowS })
    if (backoff) {
      rt.failures++
      const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (rt.failures - 1))
      const jittered = base * (0.8 + this.random() * 0.4)
      rt.nextRetryAtMs = clock.now() + Math.max(jittered, retryAfterMs ?? 0)
    } else {
      rt.nextRetryAtMs = null
    }
  }

  // ---- client registration & role ----------------------------------------------------------------------------------

  /** The sync client id for the signed-in account on `apiBaseUrl` (registered once, cached in app_settings). */
  async ensureClient(apiBaseUrl: string, linkWorkspaceId?: string): Promise<string> {
    const { db, auth } = this.deps
    const session = await auth.getSession()
    const key = `cloud.client:${apiBaseUrl}:${session.user?.id ?? 'unknown'}`
    const cached = getSetting(db, key)
    if (cached) {
      try {
        const c = JSON.parse(cached) as { clientId: string; protocolVersion: number }
        if (c.clientId && c.protocolVersion >= 2) {
          if (linkWorkspaceId) this.recordClient(linkWorkspaceId, c.clientId)
          return c.clientId
        }
      } catch {
        /* re-register */
      }
    }
    return this.registerClient(key, linkWorkspaceId)
  }

  private recordClient(workspaceId: string, clientId: string): void {
    const link = getLink(this.deps.db, workspaceId)
    if (link && link.sync_client_id !== clientId) updateLink(this.deps.db, workspaceId, { sync_client_id: clientId })
  }

  private async registerClient(key: string, linkWorkspaceId?: string): Promise<string> {
    const { db, auth, cloud, appVersion } = this.deps
    const reg = await cloud.registerClient(auth.getConfig().deviceName, appVersion)
    setSetting(db, key, JSON.stringify({ clientId: reg.clientId, protocolVersion: reg.protocolVersion }))
    if (reg.protocolVersion < 2) throw new ServerUnsupportedError()
    if (linkWorkspaceId) this.recordClient(linkWorkspaceId, reg.clientId)
    return reg.clientId
  }

  /** Runs `fn(clientId)`; a server that forgot our client id (other account, reset) gets a fresh registration once. */
  private async withClient<T>(workspaceId: string, clientId: string, fn: (clientId: string) => Promise<T>): Promise<T> {
    try {
      return await fn(clientId)
    } catch (err) {
      if (!(err instanceof CloudApiError) || err.status !== 400 || !/client_id/i.test(err.message)) throw err
      const link = getLink(this.deps.db, workspaceId)!
      const session = await this.deps.auth.getSession()
      const key = `cloud.client:${link.api_base_url}:${session.user?.id ?? 'unknown'}`
      deleteSetting(this.deps.db, key)
      return fn(await this.registerClient(key, workspaceId))
    }
  }

  /** Reads the workspace + our role. 404/403 mean the workspace is gone or access was revoked. */
  async refreshRole(workspaceId: string, force: boolean): Promise<void> {
    const { db, cloud, clock } = this.deps
    const rt = this.rt(workspaceId)
    if (!force && clock.now() - rt.lastRoleCheckMs < ROLE_CHECK_INTERVAL_MS) return
    const link = getLink(db, workspaceId)!
    try {
      const info = await cloud.getWorkspace(link.remote_workspace_id)
      rt.lastRoleCheckMs = clock.now()
      updateLink(db, workspaceId, {
        remote_name: info.name, remote_role: info.role, read_only: info.role === 'viewer' ? 1 : 0, access_state: 'ok',
      })
    } catch (err) {
      if (err instanceof CloudApiError && (err.status === 404 || err.status === 403)) {
        updateLink(db, workspaceId, { access_state: err.status === 404 ? 'remote_deleted' : 'revoked' })
        throw new AccessLost(err.message)
      }
      throw err
    }
  }

  // ---- pull --------------------------------------------------------------------------------------------------------

  /** Pulls and applies every page after the stored checkpoint; returns the number of operations applied. */
  async pull(workspaceId: string, clientId: string): Promise<number> {
    const { db, cloud } = this.deps
    const rt = this.rt(workspaceId)
    let total = 0
    for (;;) {
      const link = getLink(db, workspaceId)!
      const res = await this.withClient(workspaceId, clientId, (cid) => cloud.pull(link.remote_workspace_id, cid, link.sync_checkpoint, PULL_LIMIT))
      this.runApply(workspaceId, (ctx) => {
        for (const op of res.operations) {
          if (op.workspace_id && op.workspace_id !== link.remote_workspace_id) continue
          this.applyGuarded(ctx, () => applyRemoteOp(ctx, op), op.resource_type, op.resource_id)
        }
        fixFolderCycles(ctx)
        // The checkpoint advances ONLY here, with the transaction that applied the ops.
        updateLink(db, workspaceId, { sync_checkpoint: Math.max(link.sync_checkpoint, res.checkpoint) })
      })
      total += res.operations.length
      rt.progress = { phase: 'pull', done: total, total: null }
      this.emitStatus(workspaceId)
      if (!res.has_more) {
        this.runApply(workspaceId, (ctx) => reevaluateOpenConflicts(ctx))
        return total
      }
    }
  }

  /** One poison operation must not wedge the whole workspace: roll it back, note it, move on. */
  private applyGuarded(ctx: ApplyCtx, fn: () => void, type: SyncEntityType, id: string): void {
    try {
      ctx.db.transaction(fn)()
    } catch (err) {
      const message = `A change from the cloud could not be applied: ${err instanceof Error ? err.message : String(err)}`
      console.warn('[slinger]', message)
      recordAutoResolved(ctx.db, ctx.nowS, { workspaceId: ctx.workspaceId, type, id, kind: 'rejected', label: id, message })
    }
  }

  // ---- snapshot (initial download) ---------------------------------------------------------------------------------

  private async snapshotPhase(workspaceId: string, clientId: string): Promise<void> {
    const { db, cloud } = this.deps
    const rt = this.rt(workspaceId)
    let done = 0
    for (;;) {
      const link = getLink(db, workspaceId)!
      const cursor = link.snapshot_cursor
      if (cursor === null) return
      const res = await this.withClient(workspaceId, clientId, (cid) => cloud.snapshot(link.remote_workspace_id, cid, cursor || null, SNAPSHOT_LIMIT))
      this.runApply(workspaceId, (ctx) => {
        for (const e of res.entities) this.applyGuarded(ctx, () => applySnapshotEntity(ctx, e), e.resource_type, e.resource_id)
        const last = !res.next_cursor
        if (last) {
          dedupeEnvironments(ctx)
          fixFolderCycles(ctx)
        }
        updateLink(db, workspaceId, { sync_checkpoint: res.checkpoint, snapshot_cursor: last ? null : res.next_cursor })
      })
      done += res.entities.length
      rt.progress = { phase: 'snapshot', done, total: null }
      this.emitStatus(workspaceId)
      if (!res.next_cursor) return
    }
  }

  // ---- push --------------------------------------------------------------------------------------------------------

  private async pushAll(workspaceId: string, clientId: string, ops: BuiltOp[]): Promise<PushOutcome> {
    const { db, cloud } = this.deps
    const rt = this.rt(workspaceId)
    const total = ops.length
    let done = 0
    let pending = orderOps(db, ops)
    let maxOps = MAX_OPS_PER_PUSH
    let maxBytes = MAX_BYTES_PER_PUSH
    const agg: PushOutcome = { accepted: 0, retry: [], resolved: 0, transient: false, conflicts: 0, denied: null }
    while (pending.length) {
      const chunk = chunkOps(pending, maxOps, maxBytes)[0]!
      const link = getLink(db, workspaceId)!
      let res
      try {
        res = await this.withClient(workspaceId, clientId, (cid) =>
          cloud.push(link.remote_workspace_id, cid, link.sync_checkpoint, chunk.map((c) => c.op)),
        )
      } catch (err) {
        if (err instanceof CloudApiError && err.status === 413) {
          if (chunk.length === 1) {
            this.runApply(workspaceId, (ctx) => quarantine(ctx.db, ctx.nowS, workspaceId, chunk[0]!.type, chunk[0]!.id, 'The cloud refused this item as too large.', chunk[0]!.op.payload))
            agg.conflicts++
            pending = pending.slice(1)
            continue
          }
          maxOps = Math.max(1, Math.floor(chunk.length / 2))
          maxBytes = Math.max(1, Math.floor(maxBytes / 2))
          continue
        }
        if (err instanceof CloudApiError && err.status === 403) {
          if (err.details?.reason === 'read_only') {
            // v2: "this workspace is read-only for your role (viewer)". Pending changes are kept (banner), nothing else to ask.
            const role = typeof err.details.role === 'string' ? err.details.role : 'viewer'
            updateLink(db, workspaceId, { read_only: 1, remote_role: role })
            return agg
          }
          // Role downgrade or access revoked: re-read the role; a viewer keeps its pending changes (banner), otherwise stop.
          await this.refreshRole(workspaceId, true)
          if (getLink(db, workspaceId)!.read_only === 1) return agg
        }
        throw err
      }
      const outcome = this.runApply(workspaceId, (ctx) => applyPushResponse(ctx, chunk, res))
      agg.accepted += outcome.accepted
      agg.retry.push(...outcome.retry)
      agg.transient ||= outcome.transient
      agg.conflicts += outcome.conflicts
      agg.resolved += outcome.resolved
      if (outcome.denied) {
        agg.denied = agg.denied === 'read_only' ? 'read_only' : outcome.denied
        return agg // the rest would be refused the same way
      }
      const sent = new Set(chunk.map((c) => c.op.operation_id))
      pending = pending.filter((p) => !sent.has(p.op.operation_id))
      done += chunk.length
      rt.progress = { phase: 'push', done, total }
      this.emitStatus(workspaceId)
    }
    return agg
  }

  // ---- inspection used by the scheduler ---------------------------------------------------------------------------

  activeLinks(): LinkRow[] {
    return listLinks(this.deps.db)
  }
}
