import { describe, expect, it } from 'vitest'
import { diffBulk, duplicateKeys, findDuplicates, newRow, parseBulk, rowIssue, serializeBulk, summarizeStatus, validateKey, valueToSend } from './envLogic'

const row = (key: string, value = '', extra = {}) => newRow('e1', { key, value, ...extra })

describe('validateKey', () => {
  it.each(['a', 'baseUrl', '_x', 'a.b-c_1'])('accepts %s', (k) => expect(validateKey(k)).toBeNull())
  it('rejects empty, $, spaces, leading digit and odd characters', () => {
    expect(validateKey('')).toMatch(/required/)
    expect(validateKey('$guid')).toMatch(/reserved/)
    expect(validateKey('a b')).toMatch(/spaces/)
    expect(validateKey('1a')).toMatch(/start/)
    expect(validateKey('a/b')).toMatch(/letters/)
  })
})

describe('duplicates', () => {
  it('is exact and case sensitive, ignores blanks and deleted rows', () => {
    const a = row('a'), b = row('a'), c = row('A'), d = row(''), e = row(''), f = row('a', '', { deleted: true })
    expect(findDuplicates([a, b, c, d, e, f])).toEqual(new Set([a.rid, b.rid]))
    expect(duplicateKeys([a, b, c])).toEqual(['a'])
  })
})

describe('rowIssue', () => {
  it('flags value without key, duplicates, and secret->plain without a value', () => {
    expect(rowIssue(row('', 'x'), new Set())).toMatch(/required/)
    expect(rowIssue(row(''), new Set())).toBeNull()
    const d = row('a')
    expect(rowIssue(d, new Set([d.rid]))).toMatch(/Duplicate/)
    expect(rowIssue(row('s', '', { serverSecret: true, isSecret: false }), new Set())).toMatch(/plain/)
    expect(rowIssue(row('s', 'v', { serverSecret: true, isSecret: false }), new Set())).toBeNull()
  })
})

describe('valueToSend', () => {
  it('keeps unchanged stored secrets via empty value', () => {
    expect(valueToSend(row('s', '', { isSecret: true, serverSecret: true }))).toBe('')
    expect(valueToSend(row('s', 'new', { isSecret: true, serverSecret: true, secretTouched: true }))).toBe('new')
    expect(valueToSend(row('p', 'v'))).toBe('v')
  })
})

describe('bulk', () => {
  it('parses key=value, ignores comments/blank, keeps = in values, reports bad lines', () => {
    const p = parseBulk('# c\n\na = 1\nb=x=y\r\nnoequals\n$bad=1')
    expect(p.entries.map((e) => [e.key, e.value])).toEqual([['a', '1'], ['b', 'x=y']])
    expect(p.errors.map((e) => e.line)).toEqual([5, 6])
  })
  it('never serialises secrets or multi-line values', () => {
    const rows = [row('a', '1'), row('s', '', { isSecret: true, serverSecret: true }), row('m', 'l1\nl2'), row('')]
    expect(serializeBulk(rows)).toBe('a=1')
  })
  it('diffs into update/create/remove and leaves secrets alone', () => {
    const a = row('a', '1'), b = row('b', '2'), s = row('s', '', { isSecret: true, serverSecret: true })
    const d = diffBulk([a, b, s], parseBulk('a=9\nc=3').entries)
    expect(d).toEqual({ update: [{ rid: a.rid, value: '9' }], create: [{ key: 'c', value: '3' }], remove: [b.rid] })
  })
})

describe('summarizeStatus', () => {
  it('prioritises error > saving > unsaved > saved', () => {
    expect(summarizeStatus({ dirty: 1, saving: 1, errors: 1, blocked: 0 }).label).toBe('Error — retry')
    expect(summarizeStatus({ dirty: 1, saving: 1, errors: 0, blocked: 0 }).label).toBe('Saving…')
    expect(summarizeStatus({ dirty: 1, saving: 0, errors: 0, blocked: 1 }).label).toBe('2 unsaved changes')
    expect(summarizeStatus({ dirty: 1, saving: 0, errors: 0, blocked: 0 }).label).toBe('1 unsaved change')
    expect(summarizeStatus({ dirty: 0, saving: 0, errors: 0, blocked: 0 }).label).toBe('All changes saved')
  })
})
