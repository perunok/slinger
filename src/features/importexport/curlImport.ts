/**
 * Import of cURL commands (Import dialog, or a curl pasted into the URL bar): each command becomes a request in a chosen
 * collection (or a new one) and folder. Parsing is lib/curl.ts; this module only places the requests.
 */
import type { ApiFolder, ApiRequest, Collection } from '../../../shared/types'
import { curlToDraft, type ParsedCurl } from '../../lib/curl'
import { api } from '../../lib/ipc'
import { serializeDraft } from '../../lib/request'

/** Where the requests go: an existing collection (`collectionId`) or a new one named `newName`, at the root or in a folder. */
export interface CurlTarget {
  collectionId: string | null
  newName: string
  folderId: string | null
}

export const NEW_COLLECTION_NAME = 'Imported from cURL'

/** Folders of a collection in sidebar order, labelled with their path ("Users / Admin"). */
export function folderChoices(folders: readonly ApiFolder[]): Array<{ id: string; label: string }> {
  const byParent = new Map<string | null, ApiFolder[]>()
  for (const f of folders) byParent.set(f.parentFolderId ?? null, [...(byParent.get(f.parentFolderId ?? null) ?? []), f])
  const out: Array<{ id: string; label: string }> = []
  const walk = (parent: string | null, path: string[]) => {
    const kids = [...(byParent.get(parent) ?? [])].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    for (const f of kids) {
      const label = [...path, f.name]
      out.push({ id: f.id, label: label.join(' / ') })
      walk(f.id, label)
    }
  }
  walk(null, [])
  return out
}

/** The collection the requests go to by default: the one of the open tab's request, else the first, else a new one. */
export function defaultCurlTarget(collections: readonly Collection[], activeRequest: Pick<ApiRequest, 'collectionId' | 'folderId'> | null): CurlTarget {
  if (activeRequest && collections.some((c) => c.id === activeRequest.collectionId)) {
    return { collectionId: activeRequest.collectionId, newName: NEW_COLLECTION_NAME, folderId: activeRequest.folderId ?? null }
  }
  return { collectionId: collections[0]?.id ?? null, newName: NEW_COLLECTION_NAME, folderId: null }
}

/** Creates the requests (and the collection when `target.collectionId` is null), in order. */
export async function addCurlRequests(
  workspaceId: string,
  requests: ReadonlyArray<{ parsed: ParsedCurl; name: string }>,
  target: CurlTarget,
): Promise<{ collectionId: string; created: ApiRequest[] }> {
  const collectionId = target.collectionId ?? (await api().createCollection(workspaceId, target.newName.trim() || NEW_COLLECTION_NAME)).id
  const folderId = target.collectionId ? target.folderId : null
  const created: ApiRequest[] = []
  for (const r of requests) {
    const s = serializeDraft(curlToDraft(r.parsed, r.name))
    created.push(await api().createRequest({ workspaceId, collectionId, folderId, name: s.name, method: s.method, url: s.url, documentJson: s.documentJson }))
  }
  return { collectionId, created }
}
