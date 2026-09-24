/**
 * Push side (docs/SYNC_DESIGN.md 7.1, 7.2): builds wire operations from the dirty set + last-synced payloads,
 * orders and chunks them, and applies push results. Operations are derived from CURRENT rows at push time, so
 * ten offline edits of one entity are one operation and `base_version` is always fresh.
 */
import type { SyncEntityType } from '../../shared/types'
import type { Db } from '../db/database'
import { newId } from '../lib/ids'
import { applyRemoteDelete, applyRemoteState, hideClashingVersion, type ApplyCtx } from './apply'
import { closeConflict, findOpenConflict, recordAutoResolved, upsertOpenConflict } from './conflictStore'
import { canonicalJson, checkLimits, loadRow, parentRefs, parsePayload, payloadLabel, samePayload, toWire } from './mapping'
import { parentOf, serverCascades, type EntityRef } from './rows'
import { clearDirty, getEntity, isDirty, markDirty, putEntity, setEntityState } from './store'
import type { Payload, PushRejected, PushResponse, RejectReason, WireOp } from './types'

export const MAX_OPS_PER_PUSH = 200
/** Soft cap of one push request: chunks are filled up to this size, a single larger operation travels alone. */
export const MAX_BYTES_PER_PUSH = 700_000
/** Nothing above this can ever be sent (the server's push body cap is 8 MiB): such an item is quarantined locally. */
export const MAX_OP_BYTES = 8_000_000

export interface BuiltOp {
  op: WireOp
  type: SyncEntityType
  id: string
  /** `sync_dirty.change_seq` this op was built from; only that state is cleared on acknowledgement. */
  seq: number
  /** Child delete operations dropped from the batch because this container delete cascades on the server. */
  covers: Array<{ type: SyncEntityType; id: string; seq: number }>
  bytes: number
  /** Server message of the rejection that put this op on the retry list (used if it has to be quarantined). */
  rejection?: string
}

export interface BuildResult {
  ops: BuiltOp[]
  /** Dirty entities dropped as no-ops or create+delete pairs. */
  cleared: number
  /** Entities put into an open `rejected` conflict (limits) by this build. */
  quarantined: number
}

interface DirtyJoin {
  entity_type: SyncEntityType
  entity_id: string
  change_seq: number
  op_id: string | null
  remote_version: number | null
  base_payload: string | null
  state: 'synced' | 'conflict' | null
  remote_deleted: number | null
}

const CONTAINERS: readonly SyncEntityType[] = ['collection', 'folder', 'environment']

/** Puts an entity into a frozen `rejected` conflict (never retried in a loop). */
export function quarantine(db: Db, nowS: number, workspaceId: string, type: SyncEntityType, id: string, message: string, local: Payload | null): void {
  const e = getEntity(db, type, id)
  const base = parsePayload(e?.base_payload ?? null)
  putEntity(db, type, id, workspaceId, {
    remote_version: e?.remote_version ?? 0, base_payload: e?.base_payload ?? null, remote_deleted: e?.remote_deleted === 1 ? 1 : 0, state: 'conflict',
  })
  upsertOpenConflict(db, nowS, {
    workspaceId, type, id, kind: 'rejected', base, local, remote: null, remoteVersion: e?.remote_version ?? 0,
    label: payloadLabel(type, local ?? base) || id, message,
  })
}

