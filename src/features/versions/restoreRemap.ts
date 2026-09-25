/**
 * After "Replace the live collection" every folder and request comes back with a new id. These
 * helpers map the old ids to their restored counterparts so the UI can keep its expanded folders
 * and offer to reopen tabs. Matching is by position: a folder or request is identified by the
 * chain of folder names above it plus its own name; siblings that share a name are told apart by
 * their order (sortOrder, then array order).
 */
import type { ApiFolder, ApiRequest } from '../../../shared/types'

type F = Pick<ApiFolder, 'id' | 'parentFolderId' | 'name' | 'sortOrder'>
type R = Pick<ApiRequest, 'id' | 'folderId' | 'name' | 'sortOrder'>

export interface IdMap {
  folders: Map<string, string>
  requests: Map<string, string>
}

const SEP = '\u0000'

function keyed<T extends { name: string; sortOrder: number }>(items: T[], parentKey: (x: T) => string): Map<string, T> {
  const seen = new Map<string, number>()
  const out = new Map<string, T>()
  const ordered = items.map((x, i) => ({ x, i })).sort((a, b) => a.x.sortOrder - b.x.sortOrder || a.i - b.i)
  for (const { x } of ordered) {
    const base = `${parentKey(x)}${SEP}${x.name}`
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    out.set(`${base}${SEP}${n}`, x)
  }
  return out
}

/** Path key (parent chain + name + sibling index) to folder, walking the tree top-down. */
function folderKeys(folders: F[]): Map<string, F> {
  const ids = new Set(folders.map((f) => f.id))
  const children = new Map<string, F[]>()
  for (const f of folders) {
    const p = f.parentFolderId && ids.has(f.parentFolderId) ? f.parentFolderId : ''
    children.set(p, [...(children.get(p) ?? []), f])
  }
  const out = new Map<string, F>()
  const walk = (parentId: string, parentKey: string) => {
    for (const [k, f] of keyed(children.get(parentId) ?? [], () => parentKey)) {
      out.set(k, f)
      walk(f.id, k)
    }
  }
  walk('', '')
  return out
}

/** Old-id to new-id maps for folders and requests that exist (by path) in both layouts. */
export function mapRestored(before: { folders: F[]; requests: R[] }, after: { folders: F[]; requests: R[] }): IdMap {
  const oldFolders = folderKeys(before.folders)
  const newFolders = folderKeys(after.folders)
  const folders = new Map<string, string>()
  const oldKeyOf = new Map<string, string>()
  const newKeyOf = new Map<string, string>()
  for (const [k, f] of oldFolders) oldKeyOf.set(f.id, k)
  for (const [k, f] of newFolders) newKeyOf.set(f.id, k)
  for (const [k, f] of oldFolders) {
    const n = newFolders.get(k)
    if (n) folders.set(f.id, n.id)
  }
  const reqKeys = (rs: R[], keyOf: Map<string, string>) => keyed(rs, (r) => (r.folderId ? (keyOf.get(r.folderId) ?? '?') : ''))
  const oldReqs = reqKeys(before.requests, oldKeyOf)
  const newReqs = reqKeys(after.requests, newKeyOf)
  const requests = new Map<string, string>()
  for (const [k, r] of oldReqs) {
    const n = newReqs.get(k)
    if (n) requests.set(r.id, n.id)
  }
  return { folders, requests }
}

/** Rewrites `folder:<id>` keys of an expanded-set through the map; other keys stay, vanished folders drop out. */
export function remapExpandedKeys(keys: ReadonlySet<string>, folders: Map<string, string>, scopeFolderIds: ReadonlySet<string>): Set<string> {
  const out = new Set<string>()
  for (const k of keys) {
    if (!k.startsWith('folder:')) {
      out.add(k)
      continue
    }
    const id = k.slice('folder:'.length)
    if (!scopeFolderIds.has(id)) out.add(k) // folder of another collection
    else if (folders.has(id)) out.add(`folder:${folders.get(id)}`)
  }
  return out
}
