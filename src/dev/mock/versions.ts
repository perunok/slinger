import type { ApiFolder, ApiRequest, Collection, CollectionSnapshot, CollectionVersionAuthor } from '../../../shared/types'
import type { SlingerIpcApi } from '../../../shared/ipc-contract'
import { compareSemver, suggestBumps, validateVersion } from '../../lib/semver'
import { addCollection, must, removeCollectionContents, touch, type MockState, type VersionRow } from './store'
import { clone, fail, nowSec, uuid } from './util'
import { collectionVariablesData, setCollectionVariables } from './variables'

type VersionApi = Pick<
  SlingerIpcApi,
  | 'listCollectionVersions'
  | 'getCollectionVersion'
  | 'createCollectionVersion'
  | 'restoreCollectionVersion'
  | 'deleteCollectionVersion'
>

export function takeSnapshot(s: MockState, collectionId: string): CollectionSnapshot {
  const collection = must(s.collections, collectionId, 'Collection')
  return {
    collectionName: collection.name,
    ...(collection.scriptsJson ? { collectionScriptsJson: collection.scriptsJson } : {}),
    ...(collection.authJson ? { collectionAuthJson: collection.authJson } : {}),
    ...(collection.description ? { collectionDescription: collection.description } : {}),
    ...(collection.description && collection.descriptionType ? { collectionDescriptionType: collection.descriptionType } : {}),
    ...(collectionVariablesData(s, collectionId).length > 0 ? { collectionVariables: collectionVariablesData(s, collectionId) } : {}),
    folders: s.folders
      .filter((f) => f.collectionId === collectionId)
      .map((f) => ({
        id: f.id,
        parentFolderId: f.parentFolderId,
        name: f.name,
        sortOrder: f.sortOrder,
        ...(f.scriptsJson ? { scriptsJson: f.scriptsJson } : {}),
        ...(f.description ? { description: f.description } : {}),
        ...(f.description && f.descriptionType ? { descriptionType: f.descriptionType } : {}),
        ...(f.authJson ? { authJson: f.authJson } : {}),
      })),
    requests: s.requests
      .filter((r) => r.collectionId === collectionId)
      .map((r) => ({
        id: r.id,
        folderId: r.folderId,
        name: r.name,
        method: r.method,
        url: r.url,
        documentJson: r.documentJson,
        sortOrder: r.sortOrder,
      })),
  }
}

export function addVersion(
  s: MockState,
  collectionId: string,
  version: string,
  notes: string | null,
  createdBy: CollectionVersionAuthor | null = s.versionAuthor?.() ?? null,
): VersionRow {
  const collection = must(s.collections, collectionId, 'Collection')
  const snapshot = takeSnapshot(s, collectionId)
  const row: VersionRow = {
    id: uuid(),
    workspaceId: collection.workspaceId,
    collectionId,
    version,
    notes,
    folderCount: snapshot.folders.length,
    requestCount: snapshot.requests.length,
    createdAt: nowSec(),
    createdBy,
    snapshot,
  }
  s.versions.push(row)
  return row
}

const summary = ({ snapshot: _snapshot, ...rest }: VersionRow) => rest

/** Mirror of electron/services/collectionVersions.ts: automatic safety versions, the newest 10 kept per collection. */
export const AUTOMATIC_VERSION_NOTES_PREFIX = 'Automatic snapshot before '
export const MAX_AUTOMATIC_VERSIONS = 10

export function addAutomaticVersion(s: MockState, collectionId: string, what: string): VersionRow {
  const versions = s.versions.filter((v) => v.collectionId === collectionId).map((v) => v.version)
  const row = addVersion(s, collectionId, suggestBumps(versions).patch, `${AUTOMATIC_VERSION_NOTES_PREFIX}${what}`)
  const automatic = s.versions
    .map((v, i) => ({ v, i }))
    .filter(({ v }) => v.collectionId === collectionId && v.notes?.startsWith(AUTOMATIC_VERSION_NOTES_PREFIX))
    .sort((a, b) => b.v.createdAt - a.v.createdAt || b.i - a.i)
  const pruned = new Set(automatic.slice(MAX_AUTOMATIC_VERSIONS).map(({ v }) => v.id).filter((id) => id !== row.id))
  if (pruned.size) s.versions = s.versions.filter((v) => !pruned.has(v.id))
  return row
}

/** The live folders and requests of a collection by id (before they are swapped), for created/version bookkeeping. */
function previousOf(s: MockState, collectionId: string) {
  return {
    folders: new Map(s.folders.filter((f) => f.collectionId === collectionId).map((f) => [f.id, f])),
    requests: new Map(s.requests.filter((r) => r.collectionId === collectionId).map((r) => [r.id, r])),
  }
}

