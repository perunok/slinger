/**
 * "Extract to new collection": a folder becomes a collection of its own, in one transaction.
 *
 * Cloud sync cannot move a folder between collections (the server refuses it), but it can move a request. So the new
 * collection gets fresh folders mirroring the subfolders (names, order, scripts, docs), the requests move into them
 * with their ids (history, examples and docs stay theirs), and the emptied folder tree is soft-deleted. The sync outbox
 * pushes upserts before deletes (outbox.ts orderOps), so the moved requests are never part of the server's cascade.
 *
 * The folder's own scripts and documentation become the collection's; the caller may pass merged scripts instead
 * (the original collection's and parent folders' scripts that used to run before it). Collection variables of the
 * original collection can be copied.
 */
import type { Collection, ExtractFolderInput, ExtractFolderResult } from '../../shared/types'
import { newId } from '../lib/ids'
import { cleanName, nowSeconds } from '../lib/text'
import { cleanScriptsJson, requireCollection, requireFolder, toCollection, type Db, type FolderRow } from '../repositories/common'

export function extractFolderToCollection(db: Db, input: ExtractFolderInput): ExtractFolderResult {
  const root = requireFolder(db, input.folderId)
  const source = requireCollection(db, root.collection_id)
  const name = cleanName(input.name, 'collection name')
  // undefined: the folder's own scripts; null or a JSON event array: exactly that.
  const scriptsJson = input.scriptsJson === undefined ? (root.scripts_json ?? null) : cleanScriptsJson(input.scriptsJson)
  const now = nowSeconds()
  const collectionId = newId()
  let folderCount = 0
  let requestCount = 0
  let variableCount = 0

  db.transaction(() => {
    db.prepare(
      `INSERT INTO collections (id, workspace_id, name, scripts_json, description, description_type, version, deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
    ).run(collectionId, root.workspace_id, name, scriptsJson, root.description ?? null, root.description_type ?? null, now, now)

    // Subfolders, parents first, recreated under the new collection.
    const descendants = db
      .prepare(
        `WITH RECURSIVE tree(id, depth) AS (
           SELECT id, 0 FROM folders WHERE parent_folder_id = ? AND deleted = 0
           UNION ALL
           SELECT f.id, t.depth + 1 FROM folders f JOIN tree t ON f.parent_folder_id = t.id WHERE f.deleted = 0
         )
         SELECT folders.* FROM tree JOIN folders ON folders.id = tree.id ORDER BY tree.depth, folders.sort_order, folders.id`,
      )
      .all(root.id) as FolderRow[]
    const newIdOf = new Map<string, string | null>([[root.id, null]])
    const insertFolder = db.prepare(
      `INSERT INTO folders (id, workspace_id, collection_id, parent_folder_id, name, sort_order, scripts_json, description, description_type,
         version, deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
    )
    for (const f of descendants) {
      const id = newId()
      insertFolder.run(id, f.workspace_id, collectionId, newIdOf.get(f.parent_folder_id!) ?? null, f.name, f.sort_order, f.scripts_json ?? null, f.description ?? null, f.description_type ?? null, now, now)
      newIdOf.set(f.id, id)
    }
    folderCount = descendants.length

    // Requests move (same ids and order) into the mirrored folders.
    const moveRequest = db.prepare('UPDATE requests SET collection_id = ?, folder_id = ?, updated_at = ?, version = version + 1 WHERE id = ?')
    const oldFolders = [root.id, ...descendants.map((f) => f.id)]
    const requestsIn = db.prepare('SELECT id FROM requests WHERE folder_id = ? AND deleted = 0')
    for (const fid of oldFolders) {
      for (const r of requestsIn.all(fid) as Array<{ id: string }>) {
        moveRequest.run(collectionId, newIdOf.get(fid) ?? null, now, r.id)
        requestCount++
      }
    }

    // The emptied tree goes (it holds no live requests any more).
    const markFolder = db.prepare('UPDATE folders SET deleted = 1, updated_at = ?, version = version + 1 WHERE id = ? AND deleted = 0')
    for (const fid of oldFolders) markFolder.run(now, fid)

    if (input.copyCollectionVariables) {
      const vars = db
        .prepare('SELECT key, value, enabled, description, sort_order FROM collection_variables WHERE collection_id = ? AND deleted = 0 ORDER BY sort_order, key')
        .all(source.id) as Array<{ key: string; value: string; enabled: number; description: string | null; sort_order: number }>
      const insertVar = db.prepare(
        `INSERT INTO collection_variables (id, workspace_id, collection_id, key, value, enabled, description, sort_order, version, deleted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
      )
      for (const v of vars) insertVar.run(newId(), root.workspace_id, collectionId, v.key, v.value, v.enabled, v.description, v.sort_order, now, now)
      variableCount = vars.length
    }
  })()

  const collection: Collection = toCollection(requireCollection(db, collectionId))
  return { collection, sourceCollectionId: source.id, folderCount, requestCount, variableCount }
}
