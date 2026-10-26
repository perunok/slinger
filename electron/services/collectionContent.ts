/**
 * Replaces a collection's folders and requests with new content IN PLACE (version restore "replace", Postman
 * re-import): rows that correspond to an item of the new content keep their id and are updated (or un-deleted),
 * only items without a counterpart get new ids, and live rows without one are soft-deleted. Keeping ids keeps
 * everything that points at a request working: workflow nodes (`requestId`), history entries, open tabs, synced
 * copies on other devices (they receive an update instead of a delete plus a create).
 *
 * Correspondence:
 * - `id` (version restore): the snapshot's own ids; a row matches when it has that id and belongs to this
 *   collection (live or soft-deleted). Snapshots imported from a file carry another collection's ids: no match.
 * - `path` (Postman re-import; Postman files carry no Slinger ids): a folder matches a live folder with the same name
 *   under the matched parent; a request matches a live request with the same name and method in the matched folder,
 *   else one with the same name. Equal names among siblings pair up in order.
 * Rows whose content does not change are not touched (no version bump, no sync traffic). Runs in the caller's
 * transaction.
 */
import type { Db } from '../db/database'
import { IpcError } from '../lib/errors'
import { newId } from '../lib/ids'
import type { CollectionRow, FolderRow as LiveFolderRow, RequestRow as LiveRequestRow } from '../repositories/common'

type FolderRow = LiveFolderRow & { deleted: number }
type RequestRow = LiveRequestRow & { deleted: number }

export interface FolderSpec {
  /** Identifies the folder inside the spec (snapshot id, or a temp id); requests and children refer to it. */
  key: string
  parentKey: string | null
  name: string
  sortOrder: number
  scriptsJson: string | null
  description: string | null
  descriptionType: string | null
  /** Folder auth (Postman `auth` JSON, container auth 0018); null = inherit. */
  authJson: string | null
}

export interface RequestSpec {
  /** Snapshot id (mode `id`); ignored in mode `path`. */
  key: string | null
  folderKey: string | null
  name: string
  method: string
  url: string
  documentJson: string
  sortOrder: number
}

export interface ReplaceResult {
  /** Spec folder key -> row id, in the order folders were written (parents first). */
  folderIds: Map<string, string>
  /** Row id of every spec request, in spec order. */
  requestIds: string[]
}

