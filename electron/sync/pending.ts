/**
 * What is really waiting to be uploaded: the number behind the sync chip's "N pending" and the "Waiting to upload" list.
 *
 * `sync_dirty` holds every entity touched since it was last confirmed, but the push (`outbox.buildOps`) sends fewer
 * operations than that: it drops an item created and deleted before it ever reached the cloud, an edit that was changed
 * back to what the cloud has, and the deletes of children the server removes together with their container. Counting raw
 * dirty rows therefore overcounted (a collection added and deleted again still counted, deleting a collection counted all
 * its requests, and the number only came down after the next sync, never with auto sync off). This module applies the same
 * rules WITHOUT touching anything (no clearing, no quarantine, no op ids), so the badge follows the user's edits at once.
 *
 * Rules (the same as buildOps):
 *  - types the server does not support yet (feature off), rows that no longer exist: not pending;
 *  - frozen by an open conflict: not pending (it is shown as a conflict);
 *  - deleted locally and never on the cloud (`remote_version` 0): not pending; deleted and on the cloud: a delete;
 *  - not on the cloud: created; on the cloud and different from the cloud's copy: updated; equal to it: not pending;
 *  - a delete whose container (collection, folder, environment) delete is pending too: not pending (the server cascades;
 *    judged by the cloud's last copy of the child like `serverCascades`, so a child moved before syncing still counts).
 * The only shortcut: edits are compared with the cloud's copy (which needs the whole row) for at most REVERT_CHECK_LIMIT
 * items; beyond that they all count as pending (the push then drops the unchanged ones).
 */
import type { SyncEntityType } from '../../shared/types'
import type { Db } from '../db/database'
import { linkFeatures } from './features'
import { loadRow, parsePayload, samePayload, TABLE, toWire, typeSynced } from './mapping'

export interface PendingOp {
  type: SyncEntityType
  id: string
  kind: 'created' | 'updated' | 'deleted'
}

const REVERT_CHECK_LIMIT = 100

interface Row {
  id: string
  deleted: number
  rv: number
  state: string
  /** JSON array [collection_id, folder_id, parent_folder_id, environment_id] of the cloud's copy; only for deletes the cloud knows. */
  bp: string | null
}

const TYPES = Object.keys(TABLE) as SyncEntityType[]
const CONTAINER_TYPES: readonly SyncEntityType[] = ['collection', 'folder', 'environment']

export function pendingOps(db: Db, workspaceId: string): PendingOp[] {
  const features = linkFeatures(db, workspaceId)
  const rowsOf = new Map<SyncEntityType, Row[]>()
  for (const type of TYPES) {
    if (!typeSynced(type, features)) continue
    // INNER JOIN: a dirty entry whose row is gone is dropped by the push as well. No payload is read for live rows.
    const rows = db
      .prepare(
        `SELECT d.entity_id AS id, t.deleted AS deleted, COALESCE(e.remote_version, 0) AS rv, COALESCE(e.state, 'synced') AS state,
                CASE WHEN t.deleted = 1 AND COALESCE(e.remote_version, 0) > 0
                     THEN json_extract(e.base_payload, '$.collection_id', '$.folder_id', '$.parent_folder_id', '$.environment_id') END AS bp
         FROM sync_dirty d
         JOIN ${TABLE[type]} t ON t.id = d.entity_id
         LEFT JOIN sync_entities e ON e.entity_type = d.entity_type AND e.entity_id = d.entity_id
         WHERE d.workspace_id = ? AND d.entity_type = ?`,
      )
      .all(workspaceId, type) as Row[]
    const live = rows.filter((r) => r.state !== 'conflict')
    if (live.length) rowsOf.set(type, live)
  }

  // Containers whose delete is pending (deleted here and known to the cloud), with where the cloud has each folder.
  const goneCollection = new Set<string>()
  const goneEnvironment = new Set<string>()
  const goneFolder = new Set<string>()
  const cloudParent = new Map<string, string | null>()
  for (const type of CONTAINER_TYPES) {
    for (const r of rowsOf.get(type) ?? []) {
      if (r.deleted !== 1 || r.rv === 0) continue
      if (type === 'collection') goneCollection.add(r.id)
      else if (type === 'environment') goneEnvironment.add(r.id)
      else {
        goneFolder.add(r.id)
        cloudParent.set(r.id, place(r.bp).parentFolderId)
      }
    }
  }
  /** The cloud's parent folder of a folder (from this run, else its stored copy). */
  const parentFolderOnCloud = (folderId: string): string | null => {
    if (cloudParent.has(folderId)) return cloudParent.get(folderId)!
    const row = db.prepare("SELECT json_extract(base_payload, '$.parent_folder_id') AS p FROM sync_entities WHERE entity_type = 'folder' AND entity_id = ?").get(folderId) as { p: string | null } | undefined
    const p = row?.p ?? null
    cloudParent.set(folderId, p)
    return p
  }

  /** Does the server delete this entity together with a container whose delete is pending? (same rule as serverCascades) */
  const covered = (type: SyncEntityType, r: Row): boolean => {
    if (!r.bp) return false
    const p = place(r.bp)
    if (p.collectionId && goneCollection.has(p.collectionId) && type !== 'collection' && type !== 'environment' && type !== 'environment_variable') return true
    if (type === 'environment_variable') return !!p.environmentId && goneEnvironment.has(p.environmentId)
    if (type === 'folder' || type === 'request') {
      let cur = type === 'folder' ? p.parentFolderId : p.folderId
      for (let depth = 0; cur && depth < 1000; depth++) {
        if (goneFolder.has(cur)) return true
        cur = parentFolderOnCloud(cur)
      }
    }
    return false
  }

  const out: PendingOp[] = []
  const edits: Array<{ type: SyncEntityType; id: string }> = []
  for (const [type, rows] of rowsOf) {
    for (const r of rows) {
      if (r.deleted === 1) {
        if (r.rv === 0) continue // created and deleted before it ever reached the cloud
        if (covered(type, r)) continue
        out.push({ type, id: r.id, kind: 'deleted' })
      } else if (r.rv === 0) {
        out.push({ type, id: r.id, kind: 'created' })
      } else {
        edits.push({ type, id: r.id })
      }
    }
  }

  // Edits: not pending when the row is back to what the cloud has (compared like buildOps does).
  const compare = edits.length <= REVERT_CHECK_LIMIT
  for (const e of edits) {
    if (compare) {
      const row = loadRow(db, e.type, e.id)
      const base = parsePayload(
        (db.prepare('SELECT base_payload FROM sync_entities WHERE entity_type = ? AND entity_id = ?').get(e.type, e.id) as { base_payload: string | null } | undefined)
          ?.base_payload ?? null,
      )
      if (row && base && samePayload(toWire(e.type, row, features), base)) continue
    }
    out.push({ type: e.type, id: e.id, kind: 'updated' })
  }
  return out
}

export function pendingCount(db: Db, workspaceId: string): number {
  return pendingOps(db, workspaceId).length
}

function place(bp: string | null): { collectionId: string | null; folderId: string | null; parentFolderId: string | null; environmentId: string | null } {
  let a: unknown[] = []
  try {
    a = bp ? (JSON.parse(bp) as unknown[]) : []
  } catch {
    /* no usable copy: nothing is covered */
  }
  const s = (v: unknown) => (typeof v === 'string' ? v : null)
  return { collectionId: s(a[0]), folderId: s(a[1]), parentFolderId: s(a[2]), environmentId: s(a[3]) }
}
