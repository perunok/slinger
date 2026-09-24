/** Flattens collections + their trees into the visible rows of the sidebar tree. */
import type { ApiFolder, ApiRequest, Collection } from '../../../shared/types'
import { buildTree, countRequests, filterTree, type TreeNode } from '../../lib/tree'

export type RowKind = 'collection' | 'folder' | 'request'

export interface TreeRowModel {
  /** Unique across kinds: `collection:<id>`, `folder:<id>`, `request:<id>`. */
  key: string
  kind: RowKind
  id: string
  depth: number
  label: string
  collectionId: string
  /** Parent row key (null for collections). */
  parentKey: string | null
  expandable: boolean
  expanded: boolean
  method?: string
  /** Number of requests below (collections/folders). */
  count?: number
  /** Position among visible siblings, for aria-posinset. */
  posInSet: number
  setSize: number
}

export const rowKey = (kind: RowKind, id: string) => `${kind}:${id}`

export interface RowsInput {
  collections: Collection[]
  folders: ApiFolder[]
  requests: ApiRequest[]
  expanded: ReadonlySet<string>
  filter: string
}

export function buildRows({ collections, folders, requests, expanded, filter }: RowsInput): TreeRowModel[] {
  const rows: TreeRowModel[] = []
  const q = filter.trim()
  const visibleCollections: { c: Collection; nodes: TreeNode[]; total: number }[] = []
  for (const c of collections) {
    const all = buildTree(
      folders.filter((f) => f.collectionId === c.id),
      requests.filter((r) => r.collectionId === c.id),
    )
    const total = countRequests(all)
    if (!q) visibleCollections.push({ c, nodes: all, total })
    else if (c.name.toLowerCase().includes(q.toLowerCase())) visibleCollections.push({ c, nodes: all, total })
    else {
      const nodes = filterTree(all, q)
      if (nodes.length > 0) visibleCollections.push({ c, nodes, total: countRequests(nodes) })
    }
  }

  visibleCollections.forEach(({ c, nodes, total }, ci) => {
    const key = rowKey('collection', c.id)
    const isOpen = q ? true : expanded.has(key)
    rows.push({
      key,
      kind: 'collection',
      id: c.id,
      depth: 0,
      label: c.name,
      collectionId: c.id,
      parentKey: null,
      expandable: true,
      expanded: isOpen,
      count: total,
      posInSet: ci + 1,
      setSize: visibleCollections.length,
    })
    if (!isOpen) return
    const walk = (list: TreeNode[], depth: number, parentKey: string) => {
      list.forEach((node, i) => {
        if (node.kind === 'folder') {
          const fk = rowKey('folder', node.id)
          const open = q ? true : expanded.has(fk)
          rows.push({
            key: fk,
            kind: 'folder',
            id: node.id,
            depth,
            label: node.folder.name,
            collectionId: c.id,
            parentKey,
            expandable: true,
            expanded: open,
            count: countRequests(node.children),
            posInSet: i + 1,
            setSize: list.length,
          })
          if (open) walk(node.children, depth + 1, fk)
        } else {
          rows.push({
            key: rowKey('request', node.id),
            kind: 'request',
            id: node.id,
            depth,
            label: node.request.name,
            collectionId: c.id,
            parentKey,
            expandable: false,
            expanded: false,
            method: node.request.method,
            posInSet: i + 1,
            setSize: list.length,
          })
        }
      })
    }
    walk(nodes, 1, key)
  })
  return rows
}
