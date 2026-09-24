/** Small SQL helpers over the sync bookkeeping tables (migration 0004). */
import type { SyncEntityType } from '../../shared/types'
import type { Db } from '../db/database'
import type { EntityState, LinkRow } from './types'

export function getLink(db: Db, workspaceId: string): LinkRow | undefined {
  return db.prepare('SELECT * FROM cloud_links WHERE workspace_id = ?').get(workspaceId) as LinkRow | undefined
}

export function listLinks(db: Db): LinkRow[] {
  return db
    .prepare(
      `SELECT l.* FROM cloud_links l JOIN workspaces w ON w.id = l.workspace_id WHERE w.deleted = 0 ORDER BY l.created_at, l.workspace_id`,
    )
    .all() as LinkRow[]
}

export function updateLink(db: Db, workspaceId: string, fields: Partial<Omit<LinkRow, 'workspace_id'>>): void {
  const keys = Object.keys(fields)
  if (!keys.length) return
  const set = keys.map((k) => `${k} = @${k}`).join(', ')
  db.prepare(`UPDATE cloud_links SET ${set} WHERE workspace_id = @workspace_id`).run({
    ...fields,
    workspace_id: workspaceId,
  })
}

export function getEntity(db: Db, type: SyncEntityType, id: string): EntityState | undefined {
  return db.prepare('SELECT * FROM sync_entities WHERE entity_type = ? AND entity_id = ?').get(type, id) as
    | EntityState
    | undefined
}

export interface EntityWrite {
  remote_version: number
  base_payload: string | null
  remote_deleted?: 0 | 1
  state?: 'synced' | 'conflict'
}

/** Insert or replace the bookkeeping row of an entity. `state`/`remote_deleted` default to synced/0. */
export function putEntity(db: Db, type: SyncEntityType, id: string, workspaceId: string, w: EntityWrite): void {
  db.prepare(
    `INSERT INTO sync_entities (entity_type, entity_id, workspace_id, remote_version, base_payload, remote_deleted, state)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (entity_type, entity_id) DO UPDATE SET workspace_id = excluded.workspace_id,
       remote_version = excluded.remote_version, base_payload = excluded.base_payload,
       remote_deleted = excluded.remote_deleted, state = excluded.state`,
  ).run(type, id, workspaceId, w.remote_version, w.base_payload, w.remote_deleted ?? 0, w.state ?? 'synced')
}

export function setEntityState(db: Db, type: SyncEntityType, id: string, state: 'synced' | 'conflict'): void {
  db.prepare('UPDATE sync_entities SET state = ? WHERE entity_type = ? AND entity_id = ?').run(state, type, id)
}

/** Same statement the capture triggers run; used by the engine (triggers are suppressed while it applies). */
export function markDirty(db: Db, type: SyncEntityType, id: string, workspaceId: string): void {
  db.prepare(
    `INSERT INTO sync_dirty (entity_type, entity_id, workspace_id, change_seq) VALUES (?, ?, ?, 1)
     ON CONFLICT (entity_type, entity_id) DO UPDATE SET change_seq = change_seq + 1, op_id = NULL`,
  ).run(type, id, workspaceId)
}

export function clearDirty(db: Db, type: SyncEntityType, id: string): void {
  db.prepare('DELETE FROM sync_dirty WHERE entity_type = ? AND entity_id = ?').run(type, id)
}

export function isDirty(db: Db, type: SyncEntityType, id: string): boolean {
  return db.prepare('SELECT 1 FROM sync_dirty WHERE entity_type = ? AND entity_id = ?').get(type, id) !== undefined
}

export function dirtyCount(db: Db, workspaceId: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM sync_dirty WHERE workspace_id = ?').get(workspaceId) as { n: number }).n
}

export function hasDirty(db: Db, workspaceId: string): boolean {
  return db.prepare('SELECT 1 FROM sync_dirty WHERE workspace_id = ? LIMIT 1').get(workspaceId) !== undefined
}

export function openConflictCount(db: Db, workspaceId: string): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM sync_conflicts WHERE workspace_id = ? AND status = 'open'").get(workspaceId) as {
      n: number
    }
  ).n
}

/**
 * Runs `fn` in ONE transaction with `sync_control.applying = 1`, so the capture/read-only triggers ignore
 * everything the engine writes. Foreign keys are checked at commit (children may be written before parents).
 * A throw rolls everything back, including the flag.
 */
export function applyTx<T>(db: Db, fn: () => T): T {
  return db.transaction(() => {
    db.pragma('defer_foreign_keys = ON')
    db.prepare('UPDATE sync_control SET applying = 1').run()
    try {
      return fn()
    } finally {
      db.prepare('UPDATE sync_control SET applying = 0').run()
    }
  })()
}

export function getSetting(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}
export function setSetting(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value)
}
export function deleteSetting(db: Db, key: string): void {
  db.prepare('DELETE FROM app_settings WHERE key = ?').run(key)
}
