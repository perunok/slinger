/**
 * "Keep on this device": local changes the user holds back from the cloud (table `sync_kept`, migration 0015).
 *
 * A kept change stays in `sync_dirty` (it is still different from the cloud) but the push leaves it out, and so does the
 * pending count. What depends on a kept change is held back with it, or the cloud would get an incomplete picture:
 *  - an item inside a kept container that is not on the cloud (a new collection, folder or environment): its upload would
 *    point at a parent the cloud does not have;
 *  - the delete of an item the cloud removes together with a kept container delete (`serverCascades`).
 * Uploading again (`setKept(..., false)`) removes the rows; they then go up with the next sync like any change. A row
 * also ends when its entity stops being dirty (trigger `sync_kept_ends_with_dirty`), and on unlink (`detachSync`).
 */
import type { SyncEntityType } from '../../shared/types'
import type { Db } from '../db/database'
import { loadRow } from './mapping'
import { serverCascades } from './rows'
import { getEntity } from './store'

const key = (type: string, id: string) => `${type}:${id}`
const CONTAINERS: readonly SyncEntityType[] = ['collection', 'folder', 'environment']

/** Parents a row points at now (the same references `parentRefs` reads from a payload). */
function parentsNow(type: SyncEntityType, row: Record<string, unknown>): Array<{ type: SyncEntityType; id: string }> {
  const out: Array<{ type: SyncEntityType; id: string }> = []
  const add = (t: SyncEntityType, v: unknown) => {
    if (typeof v === 'string' && v) out.push({ type: t, id: v })
  }
  if (type === 'folder') {
    add('collection', row.collection_id)
    add('folder', row.parent_folder_id)
  } else if (type === 'request') {
    add('collection', row.collection_id)
    add('folder', row.folder_id)
  } else if (type === 'environment_variable') add('environment', row.environment_id)
  else if (type === 'collection_version' || type === 'collection_variable') add('collection', row.collection_id)
  return out
}

/**
 * Every waiting change that is held back: the kept ones (still waiting) plus what depends on them, as `type:id` keys.
 * Read only. Empty (and cheap) when nothing is kept.
 */
export function heldKeys(db: Db, workspaceId: string): Set<string> {
  const kept = db
    .prepare(
      `SELECT k.entity_type AS type, k.entity_id AS id FROM sync_kept k
       JOIN sync_dirty d ON d.entity_type = k.entity_type AND d.entity_id = k.entity_id
       WHERE k.workspace_id = ?`,
    )
    .all(workspaceId) as Array<{ type: SyncEntityType; id: string }>
  const held = new Set(kept.map((k) => key(k.type, k.id)))
  if (held.size === 0) return held
  const dirty = db.prepare('SELECT entity_type AS type, entity_id AS id FROM sync_dirty WHERE workspace_id = ?').all(workspaceId) as Array<{ type: SyncEntityType; id: string }>
  const rowOf = new Map<string, Record<string, unknown> | undefined>()
  const row = (t: SyncEntityType, id: string) => {
    const k = key(t, id)
    if (!rowOf.has(k)) rowOf.set(k, loadRow(db, t, id) as Record<string, unknown> | undefined)
    return rowOf.get(k)
  }
  const onCloud = (t: SyncEntityType, id: string) => (getEntity(db, t, id)?.remote_version ?? 0) > 0
  // Held container deletes the server would cascade from.
  const heldDeletes = () => dirty.filter((d) => held.has(key(d.type, d.id)) && CONTAINERS.includes(d.type) && row(d.type, d.id)?.deleted === 1 && onCloud(d.type, d.id))

  for (let changed = true; changed; ) {
    changed = false
    const containerDeletes = heldDeletes()
    for (const d of dirty) {
      const k = key(d.type, d.id)
      if (held.has(k)) continue
      const r = row(d.type, d.id)
      if (!r) continue
      const depends =
        r.deleted === 1
          ? containerDeletes.some((c) => serverCascades(db, c, d))
          : parentsNow(d.type, r).some((p) => held.has(key(p.type, p.id)) && !onCloud(p.type, p.id))
      if (depends) {
        held.add(k)
        changed = true
      }
    }
  }
  return held
}

/** Keeps (or uploads again) the chosen entities; only entities that are waiting to upload can be kept. Returns how many changed. */
export function setKept(db: Db, workspaceId: string, items: Array<{ type: SyncEntityType; id: string }>, kept: boolean, nowS: number): number {
  let n = 0
  const isDirty = db.prepare('SELECT 1 FROM sync_dirty WHERE workspace_id = ? AND entity_type = ? AND entity_id = ?')
  const insert = db.prepare('INSERT OR IGNORE INTO sync_kept (entity_type, entity_id, workspace_id, created_at) VALUES (?, ?, ?, ?)')
  const remove = db.prepare('DELETE FROM sync_kept WHERE workspace_id = ? AND entity_type = ? AND entity_id = ?')
  db.transaction(() => {
    for (const it of items) {
      if (kept) {
        if (isDirty.get(workspaceId, it.type, it.id)) n += insert.run(it.type, it.id, workspaceId, nowS).changes
      } else n += remove.run(workspaceId, it.type, it.id).changes
    }
  })()
  return n
}
