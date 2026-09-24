import { describe, expect, it } from 'vitest'
import {
  dataRows,
  ensureTrailingEmpty,
  findDuplicateKeys,
  isDuplicate,
  moveRow,
  newRow,
  parseBulk,
  removeRow,
  serializeBulk,
  updateRow,
} from './kv'

describe('ensureTrailingEmpty', () => {
  it('adds a blank row to empty and filled lists', () => {
    expect(ensureTrailingEmpty([])).toHaveLength(1)
    const rows = ensureTrailingEmpty([newRow({ key: 'a' })])
    expect(rows).toHaveLength(2)
    expect(rows[1].key).toBe('')
  })
  it('does not stack multiple blanks, and never removes filled rows', () => {
    const rows = ensureTrailingEmpty([newRow({ key: 'a' }), newRow(), newRow(), newRow()])
    expect(rows).toHaveLength(2)
    const filled = [newRow({ key: 'a' }), newRow(), newRow({ value: 'x' }), newRow()]
    expect(ensureTrailingEmpty(filled)).toHaveLength(4)
  })
  it('keeps row identity (ids) so focus is retained', () => {
    const a = newRow({ key: 'a' })
    const next = ensureTrailingEmpty(updateRow([a], a.id, { value: '1' }))
    expect(next[0].id).toBe(a.id)
  })
})

describe('row ops', () => {
  it('removes and keeps a trailing blank', () => {
    const a = newRow({ key: 'a' })
    const out = removeRow([a, newRow()], a.id)
    expect(out).toHaveLength(1)
    expect(out[0].key).toBe('')
  })
  it('moves rows', () => {
    const [a, b, c] = ['a', 'b', 'c'].map((k) => newRow({ key: k }))
    expect(moveRow([a, b, c], 0, 2).map((r) => r.key)).toEqual(['b', 'c', 'a'])
    expect(moveRow([a, b, c], 5, 0)).toHaveLength(3)
  })
})

describe('duplicates', () => {
  const rows = [newRow({ key: 'Accept' }), newRow({ key: 'accept' }), newRow({ key: 'X', enabled: false }), newRow({ key: 'X' })]
  it('is case sensitive by default and insensitive for headers', () => {
    expect(findDuplicateKeys(rows).size).toBe(0)
    const dups = findDuplicateKeys(rows, true)
    expect([...dups]).toEqual(['accept'])
    expect(isDuplicate(rows[0], dups, true)).toBe(true)
    expect(isDuplicate(rows[3], dups, true)).toBe(false)
  })
})

describe('bulk edit', () => {
  it('serialises with disabled prefix and parses back', () => {
    const rows = [newRow({ key: 'a', value: '1' }), newRow({ key: 'b', value: 'x:y', enabled: false }), newRow()]
    const text = serializeBulk(rows)
    expect(text).toBe('a: 1\n//b: x:y')
    const back = parseBulk(text, rows)
    expect(dataRows(back).map((r) => [r.key, r.value, r.enabled])).toEqual([
      ['a', '1', true],
      ['b', 'x:y', false],
    ])
    expect(back[0].id).toBe(rows[0].id)
    expect(back.at(-1)?.key).toBe('')
  })
  it('handles keys without value, blank lines and CRLF', () => {
    const rows = dataRows(parseBulk('flag\r\n\r\n# off: 1\r\nk:v', []))
    expect(rows.map((r) => [r.key, r.value, r.enabled])).toEqual([
      ['flag', '', true],
      ['off', '1', false],
      ['k', 'v', true],
    ])
  })
})
