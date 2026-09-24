/**
 * Pull side: applies remote operations to the local database (docs/SYNC_DESIGN.md section 7.3, 8).
 * Everything runs inside the caller's `applyTx` transaction. Detection of conflicts is always local, here.
 */
import type { SyncEntityType } from '../../shared/types'
import type { Db } from '../db/database'
import {
  closeOpenConflictOf,
  findOpenConflict,
  recordAutoResolved,
  upsertOpenConflict,
  closeConflict,
} from './conflictStore'
import { canonicalJson, loadRow, parentRefs, parsePayload, payloadLabel, samePayload, toWire, type AnyRow } from './mapping'
import { merge } from './merge'
import {
  insertFromPayload,
  overwriteFromPayload,
  parentOf,
  serverCascades,
  softDeleteRow,
  subtree,
  type EntityRef,
  type RowEnv,
} from './rows'
import { clearDirty, getEntity, isDirty, markDirty, putEntity, setEntityState } from './store'
import type { ChangeKind, ChangeLog, Payload, PullOp, SnapshotEntity } from './types'

export interface ApplyCtx extends RowEnv {
  workspaceId: string
  changed: ChangeLog
  /** Entities that got a conflict (re)opened during the current op; used to close superseded ones. */
  touched: Set<string>
}

export function makeApplyCtx(env: RowEnv, workspaceId: string): ApplyCtx {
  return { ...env, workspaceId, changed: new Map(), touched: new Set() }
}

const k = (type: SyncEntityType, id: string) => `${type}:${id}`
const TOMBSTONE = { remote_version: 0, base_payload: null, remote_deleted: 1 as const }

function note(ctx: ApplyCtx, type: SyncEntityType, id: string, change: ChangeKind): void {
  ctx.changed.set(k(type, id), { entityType: type, entityId: id, change })
}

const isSentOp = (db: Db, opId: string) => db.prepare('SELECT 1 FROM sync_sent_ops WHERE op_id = ?').get(opId) !== undefined
const dropSentOp = (db: Db, opId: string) => void db.prepare('DELETE FROM sync_sent_ops WHERE op_id = ?').run(opId)

export function applyRemoteOp(ctx: ApplyCtx, op: PullOp): void {
  if (op.op === 'upsert') applyUpsert(ctx, op.resource_type, op.resource_id, op.resulting_version, op.payload ?? {}, op.operation_id)
  else applyDelete(ctx, op.resource_type, op.resource_id, op.operation_id)
}

/** Snapshot entities are applied exactly like a pulled upsert (no operation id). */
export function applySnapshotEntity(ctx: ApplyCtx, e: SnapshotEntity): void {
  applyUpsert(ctx, e.resource_type, e.resource_id, e.version, e.payload ?? {}, null)
}

/** Local state differs from what the remote last confirmed (or is a frozen conflict). */
function isModified(db: Db, type: SyncEntityType, row: AnyRow): boolean {
  const e = getEntity(db, type, row.id as string)
  if (e?.state === 'conflict') return true
  if (!isDirty(db, type, row.id as string)) return false
  const base = parsePayload(e?.base_payload ?? null)
  return base === null || !samePayload(toWire(type, row), base)
}

function applyUpsert(ctx: ApplyCtx, type: SyncEntityType, id: string, version: number, payload: Payload, opId: string | null): void {
  const { db } = ctx
  ctx.touched.delete(k(type, id))
  const E = getEntity(db, type, id)
  const L = loadRow(db, type, id)
  const sent = opId != null && isSentOp(db, opId)
  if (sent) dropSentOp(db, opId!)
  const canon = canonicalJson(payload)

  // 1. Our own operation coming back, or an old/duplicate one: reconcile only.
  if (sent || (E && E.remote_version > 0 && version <= E.remote_version)) {
    if (!E || version >= E.remote_version) {
      putEntity(db, type, id, ctx.workspaceId, { remote_version: version, base_payload: canon, state: E?.state ?? 'synced' })
    }
    if (L && L.deleted === 0 && E?.state !== 'conflict' && samePayload(toWire(type, L), payload)) clearDirty(db, type, id)
    return
  }

  // A remote change to an entity with an open conflict re-evaluates it against the ORIGINAL base.
  const prior = E?.state === 'conflict' ? findOpenConflict(db, type, id) : undefined
  const baseP = prior ? parsePayload(prior.base_json) : parsePayload(E?.base_payload ?? null)
  try {
    upsertInner(ctx, type, id, version, payload, canon, L, baseP, prior !== undefined)
  } finally {
    if (prior && !ctx.touched.has(k(type, id))) {
      closeConflict(db, prior.id, ctx.nowS, 'auto_resolved')
    }
  }
}