export function buildOps(db: Db, workspaceId: string, nowMs: number): BuildResult {
  return db.transaction((): BuildResult => {
    const nowS = Math.floor(nowMs / 1000)
    const rows = db
      .prepare(
        `SELECT d.entity_type, d.entity_id, d.change_seq, d.op_id, e.remote_version, e.base_payload, e.state, e.remote_deleted
         FROM sync_dirty d LEFT JOIN sync_entities e ON e.entity_type = d.entity_type AND e.entity_id = d.entity_id
         WHERE d.workspace_id = ? ORDER BY d.rowid`,
      )
      .all(workspaceId) as DirtyJoin[]
    const ops: BuiltOp[] = []
    let cleared = 0
    let quarantined = 0
    const occurredAt = new Date(nowMs).toISOString()

    for (const d of rows) {
      const type = d.entity_type
      const id = d.entity_id
      const row = loadRow(db, type, id)
      if (!row) {
        clearDirty(db, type, id)
        cleared++
        continue
      }
      if (d.state === 'conflict') {
        const c = findOpenConflict(db, type, id)
        // A quarantined (rejected) entity that was edited again is re-armed automatically.
        if (c && c.kind === 'rejected' && row.deleted === 0 && !samePayload(toWire(type, row), parsePayload(c.local_json))) {
          closeConflict(db, c.id, nowS, 'auto_resolved')
          setEntityState(db, type, id, 'synced')
        } else continue
      }
      const rv = d.remote_version ?? 0
      const base = parsePayload(d.base_payload)
      let payload: Payload
      let kind: 'upsert' | 'delete'
      if (row.deleted === 1) {
        if (rv === 0) {
          clearDirty(db, type, id)
          cleared++
          continue
        }
        kind = 'delete'
        payload = {}
      } else {
        payload = toWire(type, row)
        if (rv > 0 && base && samePayload(payload, base)) {
          clearDirty(db, type, id)
          cleared++
          continue
        }
        kind = 'upsert'
        const problem = checkLimits(type, payload)
        if (problem) {
          quarantine(db, nowS, workspaceId, type, id, problem, payload)
          quarantined++
          continue
        }
        // A child of an entity that no longer exists remotely waits for that conflict to be resolved.
        if (parentRefs(type, payload).some((r) => getEntity(db, r.type, r.id)?.state === 'conflict' && getEntity(db, r.type, r.id)?.remote_deleted === 1)) continue
      }
      let opId = d.op_id
      if (!opId) {
        opId = newId()
        db.prepare('UPDATE sync_dirty SET op_id = ? WHERE entity_type = ? AND entity_id = ? AND change_seq = ?').run(opId, type, id, d.change_seq)
      }
      db.prepare('INSERT OR IGNORE INTO sync_sent_ops (op_id, workspace_id, entity_type, entity_id, sent_at) VALUES (?, ?, ?, ?, ?)').run(
        opId, workspaceId, type, id, nowS,
      )
      const op: WireOp = { operation_id: opId, resource_type: type, resource_id: id, op: kind, base_version: rv, payload, occurred_at: occurredAt }
      const bytes = Buffer.byteLength(JSON.stringify(op), 'utf8')
      if (bytes > MAX_OP_BYTES) {
        quarantine(db, nowS, workspaceId, type, id, `This item is ${Math.round(bytes / 1000)} KB, larger than the ${MAX_OP_BYTES / 1_000_000} MB a single sync request may carry.`, payload)
        quarantined++
        continue
      }
      ops.push({ op, type, id, seq: d.change_seq, covers: [], bytes })
    }
    return { ops: pruneCascadedDeletes(db, ops), cleared, quarantined }
  })()
}

/** Drops child delete ops whose container delete is in the same batch (the server cascades and logs them). */
function pruneCascadedDeletes(db: Db, ops: BuiltOp[]): BuiltOp[] {
  const deletes = new Map<string, BuiltOp>()
  for (const o of ops) if (o.op.op === 'delete') deletes.set(`${o.type}:${o.id}`, o)
  const dropped = new Set<string>()
  for (const o of ops) {
    if (o.op.op !== 'delete' || !CONTAINERS.includes(o.type)) continue
    for (const c of deletes.values()) {
      if (c === o || dropped.has(`${c.type}:${c.id}`)) continue
      if (!serverCascades(db, { type: o.type, id: o.id }, { type: c.type, id: c.id })) continue
      dropped.add(`${c.type}:${c.id}`)
      o.covers.push({ type: c.type, id: c.id, seq: c.seq })
    }
  }
  return ops.filter((o) => !dropped.has(`${o.type}:${o.id}`))
}

/**
 * Dependency order (design 7.1): variable deletes first; upserts collection, environment, folders parents-first
 * (by depth), request, variable, version; then deletes leaves first. Stable within a group.
 */
