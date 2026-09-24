import { describe, expect, it } from 'vitest'
import { dataRows, newRow } from './kv'
import {
  buildUrlFromParams,
  decodeQueryPart,
  encodeQueryPart,
  mergeParamsFromUrl,
  paramsFromUrl,
  splitUrl,
} from './urlParams'

const pairs = (rows: ReturnType<typeof mergeParamsFromUrl>) =>
  dataRows(rows).map((r) => [r.key, r.value, r.enabled])

describe('splitUrl / paramsFromUrl', () => {
  it('splits base, query, hash', () => {
    expect(splitUrl('http://x/y?a=1&b=2#frag')).toEqual({ base: 'http://x/y', query: 'a=1&b=2', hash: 'frag' })
    expect(splitUrl('http://x/y')).toEqual({ base: 'http://x/y', query: null, hash: null })
  })
  it('parses pairs and decodes escapes but keeps {{vars}}', () => {
    expect(paramsFromUrl('/p?a=1&b=x%20y&c={{v}}&flag&d=')).toEqual([
      { key: 'a', value: '1' },
      { key: 'b', value: 'x y' },
      { key: 'c', value: '{{v}}' },
      { key: 'flag', value: '' },
      { key: 'd', value: '' },
    ])
  })
  it('keeps values containing =', () => {
    expect(paramsFromUrl('/p?token=a=b==')).toEqual([{ key: 'token', value: 'a=b==' }])
  })
})

describe('encode/decode', () => {
  it('encodes structural characters but not tokens', () => {
    expect(encodeQueryPart('a b&c=d#e+f')).toBe('a%20b%26c%3Dd%23e+f')
    expect(encodeQueryPart('{{a b}}')).toBe('{{a b}}')
    expect(encodeQueryPart('{{host}}/x y')).toBe('{{host}}/x%20y')
    expect(encodeQueryPart('100%')).toBe('100%25')
    expect(encodeQueryPart('already%20ok')).toBe('already%20ok')
  })
  it('decodes safely', () => {
    expect(decodeQueryPart('a%20b')).toBe('a b')
    expect(decodeQueryPart('bad%zz')).toBe('bad%zz')
    expect(decodeQueryPart('{{x%20y}}')).toBe('{{x%20y}}')
  })
})

describe('URL -> table', () => {
  it('creates rows from a typed query', () => {
    const rows = mergeParamsFromUrl('http://h/p?a=1&b=2', [])
    expect(pairs(rows)).toEqual([['a', '1', true], ['b', '2', true]])
    expect(rows.at(-1)?.key).toBe('')
  })
  it('preserves disabled rows, ids and descriptions', () => {
    const prev = [
      newRow({ key: 'a', value: '1', description: 'first' }),
      newRow({ key: 'off', value: 'x', enabled: false }),
      newRow({ key: 'b', value: '2' }),
    ]
    const next = mergeParamsFromUrl('http://h/p?a=9&b=2&c=3', prev)
    expect(pairs(next)).toEqual([['a', '9', true], ['off', 'x', false], ['b', '2', true], ['c', '3', true]])
    expect(next[0].id).toBe(prev[0].id)
    expect(next[0].description).toBe('first')
    expect(next[1].id).toBe(prev[1].id)
  })
  it('removes enabled rows that vanished from the URL, keeps disabled', () => {
    const prev = [newRow({ key: 'a', value: '1' }), newRow({ key: 'off', enabled: false, value: '1' })]
    expect(pairs(mergeParamsFromUrl('http://h/p', prev))).toEqual([['off', '1', false]])
  })
  it('handles mid-typing states without throwing', () => {
    expect(pairs(mergeParamsFromUrl('http://h/p?', []))).toEqual([])
    expect(pairs(mergeParamsFromUrl('http://h/p?a', []))).toEqual([['a', '', true]])
    expect(pairs(mergeParamsFromUrl('http://h/p?a=%', []))).toEqual([['a', '%', true]])
  })
})

describe('table -> URL', () => {
  it('rebuilds the query from enabled rows, keeping base and hash', () => {
    const rows = [newRow({ key: 'a', value: '1' }), newRow({ key: 'x', value: 'no', enabled: false }), newRow({ key: 'b c', value: 'd&e' }), newRow()]
    expect(buildUrlFromParams('http://h/p?old=1#top', rows)).toBe('http://h/p?a=1&b%20c=d%26e#top')
  })
  it('drops the ? when nothing is enabled, keeps {{vars}}', () => {
    expect(buildUrlFromParams('{{base}}/p?a=1', [newRow({ key: 'a', enabled: false })])).toBe('{{base}}/p')
    expect(buildUrlFromParams('{{base}}/p', [newRow({ key: 'id', value: '{{userId}}' })])).toBe('{{base}}/p?id={{userId}}')
  })
  it('round-trips in both directions', () => {
    const url = 'https://{{host}}/v1/items?limit=10&q=hello%20world&tag={{tag}}&flag='
    const rows = mergeParamsFromUrl(url, [])
    expect(buildUrlFromParams(url, rows)).toBe(url)
    const rows2 = mergeParamsFromUrl(buildUrlFromParams(url, rows), rows)
    expect(pairs(rows2)).toEqual(pairs(rows))
  })
})
