import { describe, expect, it } from 'vitest'
import { mapRestored, remapExpandedKeys } from './restoreRemap'

const f = (id: string, parentFolderId: string | null, name: string, sortOrder = 0) => ({ id, parentFolderId, name, sortOrder })
const r = (id: string, folderId: string | null, name: string, sortOrder = 0) => ({ id, folderId, name, sortOrder })

describe('mapRestored', () => {
  const before = {
    folders: [f('f1', null, 'Auth'), f('f2', 'f1', 'Admin'), f('f3', null, 'Misc')],
    requests: [r('r1', 'f1', 'Login'), r('r2', 'f2', 'Login'), r('r3', null, 'Ping'), r('r4', 'f1', 'Removed later')],
  }
  const after = {
    folders: [f('n3', null, 'Misc'), f('n1', null, 'Auth'), f('n2', 'n1', 'Admin')],
    requests: [r('m2', 'n2', 'Login'), r('m1', 'n1', 'Login'), r('m3', null, 'Ping')],
  }

  it('maps folders and requests by name path, not by id or list order', () => {
    const m = mapRestored(before, after)
    expect(Object.fromEntries(m.folders)).toEqual({ f1: 'n1', f2: 'n2', f3: 'n3' })
    expect(Object.fromEntries(m.requests)).toEqual({ r1: 'm1', r2: 'm2', r3: 'm3' }) // same name in two folders stays apart
    expect(m.requests.has('r4')).toBe(false) // not present in the restored version
  })

  it('tells same-named siblings apart by their order', () => {
    const m = mapRestored(
      { folders: [], requests: [r('a', null, 'Dup', 0), r('b', null, 'Dup', 1)] },
      { folders: [], requests: [r('y', null, 'Dup', 1), r('x', null, 'Dup', 0)] },
    )
    expect(Object.fromEntries(m.requests)).toEqual({ a: 'x', b: 'y' })
  })

  it('a renamed folder does not map and takes its children with it', () => {
    const m = mapRestored(
      { folders: [f('f1', null, 'Old')], requests: [r('r1', 'f1', 'A')] },
      { folders: [f('n1', null, 'New')], requests: [r('m1', 'n1', 'A')] },
    )
    expect(m.folders.size).toBe(0)
    expect(m.requests.size).toBe(0)
  })
})

describe('remapExpandedKeys', () => {
  it('rewrites folder keys of the restored collection and keeps unrelated keys', () => {
    const out = remapExpandedKeys(
      new Set(['collection:c1', 'folder:f1', 'folder:gone', 'folder:other']),
      new Map([['f1', 'n1']]),
      new Set(['f1', 'gone']),
    )
    expect([...out].sort()).toEqual(['collection:c1', 'folder:n1', 'folder:other'])
  })
})
