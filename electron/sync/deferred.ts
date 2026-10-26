/**
 * Remote changes that could not be applied when they arrived (migration 0017, docs/SYNC_DESIGN.md section 20,
 * "Deferred remote changes"). The pull checkpoint and the snapshot cursor move on with the page that carried a change,
 * so a change that is skipped is never sent again. Two cases keep it here instead:
 * - `missing_parent`: an upsert whose collection / folder / environment is not on this device yet (an older server
 *   sends folders by id, so a nested folder can come before its parent, and everything inside it after);
 * - `failed`: applying it threw (rolled back on its own savepoint).
 * Every snapshot page and every pull page first retries the failed ones (`retryFailed`) and ends with the waiting
 * ones (`retryWaiting`); a later change of the same entity replaces the
 * kept one (the log is ordered, so the newer change is the truth). Everything runs inside the caller's `applyTx`.
 */
import type { SyncEntityType } from '../../shared/types'
import { applyRemoteOp, applySnapshotEntity, type ApplyCtx } from './apply'
import { recordAutoResolved } from './conflictStore'
import { payloadLabel } from './mapping'
import type { EntityRef } from './rows'
import type { Payload, PullOp, SnapshotEntity } from './types'

/** One remote change, from a pull page (with an operation id) or a snapshot page (an upsert without one). */
export interface RemoteChange {
  type: SyncEntityType
  id: string
  op: 'upsert' | 'delete'
  version: number
  payload: Payload | null
  opId: string | null
}

interface DeferredRow {
  entity_type: SyncEntityType
  entity_id: string
  op: 'upsert' | 'delete'
  version: number
  payload_json: string | null
  op_id: string | null
  reason: 'missing_parent' | 'failed'
  message: string | null
  attempts: number
  noted: number
}

export const fromPullOp = (op: PullOp): RemoteChange => ({
  type: op.resource_type, id: op.resource_id, op: op.op, version: op.resulting_version, payload: op.payload ?? null, opId: op.operation_id,
})

export const fromSnapshotEntity = (e: SnapshotEntity): RemoteChange => ({
  type: e.resource_type, id: e.resource_id, op: 'upsert', version: e.version, payload: e.payload ?? null, opId: null,
})

function toPullOp(ch: RemoteChange & { opId: string }, workspaceId: string): PullOp {
  return {
    operation_id: ch.opId, workspace_id: workspaceId, resource_type: ch.type, resource_id: ch.id, op: ch.op,
    resulting_version: ch.version, payload: ch.payload ?? {}, occurred_at: '', checkpoint: 0,
  }
}

const NO_OP_ID = ''

/**
 * Applies one remote change on its own savepoint. A change that cannot be applied is kept for a retry (and the
 * first failure of an entity is noted in Sync activity); one that applies replaces whatever was kept for the entity.
 * Returns whether it was applied.
 */
export function applyRemoteChange(ctx: ApplyCtx, ch: RemoteChange): boolean {
  const { db } = ctx
  const prior = db.prepare('SELECT * FROM sync_deferred WHERE entity_type = ? AND entity_id = ?').get(ch.type, ch.id) as DeferredRow | undefined
  const sameChange = prior !== undefined && prior.op === ch.op && prior.version === ch.version && (prior.op_id ?? NO_OP_ID) === (ch.opId ?? NO_OP_ID)
  ctx.missingParent = null
  let error: unknown = null
  try {
    db.transaction(() => {
      if (ch.opId === null) applySnapshotEntity(ctx, { resource_type: ch.type, resource_id: ch.id, version: ch.version, payload: ch.payload ?? {} })
      else applyRemoteOp(ctx, toPullOp({ ...ch, opId: ch.opId }, ctx.workspaceId))
    })()
  } catch (err) {
    error = err
  }
  // applyRemoteOp sets it (TypeScript cannot see that through the call).
  const missing = ctx.missingParent as EntityRef | null
  ctx.missingParent = null
  if (error === null && missing === null) {
    if (prior) db.prepare('DELETE FROM sync_deferred WHERE entity_type = ? AND entity_id = ?').run(ch.type, ch.id)
    return true
  }
  const reason = error !== null ? 'failed' : 'missing_parent'
  const message = error !== null
    ? `A change from the cloud could not be applied: ${error instanceof Error ? error.message : String(error)}`
    : `Waiting for the ${missing!.type} it belongs to, which this device has not received yet.`
  // A retry of the same change keeps its age (retry order) and whether it was noted; a different change starts over.
  const attempts = sameChange ? prior!.attempts + 1 : 1
  const noted = sameChange && prior!.reason === reason ? prior!.noted : 0
  db.prepare(
    `INSERT INTO sync_deferred (entity_type, entity_id, workspace_id, op, version, payload_json, op_id, reason, message, attempts, noted, created_at, updated_at)
     VALUES (@type, @id, @ws, @op, @version, @payload, @opId, @reason, @message, @attempts, @noted, @now, @now)
     ON CONFLICT (entity_type, entity_id) DO UPDATE SET workspace_id = excluded.workspace_id, op = excluded.op, version = excluded.version,
       payload_json = excluded.payload_json, op_id = excluded.op_id, reason = excluded.reason, message = excluded.message,
       attempts = excluded.attempts, noted = excluded.noted, updated_at = excluded.updated_at,
       created_at = CASE WHEN @keepAge = 1 THEN sync_deferred.created_at ELSE excluded.created_at END`,
  ).run({
    type: ch.type, id: ch.id, ws: ctx.workspaceId, op: ch.op, version: ch.version, payload: ch.payload ? JSON.stringify(ch.payload) : null,
    opId: ch.opId, reason, message: message.slice(0, 1000), attempts, noted, now: ctx.nowS, keepAge: sameChange ? 1 : 0,
  })
  if (reason === 'failed' && !noted) {
    // A failure is noted at once (once per change); a missing parent usually resolves itself a page later.
    console.warn('[slinger]', message)
    noteDeferred(ctx, ch, message)
  }
  return false
}

