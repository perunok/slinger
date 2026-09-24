/**
 * Collection tree building, filtering and drag-and-drop planning. Pure functions only.
 *
 * Conventions (mirrors shared/types.ts):
 *  - A container (collection root or folder) shows its folders first, then its requests.
 *  - Siblings are sorted by sortOrder, then name, then id.
 *  - `targetIndex` counts siblings of the SAME kind, after the moved item was removed
 *    from its old position.
 */
import type { ApiFolder, ApiRequest, MoveFolderInput, MoveRequestInput } from '../../shared/types'

export type TreeNode =
  | { kind: 'folder'; id: string; folder: ApiFolder; children: TreeNode[] }
  | { kind: 'request'; id: string; request: ApiRequest }

type Sortable = { sortOrder: number; name: string; id: string }

function bySibling(a: Sortable, b: Sortable): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
  const n = a.name.localeCompare(b.name)
  if (n !== 0) return n
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function sorted<T extends Sortable>(items: T[]): T[] {
  return [...items].sort(bySibling)
}

/**
 * Builds the children of one collection's root. Orphans (missing parent) are attached to the
 * root; folders caught in a parent cycle are broken open at their first-sorted member.
 */
export function buildTree(folders: ApiFolder[], requests: ApiRequest[]): TreeNode[] {
  const folderIds = new Set(folders.map((f) => f.id))
  const foldersByParent = new Map<string | null, ApiFolder[]>()
  for (const f of folders) {
    const parent = f.parentFolderId !== null && folderIds.has(f.parentFolderId) && f.parentFolderId !== f.id ? f.parentFolderId : null
    const list = foldersByParent.get(parent)
    if (list) list.push(f)
    else foldersByParent.set(parent, [f])
  }
  const requestsByFolder = new Map<string | null, ApiRequest[]>()
  for (const r of requests) {
    const parent = r.folderId !== null && folderIds.has(r.folderId) ? r.folderId : null
    const list = requestsByFolder.get(parent)
    if (list) list.push(r)
    else requestsByFolder.set(parent, [r])
  }

  const visited = new Set<string>()
  const build = (parent: string | null): TreeNode[] => {
    const out: TreeNode[] = []
    for (const folder of sorted(foldersByParent.get(parent) ?? [])) {
      if (visited.has(folder.id)) continue
      visited.add(folder.id)
      out.push({ kind: 'folder', id: folder.id, folder, children: build(folder.id) })
    }
    for (const request of sorted(requestsByFolder.get(parent) ?? [])) {
      out.push({ kind: 'request', id: request.id, request })
    }
    return out
  }

  const root = build(null)
  // Folders unreachable from the root are part of a cycle: surface them at the root.
  const leftovers = sorted(folders.filter((f) => !visited.has(f.id)))
  const extra: TreeNode[] = []
  for (const folder of leftovers) {
    if (visited.has(folder.id)) continue
    visited.add(folder.id)
    extra.push({ kind: 'folder', id: folder.id, folder, children: build(folder.id) })
  }
  if (extra.length === 0) return root
  const rootFolders = root.filter((n) => n.kind === 'folder')
  const rootRequests = root.filter((n) => n.kind === 'request')
  return [...rootFolders, ...extra, ...rootRequests]
}

/** True if `candidateId` is `ancestorId` itself or nested anywhere below it. Cycle safe. */
export function isDescendantFolder(folders: ApiFolder[], ancestorId: string, candidateId: string): boolean {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const seen = new Set<string>()
  let current: string | null = candidateId
  while (current !== null && !seen.has(current)) {
    if (current === ancestorId) return true
    seen.add(current)
    current = byId.get(current)?.parentFolderId ?? null
  }
  return false
}

// ---------------------------------------------------------------------------
// Drag and drop
// ---------------------------------------------------------------------------

export type DropPosition = 'before' | 'after' | 'inside'
export type DragItem = { kind: 'folder' | 'request'; id: string }
/** `collection` = drop at the end of that collection's root. */
export type DropTarget = { kind: 'folder' | 'request'; id: string } | { kind: 'collection'; collectionId: string }
export type DropPlan =
  | { kind: 'request'; input: MoveRequestInput }
  | { kind: 'folder'; input: MoveFolderInput }

