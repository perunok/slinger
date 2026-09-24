import { z } from 'zod'
import type {
  Collection,
  CollectionSnapshot,
  CollectionVersion,
  CollectionVersionDetail,
  CreateCollectionVersionInput,
  RestoreCollectionVersionMode,
} from '../../shared/types'
import type { Db } from '../db/database'
import { IpcError, invalidInput, notFound } from '../lib/errors'
import { assertUuid, newId } from '../lib/ids'
import { nowSeconds } from '../lib/text'
import {
  requireCollection,
  toCollection,
  type CollectionRow,
  type FolderRow,
  type RequestRow,
} from '../repositories/common'
import { compare, parse } from './semver'

interface VersionRow {
  id: string
  workspace_id: string
  collection_id: string
  version: string
  version_major: number
  version_minor: number
  version_patch: number
  version_prerelease: string | null
  notes: string | null
  snapshot_json: string
  folder_count: number
  request_count: number
  created_at: number
}

const snapshotSchema = z.object({
  collectionName: z.string(),
  folders: z.array(
    z.object({
      id: z.string(),
      parentFolderId: z.string().nullable(),
      name: z.string(),
      sortOrder: z.number(),
    }),
  ),
  requests: z.array(
    z.object({
      id: z.string(),
      folderId: z.string().nullable(),
      name: z.string(),
      method: z.string(),
      url: z.string(),
      documentJson: z.string(),
      sortOrder: z.number(),
    }),
  ),
})

const MAX_NOTES = 10_000

const toVersion = (r: VersionRow): CollectionVersion => ({
  id: r.id,
  workspaceId: r.workspace_id,
  collectionId: r.collection_id,
  version: r.version,
  notes: r.notes,
  folderCount: r.folder_count,
  requestCount: r.request_count,
  createdAt: r.created_at,
})

function requireVersionRow(db: Db, versionId: string): VersionRow {
  const row = db
    .prepare(
      `SELECT v.* FROM collection_versions v
       JOIN collections c ON c.id = v.collection_id
       WHERE v.id = ? AND v.deleted = 0 AND c.deleted = 0`,
    )
    .get(assertUuid(versionId, 'versionId')) as VersionRow | undefined
  if (!row) throw notFound('collection version')
  return row
}

function parseSnapshot(row: VersionRow): CollectionSnapshot {
  try {
    return snapshotSchema.parse(JSON.parse(row.snapshot_json))
  } catch {
    throw new IpcError({ code: 'internal_error', message: 'stored collection snapshot is corrupt' })
  }
}

/** Newest semver first (pre-releases sort below their release). Ties cannot occur (unique index). */
export function listCollectionVersions(db: Db, collectionId: string): CollectionVersion[] {
  requireCollection(db, collectionId)
  const rows = db
    .prepare('SELECT * FROM collection_versions WHERE collection_id = ? AND deleted = 0')
    .all(collectionId.toLowerCase()) as VersionRow[]
  return rows.sort((a, b) => compare(b.version, a.version)).map(toVersion)
}

export function getCollectionVersion(db: Db, versionId: string): CollectionVersionDetail {
  const row = requireVersionRow(db, versionId)
  return { ...toVersion(row), snapshot: parseSnapshot(row) }
}

/**
 * Freezes the collection's current live folders and requests into a new immutable version.
 * Only folders and requests are captured: never environments or secret values.
 */