function upsertInner(
  ctx: ApplyCtx,
  type: SyncEntityType,
  id: string,
  version: number,
  payload: Payload,
  canon: string,
  L: AnyRow | undefined,
  baseP: Payload | null,
  hadConflict: boolean,
): void {
  const { db } = ctx
  const ws = ctx.workspaceId
  const synced = { remote_version: version, base_payload: canon }

  // Parents must exist locally (a later replay from the checkpoint brings them); never leave dangling rows.
  for (const ref of parentRefs(type, payload)) {
    if (!loadRow(db, ref.type, ref.id)) return
  }

  if (!L) {
    if (type === 'collection_version' && versionLabelClash(ctx, id, payload)) {
      putEntity(db, type, id, ws, { ...synced, state: 'synced' })
      insertFromPayload(ctx, type, id, ws, payload)
      note(ctx, type, id, 'upsert')
      return
    }
    if (type === 'environment_variable') renameClashingVariable(ctx, id, payload)
    const deletedParent = pendingDeletedParent(db, type, payload)
    if (deletedParent) {
      // A remote item was created inside a container the user deleted locally (not pushed yet).
      insertFromPayload(ctx, type, id, ws, payload, 1)
      putEntity(db, type, id, ws, { ...synced, state: 'conflict' })
      markDirty(db, type, id, ws)
      openConflict(ctx, type, id, 'local_deleted', {
        base: null, local: null, remote: payload, remoteVersion: version,
        message: 'This item was added on another device inside something you deleted here.',
      })
      freezeDeletedAncestors(ctx, type, loadRow(db, type, id)!)
      note(ctx, type, id, 'upsert')
      return
    }
    insertFromPayload(ctx, type, id, ws, payload)
    putEntity(db, type, id, ws, { ...synced, state: 'synced' })
    note(ctx, type, id, 'upsert')
    return
  }

  if (L.deleted === 1) {
    const pendingDelete = isDirty(db, type, id)
    if (pendingDelete) {
      if (baseP && samePayload(baseP, payload)) {
        // Remote unchanged: our delete stays pending.
        putEntity(db, type, id, ws, { ...synced, state: hadConflict ? 'conflict' : 'synced' })
        if (hadConflict) openConflictAgain(ctx, type, id, baseP!, payload, version)
        return
      }
      putEntity(db, type, id, ws, { ...synced, state: 'conflict' })
      openConflict(ctx, type, id, 'local_deleted', {
        base: baseP, local: null, remote: payload, remoteVersion: version,
        message: 'You deleted this item here, but it was changed on another device.',
      })
      freezeDeletedAncestors(ctx, type, L)
      return
    }
    // Tombstoned by an earlier remote delete (or delete already acknowledged) and recreated remotely: resurrect.
    if (type === 'environment_variable') renameClashingVariable(ctx, id, payload)
    overwriteFromPayload(ctx, type, L, payload)
    putEntity(db, type, id, ws, { ...synced, state: 'synced' })
    clearDirty(db, type, id)
    note(ctx, type, id, 'upsert')
    return
  }

  // Live locally.
  const localWire = toWire(type, L)
  // No known base (never synced, or tombstoned): local content is authoritative until merged.
  const dirty = baseP === null || !samePayload(localWire, baseP)
  if (!dirty) {
    if (!samePayload(localWire, payload)) {
      if (type === 'environment_variable') renameClashingVariable(ctx, id, payload)
      overwriteFromPayload(ctx, type, L, payload)
      note(ctx, type, id, 'upsert')
    }
    putEntity(db, type, id, ws, { ...synced, state: 'synced' })
    clearDirty(db, type, id)
    return
  }

  const m = merge(type, baseP, localWire, payload)
  if (!samePayload(m.merged, localWire)) {
    if (type === 'environment_variable') renameClashingVariable(ctx, id, m.merged)
    overwriteFromPayload(ctx, type, L, m.merged)
    note(ctx, type, id, 'upsert')
  }
  if (m.conflicting.length) {
    putEntity(db, type, id, ws, { ...synced, state: 'conflict' })
    markDirty(db, type, id, ws)
    openConflict(ctx, type, id, 'edit_edit', {
      groups: m.conflicting, base: baseP, local: localWire, remote: payload, remoteVersion: version,
      message: 'This item was changed on this device and on another device.',
    })
    return
  }
  putEntity(db, type, id, ws, { ...synced, state: 'synced' })
  if (samePayload(m.merged, payload)) clearDirty(db, type, id)
  else markDirty(db, type, id, ws)
}