export function orderOps(db: Db, ops: BuiltOp[]): BuiltOp[] {
  const depthCache = new Map<string, number>()
  const folderDepth = (id: string): number => {
    const cached = depthCache.get(id)
    if (cached !== undefined) return cached
    let depth = 0
    let cur: string | null = id
    const seen = new Set<string>()
    while (cur && !seen.has(cur)) {
      seen.add(cur)
      const r = loadRow(db, 'folder', cur)
      cur = (r?.parent_folder_id as string | null) ?? null
      if (cur) depth++
    }
    depthCache.set(id, depth)
    return depth
  }
  const upsertRank: Record<SyncEntityType, number> = { collection: 0, environment: 1, folder: 2, request: 3, environment_variable: 4, collection_version: 5 }
  const deleteRank: Record<SyncEntityType, number> = { request: 0, folder: 1, collection_version: 2, collection: 3, environment: 4, environment_variable: -1 }
  const keyed = ops.map((o, i) => {
    let group: number
    let rank: number
    let depth = 0
    if (o.op.op === 'delete' && o.type === 'environment_variable') {
      group = 0
      rank = 0
    } else if (o.op.op === 'upsert') {
      group = 1
      rank = upsertRank[o.type]
      if (o.type === 'folder') depth = folderDepth(o.id)
    } else {
      group = 2
      rank = deleteRank[o.type]
      if (o.type === 'folder') depth = -folderDepth(o.id)
    }
    return { o, i, group, rank, depth }
  })
  keyed.sort((a, b) => a.group - b.group || a.rank - b.rank || a.depth - b.depth || a.i - b.i)
  return keyed.map((x) => x.o)
}

export function chunkOps(ops: BuiltOp[], maxOps = MAX_OPS_PER_PUSH, maxBytes = MAX_BYTES_PER_PUSH): BuiltOp[][] {
  const chunks: BuiltOp[][] = []
  let cur: BuiltOp[] = []
  let bytes = 0
  for (const o of ops) {
    if (cur.length && (cur.length >= maxOps || bytes + o.bytes > maxBytes)) {
      chunks.push(cur)
      cur = []
      bytes = 0
    }
    cur.push(o)
    bytes += o.bytes
  }
  if (cur.length) chunks.push(cur)
  return chunks
}

export interface PushOutcome {
  accepted: number
  /** Rejected entities that need a fresh pull before the retry (no usable server state in the rejection). */
  retry: BuiltOp[]
  /**
   * Rejections settled locally from the rejection itself (merged against `current_payload`, remote delete applied,
   * a key that the same batch frees): whatever is still pending can be pushed again WITHOUT pulling first.
   */
  resolved: number
  /** Server answered `internal_error` for some operation(s): treat like a transient failure. */
  transient: boolean
  /** New rejected conflicts opened (or local renames made) that may have produced new work. */
  conflicts: number
  /** The server said this account may not write here (`read_only`/`forbidden`): stop pushing, keep everything dirty. */
  denied: 'read_only' | 'forbidden' | null
}

const REASONS: ReadonlySet<string> = new Set<RejectReason>([
  'version_mismatch', 'not_found', 'invalid', 'too_large', 'id_in_use', 'duplicate_key', 'immutable', 'forbidden', 'read_only', 'internal_error',
])

/**
 * The reason a rejection is handled by. Protocol v2 servers send `reason` (authoritative); a missing or unknown one
 * is derived from the legacy `code` so an older server (or a newer reason we do not know) still gets a safe answer.
 */
export function rejectionReason(r: Pick<PushRejected, 'code' | 'reason'>, type: SyncEntityType): RejectReason {
  if (r.reason && REASONS.has(r.reason)) return r.reason
  switch (r.code) {
    case 'sync_conflict':
      return 'version_mismatch' // without current_payload: pull, then retry (a deleted row arrives as a tombstone)
    case 'not_found':
      return 'not_found'
    case 'invalid_request':
      return 'invalid'
    case 'conflict':
      // Legacy servers used a plain `conflict` for unique clashes (variable keys, version labels) and id clashes.
      return type === 'environment_variable' || type === 'collection_version' ? 'duplicate_key' : 'id_in_use'
    default:
      return 'internal_error'
  }
}

