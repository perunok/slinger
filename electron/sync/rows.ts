/**
 * Writers/readers for synced rows used by the pull side and by conflict resolution. Everything here runs
 * inside `applyTx` (triggers suppressed) and never touches the OS keychain except through `effects`
 * (deferred until the transaction committed) or the idempotent `secrets.set` for plaintext -> secret moves.
 */
import type { SyncEntityType } from '../../shared/types'
import type { Db } from '../db/database'
import { envVarSecretKey, type SecretStore } from '../services/secrets'
import { parse as parseSemver } from '../services/semver'
import { TABLE, loadRow, parsePayload, toWire, type AnyRow } from './mapping'
import { getEntity } from './store'
import type { Payload } from './types'

export interface RowEnv {
  db: Db
  secrets: SecretStore
  /** Epoch seconds. */
  nowS: number
  /** Run after the surrounding transaction committed (keychain deletes). */
  effects: Array<() => void>
}

export interface EntityRef {
  type: SyncEntityType
  id: string
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const nullableStr = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const int = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : fallback)

/** The container an entity hangs off (root folders/requests hang off their collection). */
export function parentOf(type: SyncEntityType, row: AnyRow): EntityRef | null {
  switch (type) {
    case 'folder':
      return row.parent_folder_id ? { type: 'folder', id: row.parent_folder_id as string } : { type: 'collection', id: row.collection_id as string }
    case 'request':
      return row.folder_id ? { type: 'folder', id: row.folder_id as string } : { type: 'collection', id: row.collection_id as string }
    case 'environment_variable':
      return { type: 'environment', id: row.environment_id as string }
    case 'collection_version':
      return { type: 'collection', id: row.collection_id as string }
    default:
      return null
  }
}

/** All entities below a container (not including it). */
export function subtree(db: Db, type: SyncEntityType, id: string, includeDeleted = false): Array<EntityRef & { deleted: boolean }> {
  const live = includeDeleted ? '' : ' AND deleted = 0'
  const out: Array<EntityRef & { deleted: boolean }> = []
  const add = (t: SyncEntityType, rows: Array<{ id: string; deleted: number }>) => {
    for (const r of rows) out.push({ type: t, id: r.id, deleted: r.deleted === 1 })
  }
  if (type === 'collection') {
    add('folder', db.prepare(`SELECT id, deleted FROM folders WHERE collection_id = ?${live}`).all(id) as never)
    add('request', db.prepare(`SELECT id, deleted FROM requests WHERE collection_id = ?${live}`).all(id) as never)
    add('collection_version', db.prepare(`SELECT id, deleted FROM collection_versions WHERE collection_id = ?${live}`).all(id) as never)
  } else if (type === 'environment') {
    add('environment_variable', db.prepare(`SELECT id, deleted FROM environment_variables WHERE environment_id = ?${live}`).all(id) as never)
  } else if (type === 'folder') {
    const folders = db
      .prepare(
        `WITH RECURSIVE tree(id) AS (SELECT id FROM folders WHERE parent_folder_id = ?
           UNION SELECT f.id FROM folders f JOIN tree t ON f.parent_folder_id = t.id)
         SELECT f.id, f.deleted FROM folders f JOIN tree t ON t.id = f.id${includeDeleted ? '' : ' WHERE f.deleted = 0'}`,
      )
      .all(id) as Array<{ id: string; deleted: number }>
    add('folder', folders)
    const ids = [id, ...folders.map((f) => f.id)]
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500)
      add(
        'request',
        db
          .prepare(`SELECT id, deleted FROM requests WHERE folder_id IN (${chunk.map(() => '?').join(',')})${live}`)
          .all(...chunk) as never,
      )
    }
  }
  return out
}

/** Live local row of a container or undefined. */
export function liveRow(db: Db, type: SyncEntityType, id: string): AnyRow | undefined {
  const row = loadRow(db, type, id)
  return row && row.deleted === 0 ? row : undefined
}

