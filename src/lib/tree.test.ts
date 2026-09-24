import { describe, expect, it } from 'vitest'
import type { ApiFolder, ApiRequest } from '../../shared/types'
import {
  buildTree,
  countRequests,
  filterTree,
  flattenVisible,
  isDescendantFolder,
  planDrop,
  type DropContext,
  type TreeNode,
} from './tree'

let seq = 0
function folder(id: string, parent: string | null, sortOrder = 0, name = id, collectionId = 'c1'): ApiFolder {
  seq++
  return { id, workspaceId: 'w', collectionId, parentFolderId: parent, name, sortOrder, createdAt: seq, updatedAt: seq, version: 1 }
}
function req(id: string, folderId: string | null, sortOrder = 0, name = id, extra: Partial<ApiRequest> = {}): ApiRequest {
  seq++
  return {
    id, workspaceId: 'w', collectionId: 'c1', folderId, name, method: 'GET', url: `https://x/${id}`,
    documentJson: '{}', sortOrder, createdAt: seq, updatedAt: seq, version: 1, ...extra,
  }
}
const names = (nodes: TreeNode[]) => nodes.map((n) => n.id)

describe('buildTree', () => {
  it('nests, sorts and puts folders before requests', () => {
    const tree = buildTree(
      [folder('b', null, 2), folder('a', null, 1), folder('a1', 'a', 0)],
      [req('r2', null, 2), req('r1', null, 1), req('ra', 'a', 0)],
    )
    expect(names(tree)).toEqual(['a', 'b', 'r1', 'r2'])
    const a = tree[0]
    expect(a.kind === 'folder' && names(a.children)).toEqual(['a1', 'ra'])
  })
  it('sorts by name then id on equal sortOrder', () => {
    const tree = buildTree([], [req('z', null, 0, 'same'), req('y', null, 0, 'same'), req('x', null, 0, 'alpha')])
    expect(names(tree)).toEqual(['x', 'y', 'z'])
  })
  it('puts orphans at the root', () => {
    const tree = buildTree([folder('f', 'ghost')], [req('r', 'ghost2')])
    expect(names(tree)).toEqual(['f', 'r'])
  })
  it('survives cycles and self parents', () => {
    const tree = buildTree([folder('a', 'b'), folder('b', 'a'), folder('s', 's')], [req('r', 'a')])
    expect(countRequests(tree)).toBe(1)
    const flat = flattenVisible(tree, new Set(['a', 'b', 's']))
    expect(flat.filter((n) => n.kind === 'folder').map((n) => n.id).sort()).toEqual(['a', 'b', 's'])
  })
})

describe('isDescendantFolder', () => {
  const fs = [folder('a', null), folder('b', 'a'), folder('c', 'b'), folder('d', null)]
  it('detects self and nesting', () => {
    expect(isDescendantFolder(fs, 'a', 'a')).toBe(true)
    expect(isDescendantFolder(fs, 'a', 'c')).toBe(true)
    expect(isDescendantFolder(fs, 'c', 'a')).toBe(false)
    expect(isDescendantFolder(fs, 'a', 'd')).toBe(false)
  })
  it('does not loop on cycles', () => {
    expect(isDescendantFolder([folder('x', 'y'), folder('y', 'x')], 'z', 'x')).toBe(false)
  })
})