/** Applies one push response. Must run inside `applyTx` (a rejected key clash renames a local variable). */
export function applyPushResponse(ctx: ApplyCtx, chunk: BuiltOp[], resp: PushResponse): PushOutcome {
  const { db, workspaceId } = ctx
  const byOp = new Map(chunk.map((c) => [c.op.operation_id, c]))
  const out: PushOutcome = { accepted: 0, retry: [], resolved: 0, transient: false, conflicts: 0, denied: null }
  const settled = (b: BuiltOp) => void db.prepare('DELETE FROM sync_sent_ops WHERE op_id = ?').run(b.op.operation_id)
  const acceptedIds = new Set(resp.accepted.map((a) => a.resource_id))

  for (const a of resp.accepted) {
    const b = byOp.get(a.operation_id)
    if (!b) continue
    byOp.delete(a.operation_id)
    ack(ctx, b, a.resulting_version)
    out.accepted++
  }
  for (const r of resp.rejected) {
    const b = byOp.get(r.operation_id)
    if (!b) continue
    byOp.delete(r.operation_id)
    const { type, id } = b
    const local = b.op.op === 'upsert' ? b.op.payload : null
    const reason = rejectionReason(r, type)
    switch (reason) {
      case 'version_mismatch': {
        // The server moved on. v2 tells us its current state: merge now (like a pulled upsert) and push again at once.
        const current = r.current_payload
        if (current && r.current_version != null && mergedGuarded(ctx, () => applyRemoteState(ctx, type, id, r.current_version!, current, b.op.operation_id))) {
          settled(b)
          out.resolved++
        } else out.retry.push(b) // pull brings the change (or the tombstone), then the op is rebuilt
        break
      }
      case 'not_found':
        if (b.op.op === 'delete') {
          ack(ctx, b, 0) // already gone
          out.accepted++
        } else if (r.code === 'sync_conflict' && b.op.base_version > 0) {
          // The entity itself was deleted on the server: exactly what pulling its tombstone would do (remote_deleted).
          if (mergedGuarded(ctx, () => (applyRemoteDelete(ctx, type, id), true))) {
            settled(b)
            out.resolved++
          } else out.retry.push(b)
        } else out.retry.push(b) // a parent / target collection is missing remotely: pull first (quarantined if it persists)
        break
      case 'invalid':
      case 'too_large':
        if (reason === 'invalid' && b.op.op === 'upsert' && refsFolder(b)) {
          // The server reports a folder that does not exist (deleted meanwhile) as `invalid`, not `not_found`: pull
          // first (the tombstone turns this into a remote_deleted conflict); the cycle quarantines it if it persists.
          b.rejection = r.message
          out.retry.push(b)
          break
        }
        quarantine(db, ctx.nowS, workspaceId, type, id, `The cloud rejected this item: ${r.message}`, local)
        out.conflicts++
        settled(b)
        break
      case 'id_in_use':
        quarantine(db, ctx.nowS, workspaceId, type, id, `This item's id is already used by another cloud workspace (${r.message}).`, local)
        out.conflicts++
        settled(b)
        break
      case 'duplicate_key':
        if (keyFreedByUs(ctx, b, r.conflicting_resource_id ?? null, acceptedIds)) {
          out.resolved++ // our own pending change frees the key: push again after it (same op id, nothing was applied)
          break
        }
        handleDuplicateKey(ctx, b, r.message)
        out.conflicts++
        settled(b)
        break
      case 'immutable': {
        const row = type === 'collection_version' ? loadRow(db, type, id) : undefined
        if (row) {
          const current = r.current_payload ?? null
          hideClashingVersion(ctx, row, current && r.current_version != null ? { remote: current, remoteVersion: r.current_version } : undefined)
        } else quarantine(db, ctx.nowS, workspaceId, type, id, `The cloud refused to change this item: ${r.message}`, local)
        out.conflicts++
        settled(b)
        break
      }
      case 'read_only':
      case 'forbidden':
        // Reserved per-operation reasons: never drop the change; the engine stops pushing and re-checks the role.
        out.denied = reason === 'read_only' || out.denied === 'read_only' ? 'read_only' : 'forbidden'
        break
      case 'internal_error':
        out.transient = true
        break
    }
  }
  // Operations the server did not answer at all: leave everything untouched (retried with the same op ids).
  return out
}

const refsFolder = (b: BuiltOp): boolean =>
  (b.type === 'request' && b.op.payload.folder_id != null) || (b.type === 'folder' && b.op.payload.parent_folder_id != null)

/** Runs a local resolution in a savepoint; a failure rolls just it back and the caller falls back to pull + retry. */
function mergedGuarded(ctx: ApplyCtx, fn: () => boolean): boolean {
  try {
    return ctx.db.transaction(fn)()
  } catch (err) {
    console.warn('[slinger] could not settle a push rejection locally:', err instanceof Error ? err.message : err)
    return false
  }
}