export interface DropContext {
  /** Known collection ids, for validation. */
  collections: string[]
  foldersByCollection: Map<string, ApiFolder[]>
  requestsByCollection: Map<string, ApiRequest[]>
}

interface Located<T> {
  collectionId: string
  item: T
}

function findFolder(ctx: DropContext, id: string): Located<ApiFolder> | null {
  for (const [collectionId, list] of ctx.foldersByCollection) {
    const item = list.find((f) => f.id === id)
    if (item) return { collectionId, item }
  }
  return null
}

function findRequest(ctx: DropContext, id: string): Located<ApiRequest> | null {
  for (const [collectionId, list] of ctx.requestsByCollection) {
    const item = list.find((r) => r.id === id)
    if (item) return { collectionId, item }
  }
  return null
}

/** Folder id if it exists in the collection, otherwise null (orphans render at the root). */
function effectiveParent(folders: ApiFolder[], id: string | null): string | null {
  return id !== null && folders.some((f) => f.id === id) ? id : null
}

function siblingFolders(folders: ApiFolder[], parent: string | null): ApiFolder[] {
  return sorted(folders.filter((f) => effectiveParent(folders, f.parentFolderId) === parent))
}

function siblingRequests(folders: ApiFolder[], requests: ApiRequest[], parent: string | null): ApiRequest[] {
  return sorted(requests.filter((r) => effectiveParent(folders, r.folderId) === parent))
}

/**
 * Plans a move. Returns null for a no-op and `{ blocked }` for an invalid drop.
 *
 * Resolution rules:
 *  - target `collection`, or `inside` a folder: append to the end of that container.
 *  - `before`/`after` a same-kind target: sibling position next to the target.
 *  - request `before`/`after` a FOLDER: placed in the folder's parent container as its first
 *    request (requests render below all folders, so this is directly under the folder list).
 *  - folder `before`/`after` a REQUEST: placed in the request's container after its last
 *    folder (folders render above requests).
 *  - `inside` a request: blocked. Folder moved across collections: blocked
 *    (MoveFolderInput has no collection).
 *  - Dropping an item before/after itself is a no-op.
 */
