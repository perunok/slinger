import type {
  ApiFolder,
  ApiRequest,
  CreateFolderInput,
  CreateRequestInput,
  MoveFolderInput,
  MoveRequestInput,
  UpdateRequestInput,
} from '../../shared/types'
import { invalidInput, notFound, versionConflict } from '../lib/errors'
import { assertUuid, newId } from '../lib/ids'
import { cleanMethod, cleanName, nowSeconds } from '../lib/text'
import {
  MAX_DOCUMENT_JSON_BYTES,
  nextSortOrder,
  requireCollection,
  requireFolder,
  requireRequest,
  toFolder,
  toRequest,
  type Db,
  type FolderRow,
  type RequestRow,
} from './common'

function assertDocumentJson(value: unknown): string {
  if (typeof value !== 'string') throw invalidInput('documentJson must be a string')
  if (Buffer.byteLength(value, 'utf8') > MAX_DOCUMENT_JSON_BYTES) throw invalidInput('documentJson is too large')
  try {
    JSON.parse(value)
  } catch {
    throw invalidInput('documentJson must be valid JSON')
  }
  return value
}

function assertUrl(value: unknown): string {
  if (typeof value !== 'string') throw invalidInput('url must be a string')
  if (value.length > 100_000) throw invalidInput('url is too long')
  return value
}

function assertIndex(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalidInput('targetIndex must be a non-negative integer')
  }
  return value
}

/**
 * Rewrites sort_order of a container's live children so that `movedId` sits at `index`
 * (clamped). Only rows whose position actually changes are written, and only the moved row
 * gets a version bump, so reordering never invalidates other clients' expectedVersion.
 */
function placeAt(
  db: Db,
  table: 'folders' | 'requests',
  collectionId: string,
  containerId: string | null,
  movedId: string,
  index: number,
): void {
  const col = table === 'folders' ? 'parent_folder_id' : 'folder_id'
  const siblings = (
    db
      .prepare(
        `SELECT id, sort_order FROM ${table}
         WHERE collection_id = ? AND ${col} IS ? AND deleted = 0 AND id != ?
         ORDER BY sort_order, id`,
      )
      .all(collectionId, containerId, movedId) as Array<{ id: string; sort_order: number }>
  ).map((r) => r.id)
  siblings.splice(Math.min(index, siblings.length), 0, movedId)
  const current = new Map(
    (
      db
        .prepare(`SELECT id, sort_order FROM ${table} WHERE collection_id = ? AND ${col} IS ? AND deleted = 0`)
        .all(collectionId, containerId) as Array<{ id: string; sort_order: number }>
    ).map((r) => [r.id, r.sort_order]),
  )
  const update = db.prepare(`UPDATE ${table} SET sort_order = ? WHERE id = ?`)
  siblings.forEach((id, position) => {
    if (current.get(id) !== position) update.run(position, id)
  })
}

export class FolderRepository {
  constructor(private readonly db: Db) {}

  list(collectionId: string): ApiFolder[] {
    requireCollection(this.db, collectionId)
    return (
      this.db
        .prepare(
          `SELECT * FROM folders WHERE collection_id = ? AND deleted = 0
           ORDER BY sort_order, id`,
        )
        .all(collectionId.toLowerCase()) as FolderRow[]
    ).map(toFolder)
  }

  get(id: string): ApiFolder {
    return toFolder(requireFolder(this.db, id))
  }

