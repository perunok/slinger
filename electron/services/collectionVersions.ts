import { z } from 'zod'
import { stripOAuth2TokensFromDocumentJson } from '../../shared/oauth2'
import type {
  Collection,
  CollectionSnapshot,
  CollectionVersion,
  CollectionVersionAuthor,
  CollectionVersionDetail,
  CreateCollectionVersionInput,
  RestoreCollectionVersionMode,
} from '../../shared/types'
import type { Db } from '../db/database'
import { IpcError, invalidInput, notFound } from '../lib/errors'
import { assertUuid, newId } from '../lib/ids'
import { nowSeconds } from '../lib/text'
import {
  descriptionTypeOf,
  requireCollection,
  toCollection,
  type CollectionRow,
  type FolderRow,
  type RequestRow,
} from '../repositories/common'
import { CollectionVariableRepository } from '../repositories/variables'
import { replaceCollectionContent } from './collectionContent'
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
  created_by_id: string | null
  created_by_name: string | null
}

/** Stored snapshot shape; also validates snapshots arriving in an exported file (services/versionHistory.ts). */
export const snapshotSchema = z.object({
  collectionName: z.string(),
  // Scripts (migration 0005) are optional: snapshots taken before them have none.
  collectionScriptsJson: z.string().nullish(),
  // Descriptions (migration 0006) likewise.
  collectionDescription: z.string().nullish(),
  collectionDescriptionType: z.enum(['text/markdown', 'text/plain']).nullish(),
  // Collection variables (migration 0008) likewise; older snapshots restore with none.
  collectionVariables: z
    .array(
      z.object({
        key: z.string().min(1).max(256),
        value: z.string().max(1_000_000),
        enabled: z.boolean().optional(),
        description: z.string().max(100_000).nullish(),
      }),
    )
    .max(5000)
    .optional(),
  folders: z.array(
    z.object({
      id: z.string(),
      parentFolderId: z.string().nullable(),
      name: z.string(),
      sortOrder: z.number(),
      scriptsJson: z.string().nullish(),
      description: z.string().nullish(),
      descriptionType: z.enum(['text/markdown', 'text/plain']).nullish(),
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
  createdBy: r.created_by_name == null ? null : { id: r.created_by_id, name: r.created_by_name },
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

/** The collection's live variables in snapshot form (never secret; `enabled` only when false). */
function snapshotVariables(db: Db, collectionId: string): NonNullable<CollectionSnapshot['collectionVariables']> {
  return new CollectionVariableRepository(db).list(collectionId).map((v) => ({
    key: v.key,
    value: v.value,
    ...(v.enabled ? {} : { enabled: false }),
    ...(v.description ? { description: v.description } : {}),
  }))
}

/** Replaces the collection's variables with a snapshot's (none when the snapshot predates them). */
function restoreVariables(db: Db, collectionId: string, snapshot: CollectionSnapshot): void {
  new CollectionVariableRepository(db).replace(
    collectionId,
    (snapshot.collectionVariables ?? []).map((v) => ({ key: v.key, value: v.value, enabled: v.enabled !== false, description: v.description ?? null })),
  )
}

/**
 * Freezes the collection's current live folders, requests, scripts, descriptions and collection variables into a
 * new immutable version. Never environments, globals or secret values.
 */
export function createCollectionVersion(
  db: Db,
  input: CreateCollectionVersionInput,
  /** The signed-in cloud user (`Core.versionAuthor()`); `null` / omitted = not signed in, the author stays unknown. */
  author: CollectionVersionAuthor | null = null,
): CollectionVersion {
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
        .prepare('SELECT * FROM folders WHERE collection_id = ? AND deleted = 0 ORDER BY sort_order, id')
        .all(collection.id) as FolderRow[]
    ).map((f) => ({
      id: f.id,
      parentFolderId: f.parent_folder_id,
      name: f.name,
      sortOrder: f.sort_order,
      ...(f.scripts_json ? { scriptsJson: f.scripts_json } : {}),
      ...(f.description ? { description: f.description } : {}),
      ...(f.description && descriptionTypeOf(f.description_type) ? { descriptionType: descriptionTypeOf(f.description_type) } : {}),
    }))
    const requests = (
      db
        .prepare('SELECT * FROM requests WHERE collection_id = ? AND deleted = 0 ORDER BY sort_order, id')
        .all(collection.id) as RequestRow[]
    ).map((r) => ({
      id: r.id,
      folderId: r.folder_id,
      name: r.name,
      method: r.method,
      url: r.url,
      // Documents saved before OAuth 2.0 support may still embed an imported token; snapshots never keep it.
      documentJson: stripOAuth2TokensFromDocumentJson(r.document_json),
      sortOrder: r.sort_order,
    }))
    const variables = snapshotVariables(db, collection.id)
    const snapshot: CollectionSnapshot = {
      collectionName: collection.name,
      ...(collection.scripts_json ? { collectionScriptsJson: collection.scripts_json } : {}),
      ...(collection.description ? { collectionDescription: collection.description } : {}),
      ...(collection.description && descriptionTypeOf(collection.description_type)
        ? { collectionDescriptionType: descriptionTypeOf(collection.description_type) }
        : {}),
      // Only when there are variables, so snapshots without them keep the older JSON shape.
      ...(variables.length > 0 ? { collectionVariables: variables } : {}),
      folders,
      requests,
    }
    const id = newId()
    db.prepare(
      `INSERT INTO collection_versions (id, workspace_id, collection_id, version, version_major, version_minor,
         version_patch, version_prerelease, notes, snapshot_json, folder_count, request_count, deleted, created_at,
         created_by_id, created_by_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    ).run(
      id, collection.workspace_id, collection.id, input.version, semver.major, semver.minor, semver.patch,
      semver.prerelease.length ? semver.prerelease.join('.') : null, notes, JSON.stringify(snapshot),
      folders.length, requests.length, nowSeconds(), author?.id ?? null, author ? author.name : null,
    )
    return toVersion(db.prepare('SELECT * FROM collection_versions WHERE id = ?').get(id) as VersionRow)
  })()
}

/**
 * Automatic "safety" versions (taken before a Postman re-import or an OpenAPI update) are recognised by their notes,
 * which sync with the version, so every device prunes the same ones. Only the newest MAX_AUTOMATIC_VERSIONS per
 * collection are kept; older automatic ones are hidden (soft delete, synced like a manual delete). Versions the user
 * made are never touched.
 */
export const AUTOMATIC_VERSION_NOTES_PREFIX = 'Automatic snapshot before '
export const MAX_AUTOMATIC_VERSIONS = 10

/** "Next patch" after the latest release (pre-releases ignored), bumped while taken; "0.0.1" without releases. */
export function nextPatchVersion(existing: readonly string[]): string {
  let top: ReturnType<typeof parse> = null
  for (const v of existing) {
    const p = parse(v)
    if (p && p.prerelease.length === 0 && (!top || compare(p, top) > 0)) top = p
  }
  const taken = new Set(existing)
  let next = top ? { major: top.major, minor: top.minor, patch: top.patch + 1 } : { major: 0, minor: 0, patch: 1 }
  while (taken.has(`${next.major}.${next.minor}.${next.patch}`)) next = { ...next, patch: next.patch + 1 }
  return `${next.major}.${next.minor}.${next.patch}`
}

/**
 * Takes an automatic safety version (next patch, notes `Automatic snapshot before <what>`) and prunes the older
 * automatic versions of the collection beyond the newest MAX_AUTOMATIC_VERSIONS. Runs in the caller's transaction.
 */
export function createAutomaticVersion(db: Db, collectionId: string, what: string, author: CollectionVersionAuthor | null = null): CollectionVersion {
  const version = createCollectionVersion(db, {
    collectionId,
    version: nextPatchVersion(listCollectionVersions(db, collectionId).map((v) => v.version)),
    notes: `${AUTOMATIC_VERSION_NOTES_PREFIX}${what}`,
  }, author)
  const automatic = (
    db
      .prepare('SELECT id, created_at, rowid AS seq FROM collection_versions WHERE collection_id = ? AND deleted = 0 AND substr(notes, 1, ?) = ?')
      .all(version.collectionId, AUTOMATIC_VERSION_NOTES_PREFIX.length, AUTOMATIC_VERSION_NOTES_PREFIX) as Array<{ id: string; created_at: number; seq: number }>
  ).sort((a, b) => b.created_at - a.created_at || b.seq - a.seq)
  const hide = db.prepare('UPDATE collection_versions SET deleted = 1 WHERE id = ?')
  for (const old of automatic.slice(MAX_AUTOMATIC_VERSIONS)) if (old.id !== version.id) hide.run(old.id)
  return version
}

/** The collection description columns a snapshot restores (older snapshots have none: restoring clears it). */
function snapshotDescription(snapshot: CollectionSnapshot): [string | null, string | null] {
  const text = snapshot.collectionDescription ?? null
  return [text, text ? (snapshot.collectionDescriptionType ?? null) : null]
}

/**
 * Writes snapshot content into `collection` (electron/services/collectionContent.ts): rows of the collection that
 * carry a snapshot id are updated or un-deleted in place, everything else live is soft-deleted, items whose id is not
 * in this collection (a copy, a snapshot from a file) get new ids.
 */
function materialize(db: Db, collection: CollectionRow, snapshot: CollectionSnapshot, now: number): void {
  replaceCollectionContent(db, collection, {
    folders: snapshot.folders.map((f) => ({
      key: f.id, parentKey: f.parentFolderId, name: f.name, sortOrder: f.sortOrder, scriptsJson: f.scriptsJson ?? null,
      description: f.description ?? null, descriptionType: f.description ? (f.descriptionType ?? null) : null,
    })),
    requests: snapshot.requests.map((r) => ({
      key: r.id, folderKey: r.folderId, name: r.name, method: r.method, url: r.url, documentJson: r.documentJson, sortOrder: r.sortOrder,
    })),
  }, 'id', now)
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
        `INSERT INTO collections (id, workspace_id, name, scripts_json, description, description_type, version, deleted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
      ).run(id, source.workspace_id, `${snapshot.collectionName} (v${row.version})`.slice(0, 200), snapshot.collectionScriptsJson ?? null,
        ...snapshotDescription(snapshot), now, now)
      const created = db.prepare('SELECT * FROM collections WHERE id = ?').get(id) as CollectionRow
      materialize(db, created, snapshot, now)
      restoreVariables(db, created.id, snapshot)
      return toCollection(created)
    }
    // In place: requests keep their ids, so workflows, history, open tabs and synced copies keep pointing at them.
    materialize(db, source, snapshot, now)
    restoreVariables(db, source.id, snapshot)
    db.prepare('UPDATE collections SET scripts_json = ?, description = ?, description_type = ?, updated_at = ?, version = version + 1 WHERE id = ?')
      .run(snapshot.collectionScriptsJson ?? null, ...snapshotDescription(snapshot), now, source.id)
    return toCollection(db.prepare('SELECT * FROM collections WHERE id = ?').get(source.id) as CollectionRow)
  })()
}

/** Versions are immutable; the only permitted change is hiding one (soft delete). */
export function deleteCollectionVersion(db: Db, versionId: string): void {
  const row = requireVersionRow(db, versionId)
  db.prepare('UPDATE collection_versions SET deleted = 1 WHERE id = ?').run(row.id)
}