export function planDrop(
  ctx: DropContext,
  item: DragItem,
  target: DropTarget,
  position: DropPosition,
): DropPlan | { blocked: string } | null {
  const movedFolder = item.kind === 'folder' ? findFolder(ctx, item.id) : null
  const movedRequest = item.kind === 'request' ? findRequest(ctx, item.id) : null
  if (!movedFolder && !movedRequest) return { blocked: 'The dragged item no longer exists.' }
  const sourceCollectionId = (movedFolder ?? movedRequest)!.collectionId

  // Resolve the destination container and where in it we want to go.
  let collectionId: string
  let containerId: string | null
  type Anchor = { at: 'end' } | { at: 'start' } | { at: 'rel'; kind: 'folder' | 'request'; id: string; after: boolean }
  let anchor: Anchor

  if (target.kind === 'collection') {
    if (!ctx.collections.includes(target.collectionId)) return { blocked: 'Unknown collection.' }
    collectionId = target.collectionId
    containerId = null
    anchor = { at: 'end' }
  } else if (target.kind === 'folder') {
    const t = findFolder(ctx, target.id)
    if (!t) return { blocked: 'The drop target no longer exists.' }
    collectionId = t.collectionId
    if (position === 'inside') {
      containerId = t.item.id
      anchor = { at: 'end' }
    } else {
      containerId = effectiveParent(ctx.foldersByCollection.get(collectionId) ?? [], t.item.parentFolderId)
      if (item.kind === 'folder') {
        if (item.id === t.item.id) return null
        anchor = { at: 'rel', kind: 'folder', id: t.item.id, after: position === 'after' }
      } else {
        anchor = { at: 'start' }
      }
    }
  } else {
    const t = findRequest(ctx, target.id)
    if (!t) return { blocked: 'The drop target no longer exists.' }
    if (position === 'inside') return { blocked: 'Requests cannot contain other items.' }
    collectionId = t.collectionId
    containerId = effectiveParent(ctx.foldersByCollection.get(collectionId) ?? [], t.item.folderId)
    if (item.kind === 'request') {
      if (item.id === t.item.id) return null
      anchor = { at: 'rel', kind: 'request', id: t.item.id, after: position === 'after' }
    } else {
      anchor = { at: 'end' }
    }
  }

  const folders = ctx.foldersByCollection.get(collectionId) ?? []
  const requests = ctx.requestsByCollection.get(collectionId) ?? []

  if (movedFolder) {
    if (collectionId !== sourceCollectionId) {
      return { blocked: 'Folders cannot be moved to a different collection.' }
    }
    if (containerId !== null && isDescendantFolder(folders, item.id, containerId)) {
      return {
        blocked: containerId === item.id ? 'A folder cannot be moved into itself.' : 'A folder cannot be moved into its own subfolder.',
      }
    }
  }

  // Same-kind siblings of the destination, with the moved item removed.
  const siblings =
    item.kind === 'folder'
      ? siblingFolders(folders, containerId).filter((f) => f.id !== item.id)
      : siblingRequests(folders, requests, containerId).filter((r) => r.id !== item.id)

  let index: number
  if (anchor.at === 'end') index = siblings.length
  else if (anchor.at === 'start') index = 0
  else {
    const i = siblings.findIndex((s) => s.id === anchor.id)
    index = i < 0 ? siblings.length : i + (anchor.after ? 1 : 0)
  }

  // No-op detection: same container and same slot.
  if (movedFolder && collectionId === sourceCollectionId) {
    const current = effectiveParent(folders, movedFolder.item.parentFolderId)
    if (current === containerId) {
      const cur = siblingFolders(folders, current).findIndex((f) => f.id === item.id)
      if (cur === index) return null
    }
  }
  if (movedRequest && collectionId === sourceCollectionId) {
    const current = effectiveParent(folders, movedRequest.item.folderId)
    if (current === containerId) {
      const cur = siblingRequests(folders, requests, current).findIndex((r) => r.id === item.id)
      if (cur === index) return null
    }
  }

  if (item.kind === 'folder') {
    return { kind: 'folder', input: { folderId: item.id, targetParentFolderId: containerId, targetIndex: index } }
  }
  return {
    kind: 'request',
    input: { requestId: item.id, targetCollectionId: collectionId, targetFolderId: containerId, targetIndex: index },
  }
}

// ---------------------------------------------------------------------------
// Filtering / navigation helpers
// ---------------------------------------------------------------------------

/**
 * Case-insensitive filter on request name/method/url and folder name. Ancestors of matches
 * are kept; a folder whose own name matches keeps its whole subtree.
 */
export function filterTree(nodes: TreeNode[], query: string): TreeNode[] {
  const q = query.trim().toLowerCase()
  if (!q) return nodes
  const walk = (list: TreeNode[]): TreeNode[] => {
    const out: TreeNode[] = []
    for (const node of list) {
      if (node.kind === 'request') {
        const r = node.request
        if (r.name.toLowerCase().includes(q) || r.method.toLowerCase().includes(q) || r.url.toLowerCase().includes(q)) out.push(node)
      } else if (node.folder.name.toLowerCase().includes(q)) {
        out.push(node)
      } else {
        const children = walk(node.children)
        if (children.length > 0) out.push({ ...node, children })
      }
    }
    return out
  }
  return walk(nodes)
}

/** Pre-order list of the nodes that are currently visible, given the expanded folder ids. */
export function flattenVisible(nodes: TreeNode[], expanded: ReadonlySet<string>): TreeNode[] {
  const out: TreeNode[] = []
  const walk = (list: TreeNode[]) => {
    for (const node of list) {
      out.push(node)
      if (node.kind === 'folder' && expanded.has(node.id)) walk(node.children)
    }
  }
  walk(nodes)
  return out
}

export function countRequests(nodes: TreeNode[]): number {
  let n = 0
  for (const node of nodes) n += node.kind === 'request' ? 1 : countRequests(node.children)
  return n
}
