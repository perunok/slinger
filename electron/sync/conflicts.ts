/** Conflict display shaping and resolution (docs/SYNC_DESIGN.md section 8). */
import type {
  ResolveSyncConflictInput,
  SyncConflict,
  SyncConflictGroup,
  SyncConflictKind,
  SyncEntityType,
  SyncResolution,
} from '../../shared/types'
import type { Db } from '../db/database'
import { invalidInput } from '../lib/errors'
import { newId } from '../lib/ids'
import { parse as parseSemver } from '../services/semver'
import type { ApplyCtx } from './apply'
import { closeConflict, findOpenConflict, type ConflictRow } from './conflictStore'
import { GROUPS, GROUP_LABELS, canonicalJson, loadRow, parsePayload, samePayload, toWire, type AnyRow, type GroupName } from './mapping'
import {
  insertFromPayload,
  overwriteFromPayload,
  parentOf,
  restoreFromPayload,
  softDeleteRow,
  subtree,
  type EntityRef,
} from './rows'
import { clearDirty, getEntity, isDirty, markDirty, putEntity } from './store'
import type { Payload } from './types'

export function allowedResolutions(kind: SyncConflictKind, type: SyncEntityType): SyncResolution[] {
  switch (kind) {
    case 'edit_edit':
      return type === 'request' ? ['keep_local', 'keep_remote', 'merge', 'duplicate'] : ['keep_local', 'keep_remote', 'merge']
    case 'remote_deleted':
    case 'local_deleted':
      return ['keep_local', 'keep_remote']
    case 'immutable_clash':
      return ['keep_remote', 'duplicate']
    case 'rejected':
      return ['keep_remote']
    case 'duplicate_key':
      return []
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------------------------------------------------

/** Breadcrumb `Collection / Folder / Item` from current local rows (names of deleted ancestors included). */
export function pathOf(db: Db, type: SyncEntityType, id: string, label: string): string[] {
  const parts = [label]
  let row = loadRow(db, type, id)
  let cur = row ? parentOf(type, row) : null
  for (let depth = 0; cur && depth < 30; depth++) {
    row = loadRow(db, cur.type, cur.id)
    if (!row) break
    parts.unshift(String(row.name))
    cur = parentOf(cur.type, row)
  }
  return parts
}

function hash(s: string): string {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 6)
}

function displayGroup(db: Db, type: SyncEntityType, group: GroupName, p: Payload | null): string | null {
  if (!p) return null
  const nameOf = (t: SyncEntityType, id: unknown) => {
    if (typeof id !== 'string') return null
    const r = loadRow(db, t, id)
    return r ? String(r.name) : id.slice(0, 8)
  }
  switch (group) {
    case 'name':
      return String(p.name ?? '')
    case 'content': {
      const doc = typeof p.document_json === 'string' ? p.document_json : ''
      return `${String(p.name ?? '')} - ${String(p.method ?? '')} ${String(p.url ?? '')} [details #${hash(doc)}]`
    }
    case 'location': {
      const parts = [nameOf('collection', p.collection_id)]
      const folder = 'parent_folder_id' in p ? p.parent_folder_id : p.folder_id
      parts.push(folder ? nameOf('folder', folder) : '(top level)')
      return parts.join(' / ')
    }
    case 'order':
      return `#${String(p.sort_order ?? 0)}`
    case 'key':
      return String(p.key ?? '')
    case 'value':
      return p.is_secret === true ? '(secret, stays on each device)' : String(p.value ?? '')
  }
  void type
  return null
}

export function toSyncConflict(db: Db, c: ConflictRow): SyncConflict {
  const base = parsePayload(c.base_json)
  const remote = parsePayload(c.remote_json)
  const row = loadRow(db, c.entity_type, c.entity_id)
  const local = row && row.deleted === 0 ? toWire(c.entity_type, row) : parsePayload(c.local_json)
  const conflicting = new Set(JSON.parse(c.groups) as string[])
  const groups: SyncConflictGroup[] = []
  if (c.kind === 'edit_edit') {
    for (const g of Object.keys(GROUPS[c.entity_type]) as GroupName[]) {
      groups.push({
        group: g, label: GROUP_LABELS[g], conflicting: conflicting.has(g),
        base: displayGroup(db, c.entity_type, g, base), local: displayGroup(db, c.entity_type, g, local), remote: displayGroup(db, c.entity_type, g, remote),
      })
    }
  }
  return {
    id: c.id, workspaceId: c.workspace_id, entityType: c.entity_type, entityId: c.entity_id, kind: c.kind, status: c.status,
    label: c.label, path: pathOf(db, c.entity_type, c.entity_id, c.label), message: c.message, groups,
    allowedResolutions: c.status === 'open' ? allowedResolutions(c.kind, c.entity_type) : [],
    createdAt: c.created_at, resolvedAt: c.resolved_at, resolution: (c.resolution as SyncResolution | null) ?? null,
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------------------------------------------------

const key = (r: EntityRef) => `${r.type}:${r.id}`

function noteChange(ctx: ApplyCtx, type: SyncEntityType, id: string, change: 'upsert' | 'delete') {
  ctx.changed.set(`${type}:${id}`, { entityType: type, entityId: id, change })
}

function eBase(db: Db, type: SyncEntityType, id: string): Payload | null {
  return parsePayload(getEntity(db, type, id)?.base_payload ?? null)
}

/** Resolves one open conflict; the caller runs this inside `applyTx` and then triggers a sync. */
export function resolveConflict(ctx: ApplyCtx, c: ConflictRow, input: ResolveSyncConflictInput): void {
  const { db } = ctx
  if (c.status !== 'open') throw invalidInput('this conflict is already resolved')
  const allowed = allowedResolutions(c.kind, c.entity_type)
  if (!allowed.includes(input.resolution)) {
    throw invalidInput(`"${input.resolution}" is not a valid resolution for a ${c.kind} conflict`, { allowed })
  }
  const type = c.entity_type
  const id = c.entity_id
  const ws = ctx.workspaceId
  const remote = parsePayload(c.remote_json)

  switch (c.kind) {
    case 'edit_edit':
      if (input.resolution === 'keep_local') {
        syncedTo(ctx, type, id, c.remote_version, remote)
        markDirty(db, type, id, ws)
      } else if (input.resolution === 'keep_remote') {
        overwriteFromPayload(ctx, type, loadRow(db, type, id)!, remote!)
        syncedTo(ctx, type, id, c.remote_version, remote)
        clearDirty(db, type, id)
        noteChange(ctx, type, id, 'upsert')
      } else if (input.resolution === 'merge') {
        mergeGroups(ctx, c, input)
      } else {
        duplicateRequest(ctx, c)
      }
      break
    case 'local_deleted':
      if (input.resolution === 'keep_local') {
        syncedTo(ctx, type, id, c.remote_version, remote ?? eBase(db, type, id))
        markDirty(db, type, id, ws)
      } else {
        restoreDeleted(ctx, type, id, remote ?? eBase(db, type, id), c.remote_version)
      }
      break
    case 'remote_deleted':
      if (input.resolution === 'keep_local') restoreRemoteDeleted(ctx, { type, id })
      else dropLocalTree(ctx, { type, id })
      break
    case 'rejected':
      discardLocalChange(ctx, type, id)
      break
    case 'immutable_clash':
      if (input.resolution === 'duplicate') recreateVersion(ctx, c, input.newVersion)
      db.prepare('DELETE FROM sync_entities WHERE entity_type = ? AND entity_id = ?').run(type, id)
      clearDirty(db, type, id)
      break
    case 'duplicate_key':
      break
  }
  closeConflict(db, c.id, ctx.nowS, 'resolved', input.resolution)
}

function syncedTo(ctx: ApplyCtx, type: SyncEntityType, id: string, version: number, payload: Payload | null): void {
  putEntity(ctx.db, type, id, ctx.workspaceId, {
    remote_version: version, base_payload: payload ? canonicalJson(payload) : null, remote_deleted: 0, state: 'synced',
  })
}

function mergeGroups(ctx: ApplyCtx, c: ConflictRow, input: ResolveSyncConflictInput): void {
  const { db } = ctx
  const type = c.entity_type
  const row = loadRow(db, type, c.entity_id)!
  const local = toWire(type, row)
  const remote = parsePayload(c.remote_json)!
  const conflicting = JSON.parse(c.groups) as GroupName[]
  const choices = input.fieldChoices ?? {}
  for (const g of conflicting) {
    if (choices[g] !== 'local' && choices[g] !== 'remote') throw invalidInput(`fieldChoices.${g} must be "local" or "remote"`)
  }
  const merged: Payload = { ...local }
  for (const g of conflicting) {
    if (choices[g] === 'remote') for (const f of GROUPS[type][g] ?? []) merged[f] = remote[f] ?? null
  }
  if (!samePayload(merged, local)) {
    overwriteFromPayload(ctx, type, row, merged)
    noteChange(ctx, type, c.entity_id, 'upsert')
  }
  syncedTo(ctx, type, c.entity_id, c.remote_version, remote)
  if (samePayload(merged, remote)) clearDirty(db, type, c.entity_id)
  else markDirty(db, type, c.entity_id, ctx.workspaceId)
}

/** The local request becomes a NEW request ("<name> (conflict copy)"); the original takes the remote content. */
function duplicateRequest(ctx: ApplyCtx, c: ConflictRow): void {
  const { db } = ctx
  const row = loadRow(db, 'request', c.entity_id)!
  const remote = parsePayload(c.remote_json)!
  const local = toWire('request', row)
  const folderId = local.folder_id as string | null
  const folderAlive = folderId ? loadRow(db, 'folder', folderId)?.deleted === 0 : false
  const targetFolder = folderAlive ? folderId : null
  const next = db
    .prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM requests WHERE collection_id = ? AND folder_id IS ? AND deleted = 0')
    .get(row.collection_id, targetFolder) as { n: number }
  const copyId = newId()
  const name = `${String(local.name)} (conflict copy)`.slice(0, 200)
  insertFromPayload(ctx, 'request', copyId, ctx.workspaceId, { ...local, name, folder_id: targetFolder, sort_order: next.n })
  markDirty(db, 'request', copyId, ctx.workspaceId)
  noteChange(ctx, 'request', copyId, 'upsert')
  overwriteFromPayload(ctx, 'request', row, remote)
  syncedTo(ctx, 'request', c.entity_id, c.remote_version, remote)
  clearDirty(db, 'request', c.entity_id)
  noteChange(ctx, 'request', c.entity_id, 'upsert')
}

/** keep_remote on a local delete: bring the item (and deleted ancestors that still exist remotely) back. */
function restoreDeleted(ctx: ApplyCtx, type: SyncEntityType, id: string, payload: Payload | null, version: number): void {
  const { db } = ctx
  if (payload) {
    restoreFromPayload(ctx, type, id, payload)
    syncedTo(ctx, type, id, version, payload)
    clearDirty(db, type, id)
    noteChange(ctx, type, id, 'upsert')
  }
  let cur = parentOf(type, loadRow(db, type, id)!)
  for (let depth = 0; cur && depth < 200; depth++) {
    const r = loadRow(db, cur.type, cur.id)
    if (!r) break
    const e = getEntity(db, cur.type, cur.id)
    if (r.deleted === 1 && e && e.remote_version > 0 && e.base_payload) {
      const base = parsePayload(e.base_payload)!
      restoreFromPayload(ctx, cur.type, cur.id, base)
      syncedTo(ctx, cur.type, cur.id, e.remote_version, base)
      clearDirty(db, cur.type, cur.id)
      const oc = findOpenConflict(db, cur.type, cur.id)
      if (oc) closeConflict(db, oc.id, ctx.nowS, 'auto_resolved')
      noteChange(ctx, cur.type, cur.id, 'upsert')
    }
    cur = parentOf(cur.type, r)
  }
}

function relatedRemoteDeleted(db: Db, target: EntityRef): EntityRef[] {
  const out: EntityRef[] = [target]
  const row = loadRow(db, target.type, target.id)
  let cur = row ? parentOf(target.type, row) : null
  for (let depth = 0; cur && depth < 200; depth++) {
    out.push(cur)
    const r = loadRow(db, cur.type, cur.id)
    cur = r ? parentOf(cur.type, r) : null
  }
  for (const d of subtree(db, target.type, target.id, true)) out.push({ type: d.type, id: d.id })
  return out.filter((r) => {
    const oc = findOpenConflict(db, r.type, r.id)
    return oc?.kind === 'remote_deleted'
  })
}

/** keep_local on "deleted remotely, edited here": re-create the item, its surviving ancestors and descendants remotely. */
function restoreRemoteDeleted(ctx: ApplyCtx, target: EntityRef): void {
  const { db } = ctx
  for (const r of relatedRemoteDeleted(db, target)) {
    putEntity(db, r.type, r.id, ctx.workspaceId, { remote_version: 0, base_payload: null, remote_deleted: 0, state: 'synced' })
    markDirty(db, r.type, r.id, ctx.workspaceId)
    const oc = findOpenConflict(db, r.type, r.id)
    if (oc && key(r) !== key(target)) closeConflict(db, oc.id, ctx.nowS, 'resolved', 'keep_local')
  }
}

/** keep_remote on "deleted remotely, edited here": drop the item and everything below it locally. */
function dropLocalTree(ctx: ApplyCtx, target: EntityRef): void {
  const { db } = ctx
  const all: EntityRef[] = [target, ...subtree(db, target.type, target.id).map((d) => ({ type: d.type, id: d.id }))]
  for (const r of all) {
    const row = loadRow(db, r.type, r.id)
    if (row && row.deleted === 0) softDeleteRow(ctx, r.type, r.id)
    putEntity(db, r.type, r.id, ctx.workspaceId, { remote_version: 0, base_payload: null, remote_deleted: 1, state: 'synced' })
    clearDirty(db, r.type, r.id)
    const oc = findOpenConflict(db, r.type, r.id)
    if (oc && key(r) !== key(target)) closeConflict(db, oc.id, ctx.nowS, 'auto_resolved')
    noteChange(ctx, r.type, r.id, 'delete')
  }
}

/** Discards the local change of one entity: back to the last synced state, or deleted when it never reached the cloud. */
export function discardLocalChange(ctx: ApplyCtx, type: SyncEntityType, id: string): void {
  const { db } = ctx
  const e = getEntity(db, type, id)
  const base = parsePayload(e?.base_payload ?? null)
  const row = loadRow(db, type, id)
  if (row) {
    if (e && e.remote_version > 0 && base) {
      if (row.deleted === 1) restoreFromPayload(ctx, type, id, base)
      else if (!samePayload(toWire(type, row), base)) overwriteFromPayload(ctx, type, row, base)
      noteChange(ctx, type, id, 'upsert')
      putEntity(db, type, id, ctx.workspaceId, { remote_version: e.remote_version, base_payload: e.base_payload, state: 'synced' })
    } else {
      if (row.deleted === 0) softDeleteRow(ctx, type, id)
      db.prepare('DELETE FROM sync_entities WHERE entity_type = ? AND entity_id = ?').run(type, id)
      noteChange(ctx, type, id, 'delete')
    }
  }
  clearDirty(db, type, id)
  const oc = findOpenConflict(db, type, id)
  if (oc) closeConflict(db, oc.id, ctx.nowS, 'auto_resolved')
}

function recreateVersion(ctx: ApplyCtx, c: ConflictRow, newVersion: string | undefined): void {
  const { db } = ctx
  if (!newVersion || !parseSemver(newVersion)) throw invalidInput('newVersion must be a valid semantic version like 1.2.3')
  const local = parsePayload(c.local_json)!
  const clash = db
    .prepare('SELECT 1 FROM collection_versions WHERE collection_id = ? AND version = ? AND deleted = 0')
    .get(String(local.collection_id), newVersion)
  if (clash) throw invalidInput(`version ${newVersion} already exists for this collection`)
  const id = newId()
  insertFromPayload(ctx, 'collection_version', id, ctx.workspaceId, { ...local, semver: newVersion, created_at: new Date(ctx.nowS * 1000).toISOString() })
  markDirty(db, 'collection_version', id, ctx.workspaceId)
  noteChange(ctx, 'collection_version', id, 'upsert')
}

/**
 * Open edit_edit conflicts whose sides now agree (the user typed the same thing, or reverted to the base) close by
 * themselves. Runs after every pull, so a conflict never lingers once it has stopped being one.
 */
export function reevaluateOpenConflicts(ctx: ApplyCtx): number {
  const { db } = ctx
  let closed = 0
  const open = db.prepare("SELECT * FROM sync_conflicts WHERE workspace_id = ? AND status = 'open' AND kind = 'edit_edit'").all(ctx.workspaceId) as ConflictRow[]
  for (const c of open) {
    const row = loadRow(db, c.entity_type, c.entity_id)
    const remote = parsePayload(c.remote_json)
    if (!row || row.deleted === 1 || !remote) continue
    const local = toWire(c.entity_type, row)
    const base = parsePayload(c.base_json)
    if (samePayload(local, remote)) {
      syncedTo(ctx, c.entity_type, c.entity_id, c.remote_version, remote)
      clearDirty(db, c.entity_type, c.entity_id)
    } else if (base && samePayload(local, base)) {
      overwriteFromPayload(ctx, c.entity_type, row, remote)
      syncedTo(ctx, c.entity_type, c.entity_id, c.remote_version, remote)
      clearDirty(db, c.entity_type, c.entity_id)
      noteChange(ctx, c.entity_type, c.entity_id, 'upsert')
    } else continue
    closeConflict(db, c.id, ctx.nowS, 'auto_resolved')
    closed++
  }
  return closed
}

/** Row is clean vs its last synced state (used by discard/status). */
export function isPending(db: Db, type: SyncEntityType, id: string): boolean {
  return isDirty(db, type, id)
}

export type { AnyRow }
