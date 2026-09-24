import type { ApiFolder, ApiRequest, Collection, CollectionSnapshot } from '../../../shared/types'
import type { SlingerIpcApi } from '../../../shared/ipc-contract'
import { compareSemver, validateVersion } from '../../lib/semver'
import { addCollection, must, removeCollectionContents, touch, type MockState, type VersionRow } from './store'
import { clone, fail, nowSec, uuid } from './util'

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
    folders: s.folders
      .filter((f) => f.collectionId === collectionId)
      .map((f) => ({ id: f.id, parentFolderId: f.parentFolderId, name: f.name, sortOrder: f.sortOrder })),
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

export function addVersion(s: MockState, collectionId: string, version: string, notes: string | null): VersionRow {
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
    snapshot,
  }
  s.versions.push(row)
  return row
}

const summary = ({ snapshot: _snapshot, ...rest }: VersionRow) => rest

/** Keep the snapshot's id unless another live row (outside the collection being rebuilt) already uses it. */
function idResolver(taken: Set<string>): (id: string) => string {
  const map = new Map<string, string>()
  return (id) => {
    let mapped = map.get(id)
    if (!mapped) {
      mapped = taken.has(id) ? uuid() : id
      map.set(id, mapped)
    }
    return mapped
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
  const previous = {
    folders: new Map(s.folders.filter((f) => f.collectionId === collection.id).map((f) => [f.id, f])),
    requests: new Map(s.requests.filter((r) => r.collectionId === collection.id).map((r) => [r.id, r])),
  }
  removeCollectionContents(s, collection.id)
  const taken = new Set([...s.folders.map((f) => f.id), ...s.requests.map((r) => r.id)])
  materialize(s, collection, clone(snapshot), idResolver(taken), previous)
  return touch(collection)
}

function restoreCopy(s: MockState, source: VersionRow): Collection {
  const copy = addCollection(s, source.workspaceId, `${source.snapshot.collectionName} (v${source.version})`)
  const resolve = (): ((id: string) => string) => {
    const map = new Map<string, string>()
    return (id) => map.get(id) ?? (map.set(id, uuid()), map.get(id) as string)
  }
  materialize(s, copy, clone(source.snapshot), resolve(), { folders: new Map(), requests: new Map() })
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