function materialize(
  s: MockState,
  collection: Collection,
  snapshot: CollectionSnapshot,
  resolve: (id: string) => string,
  previous: { folders: Map<string, ApiFolder>; requests: Map<string, ApiRequest> },
): void {
  const now = nowSec()
  for (const f of snapshot.folders) {
    const id = resolve(f.id)
    s.folders.push({
      id,
      workspaceId: collection.workspaceId,
      collectionId: collection.id,
      parentFolderId: f.parentFolderId === null ? null : resolve(f.parentFolderId),
      name: f.name,
      sortOrder: f.sortOrder,
      scriptsJson: f.scriptsJson ?? null,
      description: f.description ?? null,
      descriptionType: f.description ? (f.descriptionType ?? null) : null,
      authJson: f.authJson ?? null,
      createdAt: previous.folders.get(id)?.createdAt ?? now,
      updatedAt: now,
      version: (previous.folders.get(id)?.version ?? 0) + 1,
    })
  }
  for (const r of snapshot.requests) {
    const id = resolve(r.id)
    s.requests.push({
      id,
      workspaceId: collection.workspaceId,
      collectionId: collection.id,
      folderId: r.folderId === null ? null : resolve(r.folderId),
      name: r.name,
      method: r.method,
      url: r.url,
      documentJson: r.documentJson,
      sortOrder: r.sortOrder,
      createdAt: previous.requests.get(id)?.createdAt ?? now,
      updatedAt: now,
      version: (previous.requests.get(id)?.version ?? 0) + 1,
    })
  }
}

function restoreReplace(s: MockState, collection: Collection, snapshot: CollectionSnapshot): Collection {
  const previous = previousOf(s, collection.id)
  removeCollectionContents(s, collection.id)
  // Like the real main process: snapshot ids are kept (in place), unless another collection uses the id now.
  const taken = new Set([...s.folders.map((f) => f.id), ...s.requests.map((r) => r.id)])
  const fresh = new Map<string, string>()
  const resolve = (id: string) => fresh.get(id) ?? (fresh.set(id, taken.has(id) ? uuid() : id), fresh.get(id) as string)
  materialize(s, collection, clone(snapshot), resolve, previous)
  collection.scriptsJson = snapshot.collectionScriptsJson ?? null
  collection.authJson = snapshot.collectionAuthJson ?? null
  collection.description = snapshot.collectionDescription ?? null
  collection.descriptionType = snapshot.collectionDescription ? (snapshot.collectionDescriptionType ?? null) : null
  setCollectionVariables(s, collection.id, collection.workspaceId, snapshot.collectionVariables ?? [])
  return touch(collection)
}

function restoreCopy(s: MockState, source: VersionRow): Collection {
  const copy = addCollection(s, source.workspaceId, `${source.snapshot.collectionName} (v${source.version})`)
  if (s.untrustedCollections[source.collectionId]) s.untrustedCollections[copy.id] = true
  copy.scriptsJson = source.snapshot.collectionScriptsJson ?? null
  copy.authJson = source.snapshot.collectionAuthJson ?? null
  copy.description = source.snapshot.collectionDescription ?? null
  copy.descriptionType = source.snapshot.collectionDescription ? (source.snapshot.collectionDescriptionType ?? null) : null
  const resolve = (): ((id: string) => string) => {
    const map = new Map<string, string>()
    return (id) => map.get(id) ?? (map.set(id, uuid()), map.get(id) as string)
  }
  materialize(s, copy, clone(source.snapshot), resolve(), { folders: new Map(), requests: new Map() })
  setCollectionVariables(s, copy.id, copy.workspaceId, source.snapshot.collectionVariables ?? [])
  return copy
}

export function createVersionApi(s: MockState): VersionApi {
  const version = (id: string) => must(s.versions, id, 'Collection version')
  return {
    async listCollectionVersions(collectionId) {
      must(s.collections, collectionId, 'Collection')
      return s.versions
        .filter((v) => v.collectionId === collectionId)
        .sort((a, b) => compareSemver(b.version, a.version))
        .map(summary)
    },
    async getCollectionVersion(versionId) {
      return version(versionId)
    },
    async createCollectionVersion(input) {
      must(s.collections, input.collectionId, 'Collection')
      const existing = s.versions.filter((v) => v.collectionId === input.collectionId).map((v) => v.version)
      const check = validateVersion(input.version, existing)
      if (!check.ok) fail('invalid_input', check.reason, { reason: /already|duplicate/i.test(check.reason) ? 'duplicate_version' : check.reason })
      const notes = input.notes?.trim() ? input.notes.trim() : null
      return summary(addVersion(s, input.collectionId, input.version.trim(), notes))
    },
    async restoreCollectionVersion(versionId, mode) {
      const row = version(versionId)
      if (mode === 'copy') return restoreCopy(s, row)
      if (mode !== 'replace') fail('invalid_input', `Unknown restore mode: ${String(mode)}`)
      const collection = must(s.collections, row.collectionId, 'Collection')
      return restoreReplace(s, collection, row.snapshot)
    },
    async deleteCollectionVersion(versionId) {
      version(versionId)
      s.versions = s.versions.filter((v) => v.id !== versionId)
    },
  }
}