/**
 * `duplicate_key` against an entity of OUR OWN that gives the key up locally (deleted, re-keyed or re-labelled):
 * either later in this same push (the server applies in array order and upserts precede deletes, so it is already
 * accepted in `acceptedIds`) or in a pending change that is not frozen. Nothing is wrong: the retry goes through.
 */
function keyFreedByUs(ctx: ApplyCtx, b: BuiltOp, holderId: string | null, acceptedIds: Set<string>): boolean {
  const { db } = ctx
  if (!holderId || holderId === b.id || (b.type !== 'environment_variable' && b.type !== 'collection_version')) return false
  const holder = loadRow(db, b.type, holderId)
  if (!holder) return false
  const pending = isDirty(db, b.type, holderId) && getEntity(db, b.type, holderId)?.state !== 'conflict'
  if (!pending && !acceptedIds.has(holderId)) return false
  if (holder.deleted === 1) return true
  const mine = loadRow(db, b.type, b.id)
  if (!mine) return false
  return b.type === 'environment_variable'
    ? holder.environment_id !== mine.environment_id || holder.key !== mine.key
    : holder.collection_id !== mine.collection_id || holder.version !== mine.version
}

function ack(ctx: ApplyCtx, b: BuiltOp, resultingVersion: number): void {
  const { db, workspaceId } = ctx
  const e = getEntity(db, b.type, b.id)
  if (b.op.op === 'delete') {
    putEntity(db, b.type, b.id, workspaceId, { remote_version: 0, base_payload: null, remote_deleted: 1, state: e?.state === 'conflict' ? 'conflict' : 'synced' })
    for (const c of b.covers) {
      putEntity(db, c.type, c.id, workspaceId, { remote_version: 0, base_payload: null, remote_deleted: 1 })
      db.prepare('DELETE FROM sync_dirty WHERE entity_type = ? AND entity_id = ? AND change_seq = ?').run(c.type, c.id, c.seq)
    }
  } else {
    putEntity(db, b.type, b.id, workspaceId, {
      remote_version: Math.max(e?.remote_version ?? 0, resultingVersion),
      base_payload: canonicalJson(b.op.payload),
      state: e?.state === 'conflict' ? 'conflict' : 'synced',
    })
  }
  db.prepare('DELETE FROM sync_dirty WHERE entity_type = ? AND entity_id = ? AND change_seq = ?').run(b.type, b.id, b.seq)
  db.prepare('DELETE FROM sync_sent_ops WHERE op_id = ?').run(b.op.operation_id)
}

/** A unique key (variable key / version label) is taken in the cloud by another id (design 8.4, `immutable_clash`). */
function handleDuplicateKey(ctx: ApplyCtx, b: BuiltOp, serverMessage: string): void {
  const { db, workspaceId } = ctx
  if (b.type === 'environment_variable') {
    const row = loadRow(db, b.type, b.id)
    if (row && row.deleted === 0) {
      const envId = row.environment_id as string
      const key = row.key as string
      let n = 1
      let candidate = `${key}_conflict`
      const exists = db.prepare('SELECT 1 FROM environment_variables WHERE environment_id = ? AND key = ? AND deleted = 0')
      while (exists.get(envId, candidate)) candidate = `${key}_conflict${++n}`
      db.prepare('UPDATE environment_variables SET key = ?, version = version + 1, updated_at = ? WHERE id = ?').run(candidate, ctx.nowS, b.id)
      markDirty(db, b.type, b.id, workspaceId)
      recordAutoResolved(db, ctx.nowS, {
        workspaceId, type: b.type, id: b.id, kind: 'duplicate_key', label: key,
        message: `A variable named "${key}" already exists in the cloud. Yours was renamed to "${candidate}".`,
      })
      return
    }
  }
  if (b.type === 'collection_version') {
    const row = loadRow(db, b.type, b.id)
    if (row) {
      hideClashingVersion(ctx, row)
      return
    }
  }
  quarantine(db, ctx.nowS, workspaceId, b.type, b.id, `The cloud refused this item: ${serverMessage}`, b.op.op === 'upsert' ? b.op.payload : null)
}

/** Ancestor-first helper exported for tests: the parent container of a local row. */
export function containerOf(db: Db, type: SyncEntityType, id: string): EntityRef | null {
  const row = loadRow(db, type, id)
  return row ? parentOf(type, row) : null
}