function openConflictAgain(ctx: ApplyCtx, type: SyncEntityType, id: string, base: Payload, remote: Payload, version: number): void {
  openConflict(ctx, type, id, 'local_deleted', {
    base, local: null, remote, remoteVersion: version,
    message: 'You deleted this item here, but it was changed on another device.',
  })
}

function labelFor(ctx: ApplyCtx, type: SyncEntityType, id: string, ...candidates: Array<Payload | null | undefined>): string {
  for (const c of candidates) {
    const l = payloadLabel(type, c ?? null)
    if (l) return l
  }
  const row = loadRow(ctx.db, type, id)
  return row ? payloadLabel(type, toWire(type, row)) : id
}

function openConflict(
  ctx: ApplyCtx,
  type: SyncEntityType,
  id: string,
  kind: Parameters<typeof upsertOpenConflict>[2]['kind'],
  f: { groups?: string[]; base: Payload | null; local: Payload | null; remote: Payload | null; remoteVersion: number; message: string },
): void {
  upsertOpenConflict(ctx.db, ctx.nowS, {
    workspaceId: ctx.workspaceId, type, id, kind, groups: f.groups, base: f.base, local: f.local, remote: f.remote,
    remoteVersion: f.remoteVersion, label: labelFor(ctx, type, id, f.local, f.remote, f.base), message: f.message,
  })
  ctx.touched.add(k(type, id))
}

/** A direct container that was deleted locally with the delete still pending. */
function pendingDeletedParent(db: Db, type: SyncEntityType, payload: Payload): AnyRow | undefined {
  for (const ref of parentRefs(type, payload)) {
    const row = loadRow(db, ref.type, ref.id)
    if (row && row.deleted === 1 && isDirty(db, ref.type, ref.id)) return row
  }
  return undefined
}

/** Walks up from an entity; every locally deleted, dirty container gets frozen with its own conflict (the delete must not cascade over the new remote item). */
function freezeDeletedAncestors(ctx: ApplyCtx, type: SyncEntityType, row: AnyRow): void {
  const { db } = ctx
  let cur = parentOf(type, row)
  for (let depth = 0; cur && depth < 200; depth++) {
    const r = loadRow(db, cur.type, cur.id)
    if (!r || r.deleted !== 1 || !isDirty(db, cur.type, cur.id)) break
    const e = getEntity(db, cur.type, cur.id)
    if (e && e.state !== 'conflict') {
      const base = parsePayload(e.base_payload)
      setEntityState(db, cur.type, cur.id, 'conflict')
      openConflict(ctx, cur.type, cur.id, 'local_deleted', {
        base, local: null, remote: base, remoteVersion: e.remote_version,
        message: 'Something inside this deleted item was changed on another device.',
      })
    }
    cur = parentOf(cur.type, r)
  }
}

/** Two variables with the same key in one environment: the LOCAL one is renamed, the remote one takes the key. */
function renameClashingVariable(ctx: ApplyCtx, id: string, payload: Payload): void {
  const { db } = ctx
  const envId = String(payload.environment_id ?? '')
  const key = String(payload.key ?? '')
  const clash = db
    .prepare('SELECT id FROM environment_variables WHERE environment_id = ? AND key = ? AND deleted = 0 AND id != ?')
    .get(envId, key, id) as { id: string } | undefined
  if (!clash) return
  let n = 1
  let candidate = `${key}_conflict`
  const exists = db.prepare('SELECT 1 FROM environment_variables WHERE environment_id = ? AND key = ? AND deleted = 0')
  while (exists.get(envId, candidate)) candidate = `${key}_conflict${++n}`
  db.prepare('UPDATE environment_variables SET key = ?, version = version + 1, updated_at = ? WHERE id = ?').run(candidate, ctx.nowS, clash.id)
  markDirty(db, 'environment_variable', clash.id, ctx.workspaceId)
  recordAutoResolved(db, ctx.nowS, {
    workspaceId: ctx.workspaceId, type: 'environment_variable', id: clash.id, kind: 'duplicate_key', label: key,
    message: `Both devices added a variable named "${key}". Yours was renamed to "${candidate}".`,
  })
  note(ctx, 'environment_variable', clash.id, 'upsert')
}

