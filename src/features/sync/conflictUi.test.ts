import { describe, expect, it } from 'vitest'
import type { SyncConflict, SyncConflictKind } from '../../../shared/types'
import { KIND_ORDER, bulkTargets, flatOrder, groupByKind, mergeReady, nextAfterRemoval, pathText, resolutionUi } from './conflictUi'

let n = 0
const c = (kind: SyncConflictKind, over: Partial<SyncConflict> = {}): SyncConflict => ({
  id: `c${n++}`, workspaceId: 'w', entityType: 'request', entityId: `e${n}`, kind, status: 'open', label: kind, path: ['Col', kind], message: '',
  groups: [], allowedResolutions: ['keep_local', 'keep_remote'], createdAt: 0, resolvedAt: null, resolution: null, ...over,
})

describe('grouping', () => {
  it('orders sections by kind and drops empty ones', () => {
    const list = [c('rejected'), c('edit_edit'), c('local_deleted'), c('edit_edit')]
    const sections = groupByKind(list)
    expect(sections.map((s) => s.kind)).toEqual(['edit_edit', 'local_deleted', 'rejected'])
    expect(sections[0].items).toHaveLength(2)
    expect(flatOrder(list).map((x) => x.kind)).toEqual(['edit_edit', 'edit_edit', 'local_deleted', 'rejected'])
    expect(KIND_ORDER).toHaveLength(6)
  })
  it('builds breadcrumbs with a fallback', () => {
    expect(pathText(['A', 'B'], 'x')).toBe('A / B')
    expect(pathText([], 'Label')).toBe('Label')
  })
})

describe('bulk targets', () => {
  const a = c('edit_edit')
  const b = c('rejected', { allowedResolutions: ['keep_remote'] })
  const done = c('edit_edit', { status: 'resolved' })
  it('applies to selected open conflicts that allow the resolution and reports the rest as skipped', () => {
    const sel = new Set([a.id, b.id, done.id])
    const local = bulkTargets([a, b, done], sel, 'keep_local')
    expect(local.apply.map((x) => x.id)).toEqual([a.id])
    expect(local.skipped.map((x) => x.id)).toEqual([b.id])
    expect(bulkTargets([a, b, done], sel, 'keep_remote').apply).toHaveLength(2)
    expect(bulkTargets([a, b], new Set(), 'keep_remote').apply).toEqual([])
  })
})

describe('focus after resolving', () => {
  const list = [c('edit_edit'), c('edit_edit'), c('rejected')]
  it('moves to the next item, else the previous, else null', () => {
    expect(nextAfterRemoval(list, list[0].id)).toBe(list[1].id)
    expect(nextAfterRemoval(list, list[2].id)).toBe(list[1].id)
    expect(nextAfterRemoval([list[0]], list[0].id)).toBeNull()
    expect(nextAfterRemoval(list, 'unknown')).toBe(list[0].id)
  })
})

describe('merge readiness', () => {
  const groups = [
    { group: 'name', label: 'Name', conflicting: true, base: null, local: 'a', remote: 'b' },
    { group: 'location', label: 'Location', conflicting: true, base: null, local: 'a', remote: 'b' },
    { group: 'order', label: 'Order', conflicting: false, base: null, local: 'a', remote: 'b' },
  ] as SyncConflict['groups']
  it('needs a choice for every CONFLICTING group only', () => {
    expect(mergeReady({ groups }, {})).toBe(false)
    expect(mergeReady({ groups }, { name: 'local' })).toBe(false)
    expect(mergeReady({ groups }, { name: 'local', location: 'remote' })).toBe(true)
  })
})

describe('wording', () => {
  it('describes the destructive direction differently per kind', () => {
    expect(resolutionUi('remote_deleted', 'keep_local').label).toBe('Restore in the cloud')
    expect(resolutionUi('remote_deleted', 'keep_remote').variant).toBe('danger')
    expect(resolutionUi('local_deleted', 'keep_remote').label).toBe('Restore it here')
    expect(resolutionUi('local_deleted', 'keep_local').variant).toBe('danger')
    expect(resolutionUi('immutable_clash', 'duplicate').label).toBe('Keep mine as a new version')
    expect(resolutionUi('rejected', 'keep_remote').label).toBe('Discard my change')
    expect(resolutionUi('edit_edit', 'keep_local').label).toBe('Keep mine')
    expect(resolutionUi('edit_edit', 'duplicate').label).toBe('Keep both')
  })
})
