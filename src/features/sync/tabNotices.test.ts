import { describe, expect, it } from 'vitest'
import type { ApiRequest } from '../../../shared/types'
import { affectedDirtyTabs, planNotices, serverKey, type TabFacts } from './tabNotices'

const req = (id: string, over: Partial<ApiRequest> = {}): ApiRequest => ({
  id, workspaceId: 'w', collectionId: 'c', folderId: null, name: 'R', method: 'GET', url: 'u', documentJson: '{}', sortOrder: 0, createdAt: 0, updatedAt: 0, version: 1, ...over,
})
const tab = (tabId: string, requestId: string | null, dirty: boolean, key: string): TabFacts => ({ tabId, requestId, dirty, serverKey: key })

describe('affectedDirtyTabs', () => {
  const tabs = [tab('t1', 'r1', true, ''), tab('t2', 'r2', false, ''), tab('t3', 'r3', true, ''), tab('t4', null, true, '')]
  it('picks dirty attached tabs whose request changed', () => {
    expect(affectedDirtyTabs(tabs, new Set(['r1', 'r2']), false)).toEqual(['t1'])
  })
  it('a truncated event affects every dirty attached tab', () => {
    expect(affectedDirtyTabs(tabs, new Set(), true)).toEqual(['t1', 't3'])
  })
  it('nothing changed, nothing affected', () => {
    expect(affectedDirtyTabs(tabs, new Set(), false)).toEqual([])
  })
})

describe('planNotices', () => {
  const original = req('r1', { url: 'old' })
  const key = serverKey(original)
  it('dirty tab + changed content -> "changed" with the fresh server row', () => {
    const fresh = req('r1', { url: 'new', version: 2 })
    const out = planNotices([tab('t1', 'r1', true, key)], ['t1'], new Map([['t1', 'r1']]), () => fresh)
    expect(out.get('t1')).toEqual({ kind: 'changed', server: fresh })
  })
  it('dirty tab + request gone -> "deleted" (the tab was detached by the reload)', () => {
    const out = planNotices([tab('t1', null, true, '')], ['t1'], new Map([['t1', 'r1']]), () => undefined)
    expect(out.get('t1')).toEqual({ kind: 'deleted' })
  })
  it('a version bump with identical content (e.g. a move) produces no notice', () => {
    const same = req('r1', { url: 'old', version: 5 })
    expect(planNotices([tab('t1', 'r1', true, key)], ['t1'], new Map([['t1', 'r1']]), () => same).size).toBe(0)
  })
  it('clean tabs and unaffected tabs never get a notice', () => {
    const fresh = req('r1', { url: 'new' })
    expect(planNotices([tab('t1', 'r1', false, key)], ['t1'], new Map([['t1', 'r1']]), () => fresh).size).toBe(0)
    expect(planNotices([tab('t2', 'r2', true, key)], ['t1'], new Map([['t2', 'r2']]), () => fresh).size).toBe(0)
  })
  it('serverKey matches the tab store definition', () => {
    expect(serverKey(original)).toBe(`R\u0000GET\u0000old\u0000{}`)
  })
})