/** Same semver label for one collection under a different id: hide the local one and surface it. Returns true when hidden. */
function versionLabelClash(ctx: ApplyCtx, id: string, payload: Payload): boolean {
  const { db } = ctx
  const clash = db
    .prepare('SELECT * FROM collection_versions WHERE collection_id = ? AND version = ? AND deleted = 0 AND id != ?')
    .get(String(payload.collection_id ?? ''), String(payload.semver ?? ''), id) as AnyRow | undefined
  if (!clash) return false
  hideClashingVersion(ctx, clash)
  return true
}

/** Hides a local version whose label the remote (or the server) already uses; opens `immutable_clash`. */
export function hideClashingVersion(ctx: ApplyCtx, clash: AnyRow): void {
  const { db } = ctx
  const cid = clash.id as string
  const wire = toWire('collection_version', clash)
  softDeleteRow(ctx, 'collection_version', cid)
  const e = getEntity(db, 'collection_version', cid)
  putEntity(db, 'collection_version', cid, ctx.workspaceId, {
    remote_version: e?.remote_version ?? 0, base_payload: e?.base_payload ?? null, remote_deleted: e?.remote_deleted === 1 ? 1 : 0, state: 'conflict',
  })
  clearDirty(db, 'collection_version', cid)
  openConflict(ctx, 'collection_version', cid, 'immutable_clash', {
    base: null, local: wire, remote: null, remoteVersion: 0,
    message: `Version ${String(wire.semver)} already exists in the cloud for this collection (created on another device).`,
  })
  note(ctx, 'collection_version', cid, 'delete')
}

// ---------------------------------------------------------------------------------------------------------------------
// Deletes
// ---------------------------------------------------------------------------------------------------------------------

function applyDelete(ctx: ApplyCtx, type: SyncEntityType, id: string, opId: string | null): void {
  const { db } = ctx
  const ws = ctx.workspaceId
  const E = getEntity(db, type, id)
  const L = loadRow(db, type, id)
  if (opId && isSentOp(db, opId)) dropSentOp(db, opId)
  if (E?.remote_deleted === 1 && (!L || L.deleted === 1)) return

  if (!L) {
    putEntity(db, type, id, ws, TOMBSTONE)
    return
  }
  if (L.deleted === 1) {
    // Deleted on both sides: reconcile silently. Children of a deleted container are tombstoned too.
    tombstoneRow(ctx, type, id)
    for (const c of subtree(db, type, id, true)) if (c.deleted && serverCascades(db, { type, id }, c)) tombstoneRow(ctx, c.type, c.id)
    return
  }

  const container = type === 'collection' || type === 'folder' || type === 'environment'
  const selfModified = isModified(db, type, L)
  const survivors = new Map<string, EntityRef>()
  if (container) {
    for (const d of subtree(db, type, id)) {
      const row = loadRow(db, d.type, d.id)!
      if (!isModified(db, d.type, row)) continue
      survivors.set(k(d.type, d.id), { type: d.type, id: d.id })
      let cur = parentOf(d.type, row)
      for (let depth = 0; cur && depth < 200; depth++) {
        if (cur.type === type && cur.id === id) break
        survivors.set(k(cur.type, cur.id), cur)
        const r = loadRow(db, cur.type, cur.id)
        cur = r ? parentOf(cur.type, r) : null
      }
    }
  }
  if (selfModified || survivors.size > 0) survivors.set(k(type, id), { type, id })

  if (container) {
    for (const d of subtree(db, type, id)) {
      if (survivors.has(k(d.type, d.id))) continue
      // Only what the server itself deleted with the container: something moved in locally (not pushed) lives elsewhere remotely.
      if (!serverCascades(db, { type, id }, d)) continue
      softDeleteRow(ctx, d.type, d.id)
      tombstoneRow(ctx, d.type, d.id)
      note(ctx, d.type, d.id, 'delete')
    }
  }
  if (survivors.size === 0) {
    softDeleteRow(ctx, type, id)
    tombstoneRow(ctx, type, id)
    note(ctx, type, id, 'delete')
    return
  }
  for (const s of survivors.values()) {
    const row = loadRow(db, s.type, s.id)!
    const e = getEntity(db, s.type, s.id)
    const prior = findOpenConflict(db, s.type, s.id)
    const base = prior ? parsePayload(prior.base_json) : parsePayload(e?.base_payload ?? null)
    const local = toWire(s.type, row)
    const isRoot = s.type === type && s.id === id
    if (isRoot || serverCascades(db, { type, id }, s)) {
      putEntity(db, s.type, s.id, ws, { ...TOMBSTONE, state: 'conflict' })
    } else {
      // Moved into the deleted container locally only: the server still has it (elsewhere), so its bookkeeping stays.
      putEntity(db, s.type, s.id, ws, { remote_version: e?.remote_version ?? 0, base_payload: e?.base_payload ?? null, remote_deleted: e?.remote_deleted === 1 ? 1 : 0, state: 'conflict' })
    }
    markDirty(db, s.type, s.id, ws)
    openConflict(ctx, s.type, s.id, 'remote_deleted', {
      base, local, remote: null, remoteVersion: 0,
      message: s.type === type && s.id === id && selfModified
        ? 'This item was deleted on another device, but you changed it here.'
        : 'This item was deleted on another device, but something inside it was changed here.',
    })
  }
}

