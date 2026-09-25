/**
 * Restores a collection's version history from an exported file's `info._slinger` block
 * (format: shared/slingerExport.ts).
 *
 * Everything in the block is untrusted input: it is validated with zod and size-capped, and a block that
 * does not validate is ignored (with a note) instead of failing the import. Only folders/requests/scripts/
 * descriptions are ever stored (the snapshot shape), never environments or secrets.
 */
import { z } from 'zod'
import {
  SLINGER_EXPORT_FORMAT_VERSION,
  SLINGER_IMPORT_LIMITS as LIMITS,
  type VersionHistoryImportResult,
} from '../../shared/slingerExport'
import type { CollectionSnapshot } from '../../shared/types'
import type { Db } from '../db/database'
import { newId } from '../lib/ids'
import { snapshotSchema } from './collectionVersions'
import { compare, parse } from './semver'

const isoSeconds = z
  .string()
  .max(64)
  .refine((s) => Number.isFinite(Date.parse(s)) && Date.parse(s) >= 0, 'not an ISO-8601 date')
  .transform((s) => Math.floor(Date.parse(s) / 1000))

const count = z.number().int().min(0).max(1_000_000)

const versionSchema = z.object({
  version: z.string().max(128).refine((s) => parse(s) !== null, 'not a semantic version (e.g. 1.2.0)'),
  notes: z.string().max(LIMITS.notesChars).nullish(),
  createdAt: isoSeconds,
  folderCount: count,
  requestCount: count,
  snapshot: snapshotSchema.nullish(),
})

const blockSchema = z.object({
  formatVersion: z.number().int().min(1),
  exportedAt: z.string().max(64).optional(),
  app: z.string().max(200).optional(),
  collectionId: z.string().max(200).optional(),
  includesSnapshots: z.boolean().optional(),
  versions: z.array(versionSchema).max(LIMITS.versions),
})

type ParsedVersion = z.infer<typeof versionSchema>

/** Structural problems zod cannot see: unique ids, known parents, no folder cycles, size caps. Returns a reason or null. */
export function snapshotIssue(s: CollectionSnapshot): string | null {
  if (s.folders.length > LIMITS.foldersPerSnapshot) return `more than ${LIMITS.foldersPerSnapshot} folders`
  if (s.requests.length > LIMITS.requestsPerSnapshot) return `more than ${LIMITS.requestsPerSnapshot} requests`
  if (Buffer.byteLength(JSON.stringify(s), 'utf8') > LIMITS.snapshotBytes) return `larger than ${LIMITS.snapshotBytes / 1_000_000} MB`
  const folders = new Map<string, string | null>()
  for (const f of s.folders) {
    if (folders.has(f.id)) return `duplicate folder id ${f.id}`
    folders.set(f.id, f.parentFolderId)
  }
  for (const [id, parent] of folders) {
    if (parent !== null && !folders.has(parent)) return `folder ${id} has a missing parent`
    // Walk up: a cycle revisits a folder before reaching the root.
    const seen = new Set<string>([id])
    for (let p = parent; p !== null; p = folders.get(p) ?? null) {
      if (seen.has(p)) return 'folders form a cycle'
      seen.add(p)
    }
  }
  const requestIds = new Set<string>()
  for (const r of s.requests) {
    if (requestIds.has(r.id)) return `duplicate request id ${r.id}`
    requestIds.add(r.id)
    if (r.folderId !== null && !folders.has(r.folderId)) return `request ${r.id} is in a missing folder`
  }
  return null
}

export type ParsedHistory = { ok: true; versions: ParsedVersion[] } | { ok: false; reason: string }

/** Validates an `info._slinger` value. Never throws. */
export function parseSlingerBlock(raw: unknown): ParsedHistory {
  const result = blockSchema.safeParse(raw)
  if (!result.success) {
    const issue = result.error.issues[0]
    const where = issue?.path.length ? ` at ${issue.path.join('.')}` : ''
    return { ok: false, reason: `the version history is malformed${where}: ${issue?.message ?? 'invalid'}` }
  }
  const block = result.data
  if (block.formatVersion > SLINGER_EXPORT_FORMAT_VERSION) {
    return { ok: false, reason: `the version history uses format ${block.formatVersion}, which needs a newer Slinger` }
  }
  for (const v of block.versions) {
    const issue = v.snapshot ? snapshotIssue(v.snapshot) : null
    if (issue) return { ok: false, reason: `the snapshot of version ${v.version} is invalid (${issue})` }
  }
  return { ok: true, versions: block.versions }
}

interface ExistingVersion {
  version: string
  notes: string | null
  snapshot_json: string
}