function noteDeferred(ctx: ApplyCtx, ch: Pick<RemoteChange, 'type' | 'id' | 'payload'>, message: string): void {
  recordAutoResolved(ctx.db, ctx.nowS, {
    workspaceId: ctx.workspaceId, type: ch.type, id: ch.id, kind: 'rejected',
    label: payloadLabel(ch.type, ch.payload) || ch.id, message: `${message} It is applied automatically on a later sync.`,
  })
  ctx.db.prepare('UPDATE sync_deferred SET noted = 1 WHERE entity_type = ? AND entity_id = ?').run(ch.type, ch.id)
}

function rowToChange(r: DeferredRow): RemoteChange {
  let payload: Payload | null = null
  try {
    payload = r.payload_json ? (JSON.parse(r.payload_json) as Payload) : null
  } catch {
    payload = null
  }
  return { type: r.entity_type, id: r.entity_id, op: r.op, version: r.version, payload, opId: r.op_id }
}

const listDeferred = (ctx: ApplyCtx, reason: DeferredRow['reason']) =>
  ctx.db.prepare('SELECT * FROM sync_deferred WHERE workspace_id = ? AND reason = ? ORDER BY created_at, rowid').all(ctx.workspaceId, reason) as DeferredRow[]

/** Applies the changes that failed earlier once more (oldest first); called before a page's own changes. */
export function retryFailed(ctx: ApplyCtx): number {
  let applied = 0
  for (const r of listDeferred(ctx, 'failed')) if (applyRemoteChange(ctx, rowToChange(r))) applied++
  return applied
}

/**
 * Applies the changes waiting for a parent, in passes while a pass makes progress (a folder chain arrives in any
 * order); called after a page's own changes. Returns how many were applied.
 */
export function retryWaiting(ctx: ApplyCtx): number {
  let applied = 0
  for (let pass = 0; pass < 1000; pass++) {
    let progress = 0
    for (const r of listDeferred(ctx, 'missing_parent')) if (applyRemoteChange(ctx, rowToChange(r))) progress++
    applied += progress
    if (!progress) break
  }
  return applied
}

/**
 * After a complete download (last snapshot page, or a pull that has nothing more): changes still waiting for a
 * parent are noted in Sync activity once, so nothing is held back silently. They stay kept and are retried.
 */
export function noteStuckDeferred(ctx: ApplyCtx): void {
  const rows = ctx.db
    .prepare("SELECT * FROM sync_deferred WHERE workspace_id = ? AND reason = 'missing_parent' AND noted = 0 ORDER BY created_at, rowid")
    .all(ctx.workspaceId) as DeferredRow[]
  for (const r of rows) noteDeferred(ctx, rowToChange(r), r.message ?? 'Waiting for its parent, which this device has not received yet.')
}

/** How many remote changes of a workspace are kept for a retry. */
export function deferredCount(ctx: Pick<ApplyCtx, 'db' | 'workspaceId'>): number {
  return (ctx.db.prepare('SELECT COUNT(*) AS n FROM sync_deferred WHERE workspace_id = ?').get(ctx.workspaceId) as { n: number }).n
}