/** Marks an entity as deleted remotely: bookkeeping tombstone, no pending push, conflicts closed. */
function tombstoneRow(ctx: ApplyCtx, type: SyncEntityType, id: string): void {
  putEntity(ctx.db, type, id, ctx.workspaceId, TOMBSTONE)
  clearDirty(ctx.db, type, id)
  closeOpenConflictOf(ctx.db, type, id, ctx.nowS)
}

// ---------------------------------------------------------------------------------------------------------------------
// Folder cycles (two devices moved folders into each other)
// ---------------------------------------------------------------------------------------------------------------------

/** Undoes local folder moves that, combined with pulled moves, form a cycle. Structure wins (design 8.5). */
export function fixFolderCycles(ctx: ApplyCtx): number {
  const { db } = ctx
  let fixed = 0
  for (let round = 0; round < 20; round++) {
    const cyclic = db
      .prepare(
        `WITH RECURSIVE walk(start, cur, depth) AS (
           SELECT id, parent_folder_id, 1 FROM folders WHERE workspace_id = ? AND deleted = 0 AND parent_folder_id IS NOT NULL
           UNION ALL
           SELECT w.start, f.parent_folder_id, w.depth + 1 FROM walk w JOIN folders f ON f.id = w.cur
             WHERE f.deleted = 0 AND f.parent_folder_id IS NOT NULL AND w.depth < 2000
         ) SELECT DISTINCT start FROM walk WHERE cur = start`,
      )
      .all(ctx.workspaceId) as Array<{ start: string }>
    if (!cyclic.length) break
    const ids = cyclic.map((r) => r.start)
    const dirtyOnes = ids.filter((id) => isDirty(db, 'folder', id))
    for (const id of dirtyOnes.length ? dirtyOnes : ids) {
      const row = loadRow(db, 'folder', id)!
      const e = getEntity(db, 'folder', id)
      const base = parsePayload(e?.base_payload ?? null)
      const parent = base ? ((base.parent_folder_id as string | null) ?? null) : null
      db.prepare('UPDATE folders SET parent_folder_id = ?, version = version + 1, updated_at = ? WHERE id = ?').run(parent, ctx.nowS, id)
      const after = loadRow(db, 'folder', id)!
      if (base && samePayload(toWire('folder', after), base)) clearDirty(db, 'folder', id)
      else markDirty(db, 'folder', id, ctx.workspaceId)
      recordAutoResolved(db, ctx.nowS, {
        workspaceId: ctx.workspaceId, type: 'folder', id, kind: 'rejected', label: String(row.name),
        message: 'A folder move was undone: it conflicted with a move made on another device.',
      })
      note(ctx, 'folder', id, 'upsert')
      fixed++
    }
  }
  return fixed
}