export function insertFromPayload(env: RowEnv, type: SyncEntityType, id: string, workspaceId: string, p: Payload, deleted = 0): void {
  const { db, nowS } = env
  switch (type) {
    case 'collection':
      db.prepare(
        `INSERT INTO collections (id, workspace_id, name, version, deleted, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)`,
      ).run(id, workspaceId, str(p.name), deleted, nowS, nowS)
      break
    case 'environment':
      db.prepare(
        `INSERT INTO environments (id, workspace_id, name, version, deleted, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)`,
      ).run(id, workspaceId, str(p.name), deleted, nowS, nowS)
      break
    case 'folder':
      db.prepare(
        `INSERT INTO folders (id, workspace_id, collection_id, parent_folder_id, name, sort_order, version, deleted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      ).run(id, workspaceId, str(p.collection_id), nullableStr(p.parent_folder_id), str(p.name), int(p.sort_order), deleted, nowS, nowS)
      break
    case 'request':
      db.prepare(
        `INSERT INTO requests (id, workspace_id, collection_id, folder_id, name, method, url, document_json, sort_order, version, deleted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      ).run(id, workspaceId, str(p.collection_id), nullableStr(p.folder_id), str(p.name), str(p.method, 'GET'), str(p.url), str(p.document_json, '{}'), int(p.sort_order), deleted, nowS, nowS)
      break
    case 'environment_variable': {
      const secret = p.is_secret === true
      const ref = secret ? envVarSecretKey(id) : null
      const missing = secret && env.secrets.get(ref!) === null ? 1 : 0
      db.prepare(
        `INSERT INTO environment_variables (id, environment_id, key, value, is_secret, secret_ref, secret_missing, version, deleted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      ).run(id, str(p.environment_id), str(p.key), secret ? null : str(p.value), secret ? 1 : 0, ref, missing, deleted, nowS, nowS)
      break
    }
    case 'collection_version': {
      const sv = parseSemver(p.semver)
      if (!sv) throw new Error(`invalid semver in synced collection version: ${String(p.semver)}`)
      const created = typeof p.created_at === 'string' ? Math.floor(Date.parse(p.created_at) / 1000) : nowS
      db.prepare(
        `INSERT INTO collection_versions (id, workspace_id, collection_id, version, version_major, version_minor, version_patch,
           version_prerelease, notes, snapshot_json, folder_count, request_count, deleted, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, workspaceId, str(p.collection_id), str(p.semver), sv.major, sv.minor, sv.patch, sv.prerelease.length ? sv.prerelease.join('.') : null,
        nullableStr(p.notes), str(p.snapshot_json, '{}'), int(p.folder_count), int(p.request_count), deleted, Number.isFinite(created) ? created : nowS)
      break
    }
  }
}

/**
 * Overwrites a row with a payload (un-deleting it) and bumps its local `version` so an open editor sees
 * `version_conflict`. Fields absent from the payload keep their local value. Collection versions are immutable:
 * only un-hiding is possible.
 */
export function overwriteFromPayload(env: RowEnv, type: SyncEntityType, row: AnyRow, p: Payload): void {
  const { db, nowS } = env
  const id = row.id as string
  const has = (k: string) => p[k] !== undefined
  switch (type) {
    case 'collection':
    case 'environment':
      db.prepare(`UPDATE ${TABLE[type]} SET name = ?, deleted = 0, version = version + 1, updated_at = ? WHERE id = ?`).run(has('name') ? str(p.name) : row.name, nowS, id)
      break
    case 'folder':
      db.prepare(
        `UPDATE folders SET collection_id = ?, parent_folder_id = ?, name = ?, sort_order = ?, deleted = 0, version = version + 1, updated_at = ? WHERE id = ?`,
      ).run(has('collection_id') ? str(p.collection_id) : row.collection_id, has('parent_folder_id') ? nullableStr(p.parent_folder_id) : row.parent_folder_id,
        has('name') ? str(p.name) : row.name, has('sort_order') ? int(p.sort_order) : row.sort_order, nowS, id)
      break
    case 'request':
      db.prepare(
        `UPDATE requests SET collection_id = ?, folder_id = ?, name = ?, method = ?, url = ?, document_json = ?, sort_order = ?,
           deleted = 0, version = version + 1, updated_at = ? WHERE id = ?`,
      ).run(has('collection_id') ? str(p.collection_id) : row.collection_id, has('folder_id') ? nullableStr(p.folder_id) : row.folder_id,
        has('name') ? str(p.name) : row.name, has('method') ? str(p.method, 'GET') : row.method, has('url') ? str(p.url) : row.url,
        has('document_json') ? str(p.document_json, '{}') : row.document_json, has('sort_order') ? int(p.sort_order) : row.sort_order, nowS, id)
      break
    case 'environment_variable':
      overwriteVariable(env, row, p)
      break
    case 'collection_version':
      if (row.deleted === 1) db.prepare('UPDATE collection_versions SET deleted = 0 WHERE id = ?').run(id)
      break
  }
}

function overwriteVariable(env: RowEnv, row: AnyRow, p: Payload): void {
  const { db, nowS, secrets } = env
  const id = row.id as string
  const wasDeleted = row.deleted === 1
  const wasSecret = row.is_secret === 1 && !wasDeleted
  const willSecret = p.is_secret === true
  const key = p.key !== undefined ? str(p.key) : (row.key as string)
  const environmentId = p.environment_id !== undefined ? str(p.environment_id) : (row.environment_id as string)
  const ref = envVarSecretKey(id)
  let value: string | null
  let secretMissing = 0
  if (willSecret) {
    if (wasSecret) {
      // Still secret: the value stays in this device's keychain.
      secretMissing = row.secret_missing === 1 ? 1 : 0
    } else if (!wasDeleted) {
      // plaintext -> secret: the plaintext we hold moves into the keychain (never lost, never sent).
      secrets.set(ref, (row.value as string | null) ?? '')
    } else {
      secretMissing = secrets.get(ref) === null ? 1 : 0
    }
    value = null
  } else {
    value = p.value === undefined || p.value === null ? '' : str(p.value)
    if (wasSecret && row.secret_ref) {
      const r = row.secret_ref as string
      env.effects.push(() => secrets.delete(r))
    }
  }
  db.prepare(
    `UPDATE environment_variables SET environment_id = ?, key = ?, value = ?, is_secret = ?, secret_ref = ?, secret_missing = ?,
       deleted = 0, version = version + 1, updated_at = ? WHERE id = ?`,
  ).run(environmentId, key, value, willSecret ? 1 : 0, willSecret ? ref : null, secretMissing, nowS, id)
}

/** Soft-deletes a single row. Secret keychain entries of variables are purged after commit. */
export function softDeleteRow(env: RowEnv, type: SyncEntityType, id: string): void {
  const { db, nowS } = env
  if (type === 'collection_version') {
    db.prepare('UPDATE collection_versions SET deleted = 1 WHERE id = ?').run(id)
    return
  }
  if (type === 'environment_variable') {
    const row = loadRow(db, type, id)
    if (row?.secret_ref) {
      const ref = row.secret_ref as string
      env.effects.push(() => env.secrets.delete(ref))
    }
    db.prepare('UPDATE environment_variables SET deleted = 1, value = NULL, secret_ref = NULL, secret_missing = 0, version = version + 1, updated_at = ? WHERE id = ?').run(nowS, id)
    return
  }
  db.prepare(`UPDATE ${TABLE[type]} SET deleted = 1, version = version + 1, updated_at = ? WHERE id = ?`).run(nowS, id)
}

/** Restores a soft-deleted row from a payload. */
export function restoreFromPayload(env: RowEnv, type: SyncEntityType, id: string, p: Payload): void {
  const row = loadRow(env.db, type, id)
  if (row) overwriteFromPayload(env, type, row, p)
}

/** Current wire payload of a row (undefined when it does not exist). */
export function currentWire(db: Db, type: SyncEntityType, id: string): { row: AnyRow; wire: Payload } | undefined {
  const row = loadRow(db, type, id)
  return row ? { row, wire: toWire(type, row) } : undefined
}

/**
 * Whether the SERVER will cascade the delete of `container` onto this entity, judged by the last state the server
 * confirmed (`base_payload`), never by local structure: a child that was moved locally (not pushed yet) is still in its
 * old container on the server and needs its own delete.
 */
export function serverCascades(db: Db, container: EntityRef, child: EntityRef): boolean {
  const base = parsePayload(getEntity(db, child.type, child.id)?.base_payload ?? null)
  if (!base) return false
  if (container.type === 'collection') return base.collection_id === container.id
  if (container.type === 'environment') return base.environment_id === container.id
  // folder: walk the remote parent chain of the child's folder
  let cur = (child.type === 'folder' ? base.parent_folder_id : base.folder_id) as string | null | undefined
  for (let depth = 0; cur && depth < 1000; depth++) {
    if (cur === container.id) return true
    const parent = parsePayload(getEntity(db, 'folder', cur)?.base_payload ?? null)
    cur = (parent?.parent_folder_id as string | null | undefined) ?? null
  }
  return false
}

