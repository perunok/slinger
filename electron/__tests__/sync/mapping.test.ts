import { describe, expect, it } from 'vitest'
import { canonicalJson, checkLimits, toWire, type AnyRow } from '../../sync/mapping'

describe('wire mapping', () => {
  it('maps every entity type to its documented payload', () => {
    expect(toWire('collection', { name: 'C' } as AnyRow)).toEqual({ name: 'C' })
    expect(toWire('environment', { name: 'E' } as AnyRow)).toEqual({ name: 'E' })
    expect(toWire('folder', { collection_id: 'c', parent_folder_id: null, name: 'F', sort_order: 2 } as AnyRow)).toEqual({ collection_id: 'c', parent_folder_id: null, name: 'F', sort_order: 2 })
    expect(toWire('request', { collection_id: 'c', folder_id: 'f', name: 'R', method: 'GET', url: 'u', document_json: '{}', sort_order: 1 } as AnyRow)).toEqual({
      collection_id: 'c', folder_id: 'f', name: 'R', method: 'GET', url: 'u', document_json: '{}', sort_order: 1,
    })
    expect(toWire('collection_version', { collection_id: 'c', version: '1.2.3', notes: null, snapshot_json: '{}', folder_count: 1, request_count: 2, created_at: 86400 } as AnyRow)).toEqual({
      collection_id: 'c', semver: '1.2.3', notes: null, snapshot_json: '{}', folder_count: 1, request_count: 2, created_at: '1970-01-02T00:00:00.000Z',
    })
  })

  it('a secret variable NEVER carries a value, whatever the row holds', () => {
    const secret = toWire('environment_variable', { environment_id: 'e', key: 'k', value: 'leaked?', is_secret: 1 } as AnyRow)
    expect(secret).toEqual({ environment_id: 'e', key: 'k', value: null, is_secret: true })
    expect(toWire('environment_variable', { environment_id: 'e', key: 'k', value: null, is_secret: 0 } as AnyRow).value).toBe('')
  })

  it('canonicalJson sorts keys recursively and keeps null', () => {
    expect(canonicalJson({ b: 1, a: { d: null, c: [{ z: 1, y: 2 }] } })).toBe('{"a":{"c":[{"y":2,"z":1}],"d":null},"b":1}')
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }))
  })

  it('limits: name, document, variable key/value, snapshot', () => {
    expect(checkLimits('collection', { name: 'x'.repeat(200) })).toBeNull()
    expect(checkLimits('collection', { name: 'x'.repeat(201) })).toMatch(/200/)
    expect(checkLimits('request', { name: 'r', document_json: 'x'.repeat(900_000) })).toBeNull()
    expect(checkLimits('request', { name: 'r', document_json: 'x'.repeat(900_001) })).toMatch(/KB/)
    expect(checkLimits('request', { name: 'r', document_json: 'é'.repeat(450_001) })).toMatch(/KB/) // bytes, not characters
    expect(checkLimits('environment_variable', { key: 'ok_key.1-a', value: 'v', is_secret: false })).toBeNull()
    expect(checkLimits('environment_variable', { key: '1bad', value: 'v', is_secret: false })).toMatch(/not accepted/)
    expect(checkLimits('environment_variable', { key: 'k'.repeat(129), value: 'v', is_secret: false })).toMatch(/not accepted/)
    expect(checkLimits('environment_variable', { key: 'k', value: 'v'.repeat(65_537), is_secret: false })).toMatch(/65536/)
    expect(checkLimits('collection_version', { snapshot_json: 'x'.repeat(8 * 1024 * 1024 + 1) })).toMatch(/8 MB/)
  })
})
