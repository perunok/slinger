/**
 * Mock of electron/services/versionHistory.ts: restores `info._slinger` versions on import. Same outcomes and
 * notes for the common cases (valid block, metadata only, duplicates, malformed block), with lighter validation.
 */
import type { VersionHistoryImportResult } from '../../../shared/slingerExport'
import type { CollectionSnapshot } from '../../../shared/types'
import { compareSemver, parseSemver } from '../../lib/semver'
import type { MockState } from './store'
import { clone, uuid } from './util'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

interface Entry {
  version: string
  notes: string | null
  createdAt: number
  snapshot: CollectionSnapshot | null
}

function isSnapshot(v: unknown): v is CollectionSnapshot {
  return isObj(v) && typeof v.collectionName === 'string' && Array.isArray(v.folders) && Array.isArray(v.requests)
}

function parse(raw: unknown): { ok: true; entries: Entry[] } | { ok: false; reason: string } {
  if (!isObj(raw) || typeof raw.formatVersion !== 'number' || !Array.isArray(raw.versions)) return { ok: false, reason: 'the version history is malformed' }
  if (raw.formatVersion > 1) return { ok: false, reason: `the version history uses format ${raw.formatVersion}, which needs a newer Slinger` }
  if (raw.versions.length > 500) return { ok: false, reason: 'the version history is malformed at versions: too many versions' }
  const entries: Entry[] = []
  for (const [i, v] of raw.versions.entries()) {
    const created = isObj(v) && typeof v.createdAt === 'string' ? Date.parse(v.createdAt) : NaN
    if (!isObj(v) || typeof v.version !== 'string' || !parseSemver(v.version) || !Number.isFinite(created)) {
      return { ok: false, reason: `the version history is malformed at versions.${i}` }
    }
    if (v.snapshot != null && !isSnapshot(v.snapshot)) return { ok: false, reason: `the snapshot of version ${v.version} is invalid` }
    entries.push({
      version: v.version,
      notes: typeof v.notes === 'string' && v.notes.trim() ? v.notes.trim() : null,
      createdAt: Math.floor(created / 1000),
      snapshot: v.snapshot ? clone(v.snapshot as CollectionSnapshot) : null,
    })
  }
  return { ok: true, entries }
}

export function restoreVersionHistoryMock(s: MockState, collectionId: string, raw: unknown): VersionHistoryImportResult | undefined {
  if (raw === undefined) return undefined
  const result: VersionHistoryImportResult = { restored: 0, skipped: 0, notes: [] }
  const parsed = parse(raw)
  if (!parsed.ok) {
    result.notes.push(`Version history not restored: ${parsed.reason}. The collection itself was imported.`)
    return result
  }
  const collection = s.collections.find((c) => c.id === collectionId)!
  const metadataOnly = parsed.entries.filter((e) => !e.snapshot)
  if (metadataOnly.length > 0) {
    result.skipped += metadataOnly.length
    result.notes.push(
      `${metadataOnly.length} version${metadataOnly.length === 1 ? ' was' : 's were'} exported without ${metadataOnly.length === 1 ? 'its snapshot' : 'snapshots'} ` +
        `and cannot be restored: ${metadataOnly.map((e) => e.version).join(', ')}.`,
    )
  }
  const taken = new Set(s.versions.filter((v) => v.collectionId === collectionId).map((v) => v.version))
  const seen = new Set<string>()
  for (const e of parsed.entries.filter((x) => x.snapshot).sort((a, b) => compareSemver(a.version, b.version))) {
    if (seen.has(e.version)) {
      result.skipped++
      result.notes.push(`Version ${e.version} appears more than once in the file; only the first was restored.`)
      continue
    }
    seen.add(e.version)
    let label = e.version
    if (taken.has(label)) {
      const base = label.includes('-') ? `${label}.imported` : `${label}-imported`
      let i = 1
      while (taken.has(i === 1 ? base : `${base}.${i}`)) i++
      label = i === 1 ? base : `${base}.${i}`
      result.notes.push(`Version ${e.version} already exists with different content; the imported one was kept as ${label}.`)
    }
    const snapshot = e.snapshot!
    s.versions.push({
      id: uuid(),
      workspaceId: collection.workspaceId,
      collectionId,
      version: label,
      notes: e.notes,
      folderCount: snapshot.folders.length,
      requestCount: snapshot.requests.length,
      createdAt: e.createdAt,
      snapshot,
    })
    taken.add(label)
    result.restored++
  }
  return result
}
