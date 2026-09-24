/**
 * Push side (docs/SYNC_DESIGN.md 7.1, 7.2): builds wire operations from the dirty set + last-synced payloads,
 * orders and chunks them, and applies push results. Operations are derived from CURRENT rows at push time, so
 * ten offline edits of one entity are one operation and `base_version` is always fresh.
 */
import type { SyncEntityType } from '../../shared/types'
import type { Db } from '../db/database'
import { newId } from '../lib/ids'
import { hideClashingVersion, type ApplyCtx } from './apply'
import { closeConflict, findOpenConflict, recordAutoResolved, upsertOpenConflict } from './conflictStore'
import { canonicalJson, checkLimits, loadRow, parentRefs, parsePayload, payloadLabel, samePayload, toWire } from './mapping'
import { parentOf, serverCascades, type EntityRef } from './rows'
import { clearDirty, getEntity, markDirty, putEntity, setEntityState } from './store'
import type { Payload, PushResponse, WireOp } from './types'

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
  /** Entities rejected with `sync_conflict` (or `not_found` on an upsert): a fresh pull must precede the retry. */
  retry: BuiltOp[]
  /** Server answered `internal_error` for some operation(s): treat like a transient failure. */
  transient: boolean
  /** New rejected conflicts opened. */
  conflicts: number
}

/** Applies one push response. Must run inside `applyTx` (a rejected key clash renames a local variable). */
export function applyPushResponse(ctx: ApplyCtx, chunk: BuiltOp[], resp: PushResponse): PushOutcome {
  const { db, workspaceId } = ctx
  const byOp = new Map(chunk.map((c) => [c.op.operation_id, c]))
  const out: PushOutcome = { accepted: 0, retry: [], transient: false, conflicts: 0 }

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
    switch (r.code) {
      case 'sync_conflict':
        out.retry.push(b)
        break
      case 'not_found':
        if (b.op.op === 'delete') {
          ack(ctx, b, 0)
          out.accepted++
        } else out.retry.push(b)
        break
      case 'invalid_request':
        quarantine(db, ctx.nowS, workspaceId, type, id, `The cloud rejected this item: ${r.message}`, local)
        out.conflicts++
        break
      case 'conflict':
        handleConflictRejection(ctx, b, r.message)
        out.conflicts++
        break
      case 'internal_error':
        out.transient = true
        break
    }
    if (r.code !== 'internal_error' && r.code !== 'sync_conflict' && r.code !== 'not_found') {
      db.prepare('DELETE FROM sync_sent_ops WHERE op_id = ?').run(b.op.operation_id)
    }
  }
  // Operations the server did not answer at all: leave everything untouched (retried with the same op ids).
  return out
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

function handleConflictRejection(ctx: ApplyCtx, b: BuiltOp, serverMessage: string): void {
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
  quarantine(db, ctx.nowS, workspaceId, b.type, b.id, `This item's id is already used by another cloud workspace (${serverMessage}).`, b.op.op === 'upsert' ? b.op.payload : null)
}

/** Ancestor-first helper exported for tests: the parent container of a local row. */
export function containerOf(db: Db, type: SyncEntityType, id: string): EntityRef | null {
  const row = loadRow(db, type, id)
  return row ? parentOf(type, row) : null
}
