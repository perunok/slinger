import { describe, expect, it } from 'vitest'
import type { SyncConflictGroup } from '../../../shared/types'
import { buildGroupDiffs, conflictingGroups, displayValue, lineDiff, parseRequestContent } from './conflictDiff'

const doc = (o: Record<string, unknown>) => JSON.stringify(o)
const content = (name: string, url: string, extra: Record<string, unknown> = {}, method = 'GET') =>
  JSON.stringify({ name, method, url, document_json: doc({ name, method, url, headers: [{ key: 'Accept', value: 'application/json' }], ...extra }) })
const group = (g: Partial<SyncConflictGroup>): SyncConflictGroup => ({ group: 'content', label: 'Request content', conflicting: true, base: null, local: null, remote: null, ...g })

describe('lineDiff', () => {
  it('marks added and removed lines and keeps common ones', () => {
    const { left, right } = lineDiff('a\nb\nc', 'a\nx\nc')
    expect(left.map((l) => l.op)).toEqual(['same', 'del', 'same'])
    expect(right.map((l) => l.op)).toEqual(['same', 'add', 'same'])
    expect(right[1].text).toBe('x')
  })
  it('handles empty sides and pure additions', () => {
    expect(lineDiff('', 'a\nb').right.every((l) => l.op === 'add')).toBe(true)
    expect(lineDiff('a', '').left).toEqual([{ op: 'del', text: 'a' }])
    expect(lineDiff('', '')).toEqual({ left: [], right: [] })
  })
  it('falls back to all-different for huge inputs', () => {
    const big = Array.from({ length: 600 }, (_, i) => `l${i}`).join('\n')
    const other = Array.from({ length: 600 }, (_, i) => `m${i}`).join('\n')
    expect(lineDiff(big, other).left.every((l) => l.op === 'del')).toBe(true)
  })
})

describe('parseRequestContent', () => {
  it('reads wire fields and a bare document', () => {
    expect(parseRequestContent(content('A', 'u'))).toMatchObject({ name: 'A', method: 'GET', url: 'u' })
    expect(parseRequestContent(doc({ name: 'B', method: 'POST', url: 'v', body: null }))).toMatchObject({ name: 'B', method: 'POST', url: 'v' })
    expect(parseRequestContent(null)).toBeNull()
    expect(parseRequestContent('not json')).toBeNull()
    expect(parseRequestContent('42')).toBeNull()
    expect(parseRequestContent('{"foo":1}')).toBeNull()
  })
})

describe('buildGroupDiffs', () => {
  it('request content: name/method/url always shown, headers/body/auth as context, only differences flagged', () => {
    const local = content('Get user', 'https://mine/x')
    const remote = content('Get user', 'https://theirs/x')
    const [g] = buildGroupDiffs({ entityType: 'request', groups: [group({ local, remote })] })
    expect(g.conflicting).toBe(true)
    const byKey = Object.fromEntries(g.rows.map((r) => [r.key, r]))
    expect(byKey.url).toMatchObject({ changed: true, local: 'https://mine/x', remote: 'https://theirs/x' })
    expect(byKey.name.changed).toBe(false)
    expect(byKey.method.changed).toBe(false)
    expect(byKey.headers.changed).toBe(false)
    expect(byKey.description).toBeUndefined()
  })
  it('detects header, body and auth differences (multi-line values get line diffs)', () => {
    const local = content('R', 'u', { headers: [{ key: 'A', value: '1' }, { key: 'B', value: '2' }], body: { mode: 'raw', raw: '{"a":1}' }, auth: { type: 'bearer', bearer: [{ key: 'token', value: 'x' }] } }, 'POST')
    const remote = content('R', 'u', { headers: [{ key: 'A', value: '1' }], body: { mode: 'raw', raw: '{"a":2}' }, auth: { type: 'bearer', bearer: [{ key: 'token', value: 'y' }] } }, 'PUT')
    const rows = buildGroupDiffs({ entityType: 'request', groups: [group({ local, remote })] })[0].rows
    const changed = rows.filter((r) => r.changed).map((r) => r.key).sort()
    expect(changed).toEqual(['auth', 'body', 'headers', 'method'])
    const headers = rows.find((r) => r.key === 'headers')!
    expect(headers.localLines?.some((l) => l.op === 'del' && l.text.includes('B: 2'))).toBe(true)
    expect(rows.find((r) => r.key === 'body')!.local).toContain('{"a":1}')
  })
  it('a deleted side shows null for every field', () => {
    const rows = buildGroupDiffs({ entityType: 'request', groups: [group({ local: content('Gone', 'u'), remote: null })] })[0].rows
    expect(rows.every((r) => r.remote === null && r.changed)).toBe(true)
    expect(rows.find((r) => r.key === 'name')!.local).toBe('Gone')
  })
  it('unparseable content and other groups fall back to one text row', () => {
    const g = buildGroupDiffs({
      entityType: 'request',
      groups: [group({ local: 'plain a', remote: 'plain b' }), group({ group: 'name', label: 'Name', local: 'Mine', remote: 'Theirs' }), group({ group: 'order', label: 'Order', conflicting: false, local: 'position 1', remote: 'position 1' })],
    })
    expect(g[0].rows).toHaveLength(1)
    expect(g[0].rows[0]).toMatchObject({ changed: true, local: 'plain a', remote: 'plain b' })
    expect(g[1].rows[0]).toMatchObject({ label: 'Name', changed: true })
    expect(g[2].rows[0].changed).toBe(false)
  })
  it('non-request entities never try to parse content', () => {
    const rows = buildGroupDiffs({ entityType: 'collection', groups: [group({ group: 'name', label: 'Name', local: '{"name":"x"}', remote: '{"name":"y"}' })] })[0].rows
    expect(rows[0].local).toBe('{"name":"x"}')
  })
  it('lists conflicting groups and formats deleted/empty values', () => {
    const groups = [group({ group: 'name', conflicting: true }), group({ group: 'order', conflicting: false })]
    expect(conflictingGroups({ groups })).toEqual(['name'])
    expect(displayValue(null, '(gone)')).toBe('(gone)')
    expect(displayValue('', '(gone)')).toBe('(empty)')
    expect(displayValue('x', '(gone)')).toBe('x')
  })
})
