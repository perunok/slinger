import type { Collection } from '../../shared/types'
import { newId } from '../lib/ids'
import { cleanName, nowSeconds } from '../lib/text'
import {
  cleanScriptsJson,
  requireCollection,
  requireWorkspace,
  toCollection,
  type CollectionRow,
  type Db,
} from './common'

export class CollectionRepository {
  constructor(private readonly db: Db) {}

  list(workspaceId: string): Collection[] {
    requireWorkspace(this.db, workspaceId)
    return (
      this.db
        .prepare('SELECT * FROM collections WHERE workspace_id = ? AND deleted = 0 ORDER BY id')
        .all(workspaceId.toLowerCase()) as CollectionRow[]
    ).map(toCollection)
  }

  get(id: string): Collection {
    return toCollection(requireCollection(this.db, id))
  }

  create(workspaceId: string, name: string): Collection {
    const ws = requireWorkspace(this.db, workspaceId)
    return this.insert(ws.id, cleanName(name, 'collection name'))
  }

  /** Inserts without validation; callers pass an already-verified workspace id and clean name. */
  insert(workspaceId: string, name: string): Collection {
    const id = newId()
    const now = nowSeconds()
    this.db
      .prepare(
        `INSERT INTO collections (id, workspace_id, name, version, deleted, created_at, updated_at)
         VALUES (?, ?, ?, 1, 0, ?, ?)`,
      )
      .run(id, workspaceId, name, now, now)
    return this.get(id)
  }

  rename(id: string, name: string): Collection {
    requireCollection(this.db, id)
    this.db
      .prepare('UPDATE collections SET name = ?, updated_at = ?, version = version + 1 WHERE id = ? AND deleted = 0')
      .run(cleanName(name, 'collection name'), nowSeconds(), id.toLowerCase())
    return this.get(id)
  }

  /** Replaces the collection-level scripts (local-only; refused on read-only cloud workspaces by a trigger). */
  setScripts(id: string, scriptsJson: string | null): Collection {
    const row = requireCollection(this.db, id)
    const clean = cleanScriptsJson(scriptsJson)
    this.db.prepare('UPDATE collections SET scripts_json = ?, updated_at = ? WHERE id = ? AND deleted = 0').run(clean, nowSeconds(), row.id)
    return this.get(row.id)
  }

  /** Soft-deletes the collection with its folders, requests and versions in one transaction. */
  softDelete(id: string): void {
    requireCollection(this.db, id)
    const cid = id.toLowerCase()
    const now = nowSeconds()
    this.db.transaction(() => {
      for (const table of ['collections', 'folders', 'requests']) {
        const col = table === 'collections' ? 'id' : 'collection_id'
        this.db
          .prepare(
            `UPDATE ${table} SET deleted = 1, updated_at = ?, version = version + 1 WHERE ${col} = ? AND deleted = 0`,
          )
          .run(now, cid)
      }
      this.db.prepare('UPDATE collection_versions SET deleted = 1 WHERE collection_id = ? AND deleted = 0').run(cid)
    })()
  }
}