describe('planDrop', () => {
  // c1 root: folders F1(0), F2(1), F3(2); requests R1(0), R2(1), R3(2)
  // F1: folders G1(0), G2(1); requests Q1(0), Q2(1)
  const folders = [folder('F1', null, 0), folder('F2', null, 1), folder('F3', null, 2), folder('G1', 'F1', 0), folder('G2', 'F1', 1)]
  const requests = [
    req('R1', null, 0), req('R2', null, 1), req('R3', null, 2), req('Q1', 'F1', 0), req('Q2', 'F1', 1),
  ]
  const other = [folder('OF', null, 0, 'OF', 'c2')]
  const otherReq = [req('OR', null, 0, 'OR', { collectionId: 'c2' })]
  const ctx: DropContext = {
    collections: ['c1', 'c2'],
    foldersByCollection: new Map([['c1', folders], ['c2', other]]),
    requestsByCollection: new Map([['c1', requests], ['c2', otherReq]]),
  }
  const rq = (id: string) => ({ kind: 'request' as const, id })
  const fd = (id: string) => ({ kind: 'folder' as const, id })

  it('reorders a request down (removal shift)', () => {
    // R1 after R2 -> [R2, R1, R3]
    expect(planDrop(ctx, rq('R1'), rq('R2'), 'after')).toEqual({
      kind: 'request', input: { requestId: 'R1', targetCollectionId: 'c1', targetFolderId: null, targetIndex: 1 },
    })
    // R1 before R3 -> [R2, R1, R3]
    expect(planDrop(ctx, rq('R1'), rq('R3'), 'before')).toMatchObject({ input: { targetIndex: 1 } })
    // R1 after R3 -> end
    expect(planDrop(ctx, rq('R1'), rq('R3'), 'after')).toMatchObject({ input: { targetIndex: 2 } })
  })
  it('reorders a request up', () => {
    expect(planDrop(ctx, rq('R3'), rq('R1'), 'before')).toMatchObject({ input: { targetIndex: 0 } })
    expect(planDrop(ctx, rq('R3'), rq('R1'), 'after')).toMatchObject({ input: { targetIndex: 1 } })
  })
  it('detects no-ops', () => {
    expect(planDrop(ctx, rq('R2'), rq('R1'), 'after')).toBeNull()
    expect(planDrop(ctx, rq('R2'), rq('R3'), 'before')).toBeNull()
    expect(planDrop(ctx, rq('R3'), { kind: 'collection', collectionId: 'c1' }, 'inside')).toBeNull()
    expect(planDrop(ctx, rq('R2'), rq('R2'), 'before')).toBeNull()
    expect(planDrop(ctx, fd('F2'), fd('F1'), 'after')).toBeNull()
    expect(planDrop(ctx, fd('G2'), fd('F1'), 'inside')).toBeNull()
  })
  it('reparents a request into a folder (appended)', () => {
    expect(planDrop(ctx, rq('R1'), fd('F1'), 'inside')).toEqual({
      kind: 'request', input: { requestId: 'R1', targetCollectionId: 'c1', targetFolderId: 'F1', targetIndex: 2 },
    })
  })
  it('moves a request out of a folder to the root end', () => {
    expect(planDrop(ctx, rq('Q1'), { kind: 'collection', collectionId: 'c1' }, 'inside')).toEqual({
      kind: 'request', input: { requestId: 'Q1', targetCollectionId: 'c1', targetFolderId: null, targetIndex: 3 },
    })
  })
  it('moves a request between requests of another folder', () => {
    expect(planDrop(ctx, rq('R1'), rq('Q2'), 'before')).toMatchObject({ input: { targetFolderId: 'F1', targetIndex: 1 } })
  })
  it('moves a request across collections', () => {
    expect(planDrop(ctx, rq('R1'), rq('OR'), 'after')).toEqual({
      kind: 'request', input: { requestId: 'R1', targetCollectionId: 'c2', targetFolderId: null, targetIndex: 1 },
    })
    expect(planDrop(ctx, rq('R1'), { kind: 'collection', collectionId: 'c2' }, 'inside')).toMatchObject({
      input: { targetCollectionId: 'c2', targetFolderId: null, targetIndex: 1 },
    })
    expect(planDrop(ctx, rq('R1'), fd('OF'), 'inside')).toMatchObject({
      input: { targetCollectionId: 'c2', targetFolderId: 'OF', targetIndex: 0 },
    })
  })
  it('request before/after a folder goes to the parent container as first request', () => {
    expect(planDrop(ctx, rq('R3'), fd('F2'), 'before')).toMatchObject({ input: { targetFolderId: null, targetIndex: 0 } })
    expect(planDrop(ctx, rq('R3'), fd('G2'), 'after')).toMatchObject({ input: { targetFolderId: 'F1', targetIndex: 0 } })
  })
  it('reorders folders (removal shift)', () => {
    expect(planDrop(ctx, fd('F1'), fd('F2'), 'after')).toEqual({
      kind: 'folder', input: { folderId: 'F1', targetParentFolderId: null, targetIndex: 1 },
    })
    expect(planDrop(ctx, fd('F3'), fd('F1'), 'before')).toMatchObject({ input: { targetIndex: 0 } })
    expect(planDrop(ctx, fd('F1'), fd('F3'), 'before')).toMatchObject({ input: { targetIndex: 1 } })
  })
  it('reparents folders', () => {
    expect(planDrop(ctx, fd('F3'), fd('F1'), 'inside')).toMatchObject({ input: { targetParentFolderId: 'F1', targetIndex: 2 } })
    expect(planDrop(ctx, fd('G1'), { kind: 'collection', collectionId: 'c1' }, 'inside')).toEqual({
      kind: 'folder', input: { folderId: 'G1', targetParentFolderId: null, targetIndex: 3 },
    })
    expect(planDrop(ctx, fd('G1'), fd('F2'), 'before')).toMatchObject({ input: { targetParentFolderId: null, targetIndex: 1 } })
  })
  it('folder before/after a request lands after the last folder of that container', () => {
    expect(planDrop(ctx, fd('G1'), rq('R2'), 'before')).toMatchObject({ input: { targetParentFolderId: null, targetIndex: 3 } })
    expect(planDrop(ctx, fd('F3'), rq('Q1'), 'after')).toMatchObject({ input: { targetParentFolderId: 'F1', targetIndex: 2 } })
  })
  it('blocks cycles', () => {
    expect(planDrop(ctx, fd('F1'), fd('F1'), 'inside')).toHaveProperty('blocked')
    expect(planDrop(ctx, fd('F1'), fd('G1'), 'inside')).toHaveProperty('blocked')
    expect(planDrop(ctx, fd('F1'), fd('G1'), 'before')).toHaveProperty('blocked')
    expect(planDrop(ctx, fd('F1'), rq('Q1'), 'after')).toHaveProperty('blocked')
  })
  it('blocks other invalid drops', () => {
    expect(planDrop(ctx, rq('R1'), rq('R2'), 'inside')).toHaveProperty('blocked')
    expect(planDrop(ctx, fd('F1'), fd('OF'), 'inside')).toHaveProperty('blocked')
    expect(planDrop(ctx, fd('F1'), { kind: 'collection', collectionId: 'c2' }, 'inside')).toHaveProperty('blocked')
    expect(planDrop(ctx, rq('R1'), { kind: 'collection', collectionId: 'nope' }, 'inside')).toHaveProperty('blocked')
    expect(planDrop(ctx, rq('missing'), fd('F1'), 'inside')).toHaveProperty('blocked')
    expect(planDrop(ctx, rq('R1'), fd('missing'), 'inside')).toHaveProperty('blocked')
  })
})