  create(input: CreateFolderInput): ApiFolder {
    const workspaceId = assertUuid(input.workspaceId, 'workspaceId')
    const collection = requireCollection(this.db, input.collectionId)
    if (collection.workspace_id !== workspaceId) throw invalidInput('collection does not belong to workspace')
    const name = cleanName(input.name, 'folder name')
    const parentId = input.parentFolderId == null ? null : assertUuid(input.parentFolderId, 'parentFolderId')
    if (parentId) {
      const parent = requireFolder(this.db, parentId)
      if (parent.collection_id !== collection.id) throw invalidInput('parent folder is in a different collection')
    }
    const id = newId()
    const now = nowSeconds()
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO folders (id, workspace_id, collection_id, parent_folder_id, name, sort_order,
             version, deleted, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
        )
        .run(id, workspaceId, collection.id, parentId, name, nextSortOrder(this.db, 'folders', collection.id, parentId), now, now)
    })()
    return this.get(id)
  }

  rename(id: string, name: string): ApiFolder {
    requireFolder(this.db, id)
    this.db
      .prepare('UPDATE folders SET name = ?, updated_at = ?, version = version + 1 WHERE id = ? AND deleted = 0')
      .run(cleanName(name, 'folder name'), nowSeconds(), id.toLowerCase())
    return this.get(id)
  }

  /** Moves within the same collection. Rejects moving a folder into itself or its own descendants. */
  move(input: MoveFolderInput): ApiFolder {
    const folder = requireFolder(this.db, input.folderId)
    const index = assertIndex(input.targetIndex)
    const targetParent = input.targetParentFolderId == null ? null : assertUuid(input.targetParentFolderId, 'targetParentFolderId')
    if (targetParent) {
      const parent = requireFolder(this.db, targetParent)
      if (parent.collection_id !== folder.collection_id) {
        throw invalidInput('cannot move a folder into a different collection')
      }
      const cycle = this.db
        .prepare(
          `WITH RECURSIVE ancestors(id, parent) AS (
             SELECT id, parent_folder_id FROM folders WHERE id = ?
             UNION
             SELECT f.id, f.parent_folder_id FROM folders f JOIN ancestors a ON f.id = a.parent
           )
           SELECT 1 FROM ancestors WHERE id = ?`,
        )
        .get(targetParent, folder.id)
      if (cycle) throw invalidInput('cannot move a folder into itself or one of its descendants', { code: 'folder_cycle' })
    }
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE folders SET parent_folder_id = ?, updated_at = ?, version = version + 1 WHERE id = ?')
        .run(targetParent, nowSeconds(), folder.id)
      placeAt(this.db, 'folders', folder.collection_id, targetParent, folder.id, index)
    })()
    return this.get(folder.id)
  }

  /** Soft-deletes the folder, every descendant folder, and all requests inside them. */
  softDelete(id: string): void {
    const folder = requireFolder(this.db, id)
    const now = nowSeconds()
    this.db.transaction(() => {
      const ids = (
        this.db
          .prepare(
            `WITH RECURSIVE tree(id) AS (
               SELECT id FROM folders WHERE id = ? AND deleted = 0
               UNION
               SELECT f.id FROM folders f JOIN tree t ON f.parent_folder_id = t.id WHERE f.deleted = 0
             ) SELECT id FROM tree`,
          )
          .all(folder.id) as Array<{ id: string }>
      ).map((r) => r.id)
      const markFolder = this.db.prepare(
        'UPDATE folders SET deleted = 1, updated_at = ?, version = version + 1 WHERE id = ? AND deleted = 0',
      )
      const markRequests = this.db.prepare(
        'UPDATE requests SET deleted = 1, updated_at = ?, version = version + 1 WHERE folder_id = ? AND deleted = 0',
      )
      for (const fid of ids) {
        markFolder.run(now, fid)
        markRequests.run(now, fid)
      }
    })()
  }
}

export class RequestRepository {
  constructor(private readonly db: Db) {}

  list(collectionId: string): ApiRequest[] {
    requireCollection(this.db, collectionId)
    return (
      this.db
        .prepare(
          `SELECT * FROM requests WHERE collection_id = ? AND deleted = 0
           ORDER BY sort_order, id`,
        )
        .all(collectionId.toLowerCase()) as RequestRow[]
    ).map(toRequest)
  }

  get(id: string): ApiRequest {
    return toRequest(requireRequest(this.db, id))
  }

