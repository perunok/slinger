import type { ApiFolder, ApiRequest, Collection, DescriptionType, Environment, Workspace } from '../../shared/types'
import type { Db } from '../db/database'
import { invalidInput, notFound } from '../lib/errors'
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
  scripts_json?: string | null
  description?: string | null
  description_type?: string | null
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
  scripts_json?: string | null
  description?: string | null
  description_type?: string | null
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
  scriptsJson: r.scripts_json ?? null,
  description: r.description ?? null,
  descriptionType: descriptionTypeOf(r.description_type),
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
  scriptsJson: r.scripts_json ?? null,
  description: r.description ?? null,
  descriptionType: descriptionTypeOf(r.description_type),
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
export const MAX_SCRIPTS_JSON_BYTES = 2 * 1024 * 1024

/**
 * Validates a collection/folder `scripts_json` value: null, or JSON text of an array (the Postman `event`
 * list, stored verbatim). An empty array is stored as NULL.
 */
export function cleanScriptsJson(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw invalidInput('scriptsJson must be a string or null')
  if (Buffer.byteLength(value, 'utf8') > MAX_SCRIPTS_JSON_BYTES) throw invalidInput('scripts are too large (2 MB max)')
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw invalidInput('scriptsJson must be valid JSON')
  }
  if (!Array.isArray(parsed)) throw invalidInput('scriptsJson must be a JSON array (Postman "event" list)')
  return parsed.length === 0 ? null : value
}

export const MAX_DESCRIPTION_BYTES = 2 * 1024 * 1024
const DESCRIPTION_TYPES = new Set(['text/markdown', 'text/plain'])

/** Stored `description_type` -> API value (anything unknown reads as "plain string form"). */
export function descriptionTypeOf(value: string | null | undefined): DescriptionType | null {
  return value && DESCRIPTION_TYPES.has(value) ? (value as DescriptionType) : null
}

/** Validates a collection/folder description; empty or whitespace-only text is stored as NULL. */
export function cleanDescription(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw invalidInput('description must be a string or null')
  if (Buffer.byteLength(value, 'utf8') > MAX_DESCRIPTION_BYTES) throw invalidInput('description is too large (2 MB max)')
  return value.trim() === '' ? null : value
}

/**
 * A Postman `description` (a string, or `{content, type}`) -> stored text + type. The type is kept only for
 * the object form so export can write the same shape back; an unknown type is treated as Markdown.
 */
export function descriptionFromPostman(value: unknown): { text: string | null; type: DescriptionType | null } {
  if (typeof value === 'string') return { text: value.trim() === '' ? null : value, type: null }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const o = value as Record<string, unknown>
    const content = typeof o.content === 'string' ? o.content : ''
    if (content.trim() === '') return { text: null, type: null }
    return { text: content, type: o.type === 'text/plain' ? 'text/plain' : 'text/markdown' }
  }
  return { text: null, type: null }
}