/** "1.2.0" -> "1.2.0-imported", "1.2.0-imported.2", ...; "2.0.0-beta.1" -> "2.0.0-beta.1.imported". */
function freeLabel(version: string, taken: Set<string>): string | null {
  const base = version.includes('-') ? `${version}.imported` : `${version}-imported`
  for (let i = 1; i < 1000; i++) {
    const label = i === 1 ? base : `${base}.${i}`
    if (label.length <= 128 && parse(label) && !taken.has(label)) return label
  }
  return null
}

/**
 * Adds the versions of an `info._slinger` block to `collectionId` (usually a collection that was just
 * imported, but works for one that already has versions). Returns undefined when `raw` is undefined (the
 * file had no block). Must run inside the caller's transaction; the inserts use a savepoint so a failure
 * here never undoes the import itself.
 *
 * - Versions are created oldest semver first with the original semver, notes, createdAt, counts and snapshot.
 * - Versions exported without a snapshot cannot be restored or compared, so they are skipped (with a note).
 * - A semver that already exists with the same snapshot and notes is skipped; with different content it is
 *   kept under a free label ("1.2.0-imported") so nothing is lost.
 */
export function restoreVersionHistory(db: Db, collectionId: string, raw: unknown): VersionHistoryImportResult | undefined {
  if (raw === undefined) return undefined
  const result: VersionHistoryImportResult = { restored: 0, skipped: 0, notes: [] }
  const parsed = parseSlingerBlock(raw)
  if (!parsed.ok) {
    result.notes.push(`Version history not restored: ${parsed.reason}. The collection itself was imported.`)
    return result
  }
  const collection = db.prepare('SELECT id, workspace_id FROM collections WHERE id = ? AND deleted = 0').get(collectionId) as
    | { id: string; workspace_id: string }
    | undefined
  if (!collection) throw new Error('collection not found')

  const withSnapshot = parsed.versions.filter((v) => v.snapshot)
  const metadataOnly = parsed.versions.filter((v) => !v.snapshot)
  if (metadataOnly.length > 0) {
    result.skipped += metadataOnly.length
    result.notes.push(
      `${metadataOnly.length} version${metadataOnly.length === 1 ? ' was' : 's were'} exported without ${metadataOnly.length === 1 ? 'its snapshot' : 'snapshots'} ` +
        `and cannot be restored: ${metadataOnly.map((v) => v.version).join(', ')}.`,
    )
  }

  const before = { skipped: result.skipped, notes: result.notes.length }
  try {
    db.transaction(() => {
      const existing = new Map(
        (db.prepare('SELECT version, notes, snapshot_json FROM collection_versions WHERE collection_id = ? AND deleted = 0').all(collection.id) as ExistingVersion[])
          .map((r) => [r.version, r]),
      )
      const taken = new Set(existing.keys())
      const insert = db.prepare(
        `INSERT INTO collection_versions (id, workspace_id, collection_id, version, version_major, version_minor,
           version_patch, version_prerelease, notes, snapshot_json, folder_count, request_count, deleted, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      const seenInFile = new Set<string>()
      for (const v of [...withSnapshot].sort((a, b) => compare(a.version, b.version))) {
        if (seenInFile.has(v.version)) {
          result.skipped++
          result.notes.push(`Version ${v.version} appears more than once in the file; only the first was restored.`)
          continue
        }
        seenInFile.add(v.version)
        const snapshot = v.snapshot as CollectionSnapshot
        const snapshotJson = JSON.stringify(snapshot)
        const notes = v.notes?.trim() || null
        let label = v.version
        const clash = existing.get(v.version)
        if (clash) {
          if (clash.snapshot_json === snapshotJson && (clash.notes ?? null) === notes) {
            result.skipped++
            result.notes.push(`Version ${v.version} is already in this collection; skipped.`)
            continue
          }
          const free = freeLabel(v.version, taken)
          if (!free) {
            result.skipped++
            result.notes.push(`Version ${v.version} already exists with different content and no free label was found; skipped.`)
            continue
          }
          label = free
          result.notes.push(`Version ${v.version} already exists with different content; the imported one was kept as ${label}.`)
        }
        const semver = parse(label)!
        insert.run(
          newId(), collection.workspace_id, collection.id, label, semver.major, semver.minor, semver.patch,
          semver.prerelease.length ? semver.prerelease.join('.') : null, notes, snapshotJson,
          snapshot.folders.length, snapshot.requests.length, v.createdAt,
        )
        taken.add(label)
        result.restored++
      }
    })()
  } catch (err) {
    // The savepoint rolled back every version; the collection import itself goes on.
    result.notes.length = before.notes
    result.skipped = before.skipped + withSnapshot.length
    result.restored = 0
    result.notes.push(`Version history not restored: ${err instanceof Error ? err.message : String(err)}. The collection itself was imported.`)
  }
  return result
}