export function replaceCollectionContent(
  db: Db,
  collection: CollectionRow,
  spec: { folders: FolderSpec[]; requests: RequestSpec[] },
  match: 'id' | 'path',
  now: number,
): ReplaceResult {
  const existingFolders = db.prepare('SELECT * FROM folders WHERE collection_id = ?').all(collection.id) as FolderRow[]
  const existingRequests = db.prepare('SELECT * FROM requests WHERE collection_id = ?').all(collection.id) as RequestRow[]
  const folderById = new Map(existingFolders.map((f) => [f.id, f]))
  const requestById = new Map(existingRequests.map((r) => [r.id, r]))
  const bySibling = <T extends { sort_order: number; id: string }>(a: T, b: T) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const liveFolders = existingFolders.filter((f) => f.deleted === 0).sort(bySibling)
  const liveRequests = existingRequests.filter((r) => r.deleted === 0).sort(bySibling)

  const folderIds = new Map<string, string>()
  const usedFolders = new Set<string>()
  const usedRequests = new Set<string>()

  const insertFolder = db.prepare(
    `INSERT INTO folders (id, workspace_id, collection_id, parent_folder_id, name, sort_order, scripts_json, description, description_type,
       auth_json, version, deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
  )
  const updateFolder = db.prepare(
    `UPDATE folders SET parent_folder_id = ?, name = ?, sort_order = ?, scripts_json = ?, description = ?, description_type = ?, auth_json = ?,
       deleted = 0, version = version + 1, updated_at = ? WHERE id = ?`,
  )
  const findFolder = (f: FolderSpec, parentId: string | null): FolderRow | undefined => {
    if (match === 'id') {
      const row = folderById.get(f.key)
      return row && !usedFolders.has(row.id) ? row : undefined
    }
    return liveFolders.find((e) => !usedFolders.has(e.id) && e.parent_folder_id === parentId && e.name === f.name)
  }

  // Parents first, whatever order the spec has.
  const pending = [...spec.folders]
  while (pending.length) {
    const before = pending.length
    for (let i = 0; i < pending.length; i++) {
      const f = pending[i]!
      if (f.parentKey !== null && !folderIds.has(f.parentKey)) continue
      const parentId = f.parentKey === null ? null : folderIds.get(f.parentKey)!
      const row = findFolder(f, parentId)
      if (row) {
        usedFolders.add(row.id)
        const same = row.deleted === 0 && row.parent_folder_id === parentId && row.name === f.name && row.sort_order === f.sortOrder &&
          row.scripts_json === f.scriptsJson && row.description === f.description && row.description_type === f.descriptionType &&
          (row.auth_json ?? null) === f.authJson
        if (!same) updateFolder.run(parentId, f.name, f.sortOrder, f.scriptsJson, f.description, f.descriptionType, f.authJson, now, row.id)
        folderIds.set(f.key, row.id)
      } else {
        const id = newId()
        insertFolder.run(id, collection.workspace_id, collection.id, parentId, f.name, f.sortOrder, f.scriptsJson, f.description, f.descriptionType, f.authJson,
          now, now)
        folderIds.set(f.key, id)
      }
      pending.splice(i, 1)
      i--
    }
    if (pending.length === before) throw new IpcError({ code: 'internal_error', message: 'the collection content has an invalid folder tree' })
  }

  const insertRequest = db.prepare(
    `INSERT INTO requests (id, workspace_id, collection_id, folder_id, name, method, url, document_json,
       sort_order, version, deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
  )
  const updateRequest = db.prepare(
    `UPDATE requests SET folder_id = ?, name = ?, method = ?, url = ?, document_json = ?, sort_order = ?, deleted = 0,
       version = version + 1, updated_at = ? WHERE id = ?`,
  )
  const folderOf = (r: RequestSpec): string | null => {
    if (r.folderKey === null) return null
    const id = folderIds.get(r.folderKey)
    if (!id) throw new IpcError({ code: 'internal_error', message: 'the collection content references a missing folder' })
    return id
  }
  // Matching first (two passes in `path` mode: name + method, then name alone), writing after.
  const matched: Array<RequestRow | undefined> = spec.requests.map(() => undefined)
  if (match === 'id') {
    spec.requests.forEach((r, i) => {
      const row = r.key ? requestById.get(r.key) : undefined
      if (row && !usedRequests.has(row.id)) {
        usedRequests.add(row.id)
        matched[i] = row
      }
    })
  } else {
    for (const strict of [true, false]) {
      spec.requests.forEach((r, i) => {
        if (matched[i]) return
        const folderId = folderOf(r)
        const row = liveRequests.find((e) => !usedRequests.has(e.id) && e.folder_id === folderId && e.name === r.name && (!strict || e.method === r.method))
        if (row) {
          usedRequests.add(row.id)
          matched[i] = row
        }
      })
    }
  }
  const requestIds = spec.requests.map((r, i) => {
    const folderId = folderOf(r)
    const row = matched[i]
    if (row) {
      const same = row.deleted === 0 && row.folder_id === folderId && row.name === r.name && row.method === r.method && row.url === r.url &&
        row.document_json === r.documentJson && row.sort_order === r.sortOrder
      if (!same) updateRequest.run(folderId, r.name, r.method, r.url, r.documentJson, r.sortOrder, now, row.id)
      return row.id
    }
    const id = newId()
    insertRequest.run(id, collection.workspace_id, collection.id, folderId, r.name, r.method, r.url, r.documentJson, r.sortOrder, now, now)
    return id
  })

  // Whatever has no counterpart in the new content goes (soft delete, as everywhere).
  const softDelete = (table: 'requests' | 'folders', id: string) =>
    db.prepare(`UPDATE ${table} SET deleted = 1, updated_at = ?, version = version + 1 WHERE id = ? AND deleted = 0`).run(now, id)
  for (const r of liveRequests) if (!usedRequests.has(r.id)) softDelete('requests', r.id)
  for (const f of liveFolders) if (!usedFolders.has(f.id)) softDelete('folders', f.id)
  return { folderIds, requestIds }
}