describe('filterTree / flattenVisible / countRequests', () => {
  const tree = buildTree(
    [folder('users', null, 0, 'Users'), folder('sub', 'users', 0, 'Admin'), folder('misc', null, 1, 'Misc')],
    [
      req('a', 'sub', 0, 'Create', { method: 'POST', url: 'https://x/api/users' }),
      req('b', 'users', 1, 'List'),
      req('c', 'misc', 0, 'Ping', { url: 'https://x/ping' }),
      req('d', null, 0, 'Root thing'),
    ],
  )
  it('counts', () => expect(countRequests(tree)).toBe(4))
  it('returns everything for an empty query', () => expect(filterTree(tree, '  ')).toBe(tree))
  it('matches url and keeps ancestors', () => {
    const f = filterTree(tree, 'PING')
    expect(names(f)).toEqual(['misc'])
    expect(countRequests(f)).toBe(1)
  })
  it('matches method', () => {
    const f = filterTree(tree, 'post')
    expect(countRequests(f)).toBe(1)
    expect(names(f)).toEqual(['users'])
  })
  it('keeps the whole subtree when the folder name matches', () => {
    const f = filterTree(tree, 'users')
    // folder name "Users" matches -> all children; request a matches nothing extra
    expect(countRequests(f)).toBe(2)
    expect(f).toHaveLength(1)
  })
  it('returns empty when nothing matches', () => expect(filterTree(tree, 'zzz')).toEqual([]))
  it('flattens only expanded folders in order', () => {
    expect(names(flattenVisible(tree, new Set()))).toEqual(['users', 'misc', 'd'])
    expect(names(flattenVisible(tree, new Set(['users'])))).toEqual(['users', 'sub', 'b', 'misc', 'd'])
    expect(names(flattenVisible(tree, new Set(['users', 'sub', 'misc'])))).toEqual(['users', 'sub', 'a', 'b', 'misc', 'c', 'd'])
  })
})