  create(input: CreateRequestInput): ApiRequest {
    const workspaceId = assertUuid(input.workspaceId, 'workspaceId')
    const collection = requireCollection(this.db, input.collectionId)
    if (collection.workspace_id !== workspaceId) throw invalidInput('collection does not belong to workspace')
    const name = cleanName(input.name, 'request name', 500)
    const method = cleanMethod(input.method)
    const url = assertUrl(input.url)
    const documentJson = assertDocumentJson(input.documentJson)
    const folderId = input.folderId == null ? null : assertUuid(input.folderId, 'folderId')
    if (folderId) {
      const folder = requireFolder(this.db, folderId)
      if (folder.collection_id !== collection.id) throw invalidInput('folder is in a different collection')
    }
    const id = newId()
    const now = nowSeconds()
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO requests (id, workspace_id, collection_id, folder_id, name, method, url, document_json,
             sort_order, version, deleted, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
        )
        .run(id, workspaceId, collection.id, folderId, name, method, url, documentJson,
          nextSortOrder(this.db, 'requests', collection.id, folderId), now, now)
    })()
    return this.get(id)
  }

  /** Optimistic-concurrency update: fails with version_conflict unless expectedVersion is current. */
  update(input: UpdateRequestInput): ApiRequest {
    const id = assertUuid(input.requestId, 'requestId')
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw invalidInput('expectedVersion must be a positive integer')
    }
    const name = cleanName(input.name, 'request name', 500)
    const method = cleanMethod(input.method)
    const url = assertUrl(input.url)
    const documentJson = assertDocumentJson(input.documentJson)
    const result = this.db
      .prepare(
        `UPDATE requests SET name = ?, method = ?, url = ?, document_json = ?, updated_at = ?, version = version + 1
         WHERE id = ? AND version = ? AND deleted = 0`,
      )
      .run(name, method, url, documentJson, nowSeconds(), id, input.expectedVersion)
    if (result.changes === 0) {
      const current = this.db.prepare('SELECT version FROM requests WHERE id = ? AND deleted = 0').get(id) as
        | { version: number }
        | undefined
      if (!current) throw notFound('request')
      throw versionConflict('request was modified elsewhere; reload and retry', {
        expectedVersion: input.expectedVersion,
        currentVersion: current.version,
      })
    }
    return this.get(id)
  }

  rename(id: string, name: string): ApiRequest {
    requireRequest(this.db, id)
    this.db
      .prepare('UPDATE requests SET name = ?, updated_at = ?, version = version + 1 WHERE id = ? AND deleted = 0')
      .run(cleanName(name, 'request name', 500), nowSeconds(), id.toLowerCase())
    return this.get(id)
  }

  /** Move (and reorder) a request, possibly into another collection of the same workspace. */
  move(input: MoveRequestInput): ApiRequest {
    const request = requireRequest(this.db, input.requestId)
    const index = assertIndex(input.targetIndex)
    const target = requireCollection(this.db, input.targetCollectionId)
    if (target.workspace_id !== request.workspace_id) throw invalidInput('cannot move a request between workspaces')
    const folderId = input.targetFolderId == null ? null : assertUuid(input.targetFolderId, 'targetFolderId')
    if (folderId) {
      const folder = requireFolder(this.db, folderId)
      if (folder.collection_id !== target.id) throw invalidInput('target folder is in a different collection')
    }
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE requests SET collection_id = ?, folder_id = ?, updated_at = ?, version = version + 1 WHERE id = ?')
        .run(target.id, folderId, nowSeconds(), request.id)
      placeAt(this.db, 'requests', target.id, folderId, request.id, index)
    })()
    return this.get(request.id)
  }

  softDelete(id: string): void {
    const request = requireRequest(this.db, id)
    this.db
      .prepare('UPDATE requests SET deleted = 1, updated_at = ?, version = version + 1 WHERE id = ?')
      .run(nowSeconds(), request.id)
  }
}
