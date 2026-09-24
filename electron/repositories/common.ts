import type { ApiFolder, ApiRequest, Collection, Environment, Workspace } from '../../shared/types'
import type { Db } from '../db/database'
import { notFound } from '../lib/errors'
import { assertUuid } from '../lib/ids'

export type { Db }

export interface WorkspaceRow {
  id: string
  name: string
  workspace_type: string
  version: number
  created_at: number
  updated_at: number
}
export interface CollectionRow {
  id: string
  workspace_id: string
  name: string
  version: number
  created_at: number
  updated_at: number
}
export interface FolderRow {
  id: string
  workspace_id: string
  collection_id: string
  parent_folder_id: string | null
  name: string
  sort_order: number
  version: number
  created_at: number
  updated_at: number
}
export interface RequestRow {
  id: string
  workspace_id: string
  collection_id: string
  folder_id: string | null
  name: string
  method: string
  url: string
  document_json: string
  sort_order: number
  version: number
  created_at: number
  updated_at: number
}
export interface EnvironmentRow {
  id: string
  workspace_id: string
  name: string
  version: number
  created_at: number
  updated_at: number
}

export const toWorkspace = (r: WorkspaceRow): Workspace => ({
  id: r.id,
  name: r.name,
  workspaceType: r.workspace_type === 'team' ? 'team' : 'personal',
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  version: r.version,
})
export const toCollection = (r: CollectionRow): Collection => ({
  id: r.id,
  workspaceId: r.workspace_id,
  name: r.name,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  version: r.version,
})
export const toFolder = (r: FolderRow): ApiFolder => ({
  id: r.id,
  workspaceId: r.workspace_id,
  collectionId: r.collection_id,
  parentFolderId: r.parent_folder_id,
  name: r.name,
  sortOrder: r.sort_order,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  version: r.version,
})
export const toRequest = (r: RequestRow): ApiRequest => ({
  id: r.id,
  workspaceId: r.workspace_id,
  collectionId: r.collection_id,
  folderId: r.folder_id,
  name: r.name,
  method: r.method,
  url: r.url,
  documentJson: r.document_json,
  sortOrder: r.sort_order,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  version: r.version,
})
export const toEnvironment = (r: EnvironmentRow): Environment => ({
  id: r.id,
  workspaceId: r.workspace_id,
  name: r.name,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  version: r.version,
})

/** Loaders that enforce both UUID validity and `deleted = 0`. */
export function requireWorkspace(db: Db, id: string): WorkspaceRow {
  const row = db
    .prepare('SELECT * FROM workspaces WHERE id = ? AND deleted = 0')
    .get(assertUuid(id, 'workspaceId')) as WorkspaceRow | undefined
  if (!row) throw notFound('workspace')
  return row
}
export function requireCollection(db: Db, id: string): CollectionRow {
  const row = db
    .prepare(
      `SELECT c.* FROM collections c JOIN workspaces w ON w.id = c.workspace_id
       WHERE c.id = ? AND c.deleted = 0 AND w.deleted = 0`,
    )
    .get(assertUuid(id, 'collectionId')) as CollectionRow | undefined
  if (!row) throw notFound('collection')
  return row
}
export function requireFolder(db: Db, id: string): FolderRow {
  const row = db
    .prepare('SELECT * FROM folders WHERE id = ? AND deleted = 0')
    .get(assertUuid(id, 'folderId')) as FolderRow | undefined
  if (!row) throw notFound('folder')
  return row
}
export function requireRequest(db: Db, id: string): RequestRow {
  const row = db
    .prepare('SELECT * FROM requests WHERE id = ? AND deleted = 0')
    .get(assertUuid(id, 'requestId')) as RequestRow | undefined
  if (!row) throw notFound('request')
  return row
}
export function requireEnvironment(db: Db, id: string): EnvironmentRow {
  const row = db
    .prepare(
      `SELECT e.* FROM environments e JOIN workspaces w ON w.id = e.workspace_id
       WHERE e.id = ? AND e.deleted = 0 AND w.deleted = 0`,
    )
    .get(assertUuid(id, 'environmentId')) as EnvironmentRow | undefined
  if (!row) throw notFound('environment')
  return row
}

/** Appends after the last sibling. `folderCol` is folder_id/parent_folder_id. */
export function nextSortOrder(
  db: Db,
  table: 'folders' | 'requests',
  collectionId: string,
  containerId: string | null,
): number {
  const col = table === 'folders' ? 'parent_folder_id' : 'folder_id'
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM ${table}
       WHERE collection_id = ? AND ${col} IS ? AND deleted = 0`,
    )
    .get(collectionId, containerId) as { n: number }
  return row.n
}

export const MAX_DOCUMENT_JSON_BYTES = 10 * 1024 * 1024