export function createCollectionVersion(db: Db, input: CreateCollectionVersionInput): CollectionVersion {
  const collection = requireCollection(db, input.collectionId)
  const semver = parse(input.version)
  if (!semver) {
    throw invalidInput('version must be a valid semantic version like 1.2.3 or 1.2.3-beta.1 (no "v" prefix, no build metadata)')
  }
  let notes: string | null = null
  if (input.notes != null) {
    if (typeof input.notes !== 'string') throw invalidInput('notes must be a string')
    notes = input.notes.trim() || null
    if (notes && notes.length > MAX_NOTES) throw invalidInput(`notes must be at most ${MAX_NOTES} characters`)
  }

  return db.transaction(() => {
    const duplicate = db
      .prepare('SELECT 1 FROM collection_versions WHERE collection_id = ? AND version = ? AND deleted = 0')
      .get(collection.id, input.version)
    if (duplicate) {
      throw invalidInput(`version ${input.version} already exists for this collection`, { reason: 'duplicate_version' })
    }
    const folders = (
      db
        .prepare('SELECT * FROM folders WHERE collection_id = ? AND deleted = 0 ORDER BY sort_order, created_at, id')
        .all(collection.id) as FolderRow[]
    ).map((f) => ({ id: f.id, parentFolderId: f.parent_folder_id, name: f.name, sortOrder: f.sort_order }))
    const requests = (
      db
        .prepare('SELECT * FROM requests WHERE collection_id = ? AND deleted = 0 ORDER BY sort_order, created_at, id')
        .all(collection.id) as RequestRow[]
    ).map((r) => ({
      id: r.id,
      folderId: r.folder_id,
      name: r.name,
      method: r.method,
      url: r.url,
      documentJson: r.document_json,
      sortOrder: r.sort_order,
    }))
    const snapshot: CollectionSnapshot = { collectionName: collection.name, folders, requests }
    const id = newId()
    db.prepare(
      `INSERT INTO collection_versions (id, workspace_id, collection_id, version, version_major, version_minor,
         version_patch, version_prerelease, notes, snapshot_json, folder_count, request_count, deleted, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run(
      id, collection.workspace_id, collection.id, input.version, semver.major, semver.minor, semver.patch,
      semver.prerelease.length ? semver.prerelease.join('.') : null, notes, JSON.stringify(snapshot),
      folders.length, requests.length, nowSeconds(),
    )
    return toVersion(db.prepare('SELECT * FROM collection_versions WHERE id = ?').get(id) as VersionRow)
  })()
}

/** Inserts snapshot content into `collectionId` with brand-new ids; returns counts. */
function materialize(db: Db, collection: CollectionRow, snapshot: CollectionSnapshot): void {
  const now = nowSeconds()
  const idMap = new Map<string, string>()
  const pending = [...snapshot.folders]
  const insertFolder = db.prepare(
    `INSERT INTO folders (id, workspace_id, collection_id, parent_folder_id, name, sort_order, version, deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
  )
  // Parents first, regardless of the order stored in the snapshot.
  while (pending.length) {
    const before = pending.length
    for (let i = pending.length - 1; i >= 0; i--) {
      const f = pending[i]!
      if (f.parentFolderId !== null && !idMap.has(f.parentFolderId)) continue
      const id = newId()
      insertFolder.run(id, collection.workspace_id, collection.id,
        f.parentFolderId === null ? null : idMap.get(f.parentFolderId)!, f.name, f.sortOrder, now, now)
      idMap.set(f.id, id)
      pending.splice(i, 1)
    }
    if (pending.length === before) {
      throw new IpcError({ code: 'internal_error', message: 'stored collection snapshot has an invalid folder tree' })
    }
  }
  const insertRequest = db.prepare(
    `INSERT INTO requests (id, workspace_id, collection_id, folder_id, name, method, url, document_json,
       sort_order, version, deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
  )
  for (const r of snapshot.requests) {
    let folderId: string | null = null
    if (r.folderId !== null) {
      folderId = idMap.get(r.folderId) ?? null
      if (!folderId) throw new IpcError({ code: 'internal_error', message: 'stored collection snapshot references a missing folder' })
    }
    insertRequest.run(newId(), collection.workspace_id, collection.id, folderId, r.name, r.method, r.url,
      r.documentJson, r.sortOrder, now, now)
  }
}

export function restoreCollectionVersion(
  db: Db,
  versionId: string,
  mode: RestoreCollectionVersionMode,
): Collection {
  if (mode !== 'replace' && mode !== 'copy') throw invalidInput('mode must be "replace" or "copy"')
  const row = requireVersionRow(db, versionId)
  const snapshot = parseSnapshot(row)
  const source = requireCollection(db, row.collection_id)

  return db.transaction((): Collection => {
    const now = nowSeconds()
    if (mode === 'copy') {
      const id = newId()
      db.prepare(
        `INSERT INTO collections (id, workspace_id, name, version, deleted, created_at, updated_at)
         VALUES (?, ?, ?, 1, 0, ?, ?)`,
      ).run(id, source.workspace_id, `${snapshot.collectionName} (v${row.version})`.slice(0, 200), now, now)
      const created = db.prepare('SELECT * FROM collections WHERE id = ?').get(id) as CollectionRow
      materialize(db, created, snapshot)
      return toCollection(created)
    }
    for (const table of ['folders', 'requests']) {
      db.prepare(
        `UPDATE ${table} SET deleted = 1, updated_at = ?, version = version + 1 WHERE collection_id = ? AND deleted = 0`,
      ).run(now, source.id)
    }
    materialize(db, source, snapshot)
    db.prepare('UPDATE collections SET updated_at = ?, version = version + 1 WHERE id = ?').run(now, source.id)
    return toCollection(db.prepare('SELECT * FROM collections WHERE id = ?').get(source.id) as CollectionRow)
  })()
}

/** Versions are immutable; the only permitted change is hiding one (soft delete). */
export function deleteCollectionVersion(db: Db, versionId: string): void {
  const row = requireVersionRow(db, versionId)
  db.prepare('UPDATE collection_versions SET deleted = 1 WHERE id = ?').run(row.id)
}

