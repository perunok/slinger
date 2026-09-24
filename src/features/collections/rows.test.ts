import { describe, expect, it } from 'vitest'
import type { ApiFolder, ApiRequest, Collection } from '../../../shared/types'
import { buildRows } from './rows'

const col = (id: string, name = id): Collection => ({ id, workspaceId: 'w', name, createdAt: 0, updatedAt: 0, version: 1 })
const fol = (id: string, parent: string | null, order = 0, collectionId = 'c1'): ApiFolder => ({
  id, workspaceId: 'w', collectionId, parentFolderId: parent, name: id, sortOrder: order, createdAt: 0, updatedAt: 0, version: 1,
})
const req = (id: string, folderId: string | null, order = 0, name = id): ApiRequest => ({
  id, workspaceId: 'w', collectionId: 'c1', folderId, name, method: 'GET', url: `/${id}`, documentJson: '{}', sortOrder: order, createdAt: 0, updatedAt: 0, version: 1,
})

const data = {
  collections: [col('c1', 'Alpha')],
  folders: [fol('f1', null), fol('f2', 'f1')],
  requests: [req('r1', null), req('r2', 'f1'), req('r3', 'f2', 0, 'Login')],
}

describe('buildRows', () => {
  it('hides children of collapsed containers', () => {
    const rows = buildRows({ ...data, expanded: new Set(), filter: '' })
    expect(rows.map((r) => r.key)).toEqual(['collection:c1'])
    expect(rows[0].count).toBe(3)
  })
  it('lists folders before requests with depth and aria sizes', () => {
    const rows = buildRows({ ...data, expanded: new Set(['collection:c1', 'folder:f1', 'folder:f2']), filter: '' })
    expect(rows.map((r) => [r.key, r.depth])).toEqual([
      ['collection:c1', 0],
      ['folder:f1', 1],
      ['folder:f2', 2],
      ['request:r3', 3],
      ['request:r2', 2],
      ['request:r1', 1],
    ])
    expect(rows.find((r) => r.key === 'request:r1')).toMatchObject({ posInSet: 2, setSize: 2, parentKey: 'collection:c1' })
  })
  it('filter expands everything and keeps ancestors of matches', () => {
    const rows = buildRows({ ...data, expanded: new Set(), filter: 'login' })
    expect(rows.map((r) => r.key)).toEqual(['collection:c1', 'folder:f1', 'folder:f2', 'request:r3'])
  })
  it('a collection whose name matches shows everything, non-matching collections vanish', () => {
    const rows = buildRows({ ...data, collections: [...data.collections, col('c2', 'Beta')], expanded: new Set(), filter: 'alpha' })
    expect(rows.filter((r) => r.kind === 'collection').map((r) => r.id)).toEqual(['c1'])
    expect(rows).toHaveLength(6)
  })
})
