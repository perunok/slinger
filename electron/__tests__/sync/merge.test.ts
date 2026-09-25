import { describe, expect, it } from 'vitest'
import { merge } from '../../sync/merge'

const req = (o: Record<string, unknown> = {}) => ({
  collection_id: 'c', folder_id: null, name: 'n', method: 'GET', url: 'u', document_json: '{}', sort_order: 0, ...o,
})

describe('three-way merge per field group', () => {
  it('only local changed -> local; only remote changed -> remote; same change -> same', () => {
    const base = req()
    expect(merge('request', base, req({ name: 'L' }), req())).toMatchObject({ merged: { name: 'L' }, conflicting: [], takenLocal: ['content'] })
    expect(merge('request', base, req(), req({ name: 'R' }))).toMatchObject({ merged: { name: 'R' }, conflicting: [], takenLocal: [] })
    expect(merge('request', base, req({ name: 'X' }), req({ name: 'X' }))).toMatchObject({ merged: { name: 'X' }, conflicting: [], takenLocal: [] })
  })

  it('both changed the same group differently -> conflict, local value kept in the merged result', () => {
    const r = merge('request', req(), req({ url: 'local' }), req({ url: 'remote' }))
    expect(r.conflicting).toEqual(['content'])
    expect(r.merged.url).toBe('local')
  })

  it('name/method/url/document are ONE atomic group: a name change and a document change conflict', () => {
    const r = merge('request', req(), req({ name: 'L' }), req({ document_json: '{"a":1}' }))
    expect(r.conflicting).toEqual(['content'])
  })

  it('different groups merge independently (content vs location vs order)', () => {
    const r = merge('request', req(), req({ name: 'L', sort_order: 3 }), req({ folder_id: 'f1' }))
    expect(r.conflicting).toEqual([])
    expect(r.merged).toMatchObject({ name: 'L', folder_id: 'f1', sort_order: 3 })
  })

  it('order never conflicts: remote wins silently', () => {
    const r = merge('request', req(), req({ sort_order: 5 }), req({ sort_order: 2 }))
    expect(r.conflicting).toEqual([])
    expect(r.merged.sort_order).toBe(2)
  })

  it('location conflicts (both moved to different folders)', () => {
    const r = merge('request', req(), req({ folder_id: 'a' }), req({ folder_id: 'b' }))
    expect(r.conflicting).toEqual(['location'])
    expect(r.merged.folder_id).toBe('a')
  })

  it('folders: name / location / order groups', () => {
    const f = (o = {}) => ({ collection_id: 'c', parent_folder_id: null, name: 'F', sort_order: 0, ...o })
    expect(merge('folder', f(), f({ name: 'A' }), f({ parent_folder_id: 'p' })).merged).toMatchObject({ name: 'A', parent_folder_id: 'p' })
    expect(merge('folder', f(), f({ name: 'A' }), f({ name: 'B' })).conflicting).toEqual(['name'])
  })

  it('variables: key and value groups; is_secret travels with value', () => {
    const v = (o = {}) => ({ environment_id: 'e', key: 'k', value: 'v', is_secret: false, ...o })
    expect(merge('environment_variable', v(), v({ key: 'k2' }), v({ value: 'v2' })).merged).toMatchObject({ key: 'k2', value: 'v2' })
    expect(merge('environment_variable', v(), v({ value: 'a' }), v({ value: 'b' })).conflicting).toEqual(['value'])
    expect(merge('environment_variable', v(), v({ is_secret: true, value: null }), v({ value: 'b' })).conflicting).toEqual(['value'])
  })

  it('collections and environments: name only', () => {
    expect(merge('collection', { name: 'a' }, { name: 'b' }, { name: 'c' }).conflicting).toEqual(['name'])
    expect(merge('environment', { name: 'a' }, { name: 'a' }, { name: 'c' }).merged).toEqual({ name: 'c' })
  })

  it('collection versions are immutable: never conflict', () => {
    const v = { collection_id: 'c', semver: '1.0.0', notes: null, snapshot_json: '{}', folder_count: 0, request_count: 0, created_at: 't' }
    expect(merge('collection_version', v, v, v).conflicting).toEqual([])
  })

  it('without a base every differing group conflicts (except order)', () => {
    const r = merge('request', null, req({ name: 'L', sort_order: 1 }), req({ name: 'R', sort_order: 2 }))
    expect(r.conflicting).toEqual(['content'])
    expect(r.merged.sort_order).toBe(2)
    expect(merge('request', null, req(), req()).conflicting).toEqual([])
  })

  it('key order and null vs missing do not matter for equality', () => {
    const r = merge('request', req(), { name: 'n', collection_id: 'c', folder_id: null, method: 'GET', url: 'u', document_json: '{}', sort_order: 0 }, req({ url: 'r' }))
    expect(r.conflicting).toEqual([])
    expect(r.merged.url).toBe('r')
  })
})
