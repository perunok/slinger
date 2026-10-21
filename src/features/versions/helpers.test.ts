import { describe, expect, it } from 'vitest'
import { authorLabel, compareSide, copyName, createFormState, detailByline, formatCreated, formatWhen, isPrerelease, isYou, listByline, methodColor, snapshotTree, truncate } from './helpers'

describe('helpers', () => {
  it('formats seconds as locale string', () => {
    expect(formatCreated(1700000000)).toBe(new Date(1700000000 * 1000).toLocaleString())
  })
  it('detects prerelease', () => {
    expect(isPrerelease('1.0.0-beta.1')).toBe(true)
    expect(isPrerelease('1.0.0')).toBe(false)
  })
  it('truncates', () => {
    expect(truncate('a  b\nc', 10)).toBe('a b c')
    expect(truncate('abcdefghij', 5)).toBe('abcd…')
  })
  it('method colours', () => {
    expect(methodColor('GET')).toBe('var(--m-get)')
    expect(methodColor('OPTIONS')).toBe('var(--m-other)')
  })
  it('form state', () => {
    expect(createFormState('', [])).toEqual({ valid: false, reason: null })
    expect(createFormState('v1.0.0', []).reason).toMatch(/"v"/)
    expect(createFormState('1.0.0', ['1.0.0']).reason).toMatch(/already exists/)
    expect(createFormState('1.0.1', ['1.0.0']).valid).toBe(true)
  })
  it('copy name', () => {
    expect(copyName('Demo', '1.0.0')).toBe('Demo (v1.0.0)')
  })
  it('builds a snapshot tree', () => {
    const tree = snapshotTree({
      collectionName: 'c',
      folders: [{ id: 'f', parentFolderId: null, name: 'F', sortOrder: 0 }],
      requests: [{ id: 'r', folderId: 'f', name: 'R', method: 'GET', url: '/', documentJson: '{}', sortOrder: 0 }],
    })
    expect(tree).toHaveLength(1)
    expect(tree[0].kind === 'folder' && tree[0].children).toHaveLength(1)
  })
  it('formats when relatively, then as a date after a week', () => {
    const now = 1_800_000_000
    expect(formatWhen(now - 3, now)).toBe('just now')
    expect(formatWhen(now - 30, now)).toBe('30 s ago')
    expect(formatWhen(now - 5 * 60, now)).toBe('5 min ago')
    expect(formatWhen(now - 3 * 3600, now)).toBe('3 h ago')
    expect(formatWhen(now - 4 * 86400, now)).toBe('4 d ago')
    expect(formatWhen(now - 30 * 86400, now)).toBe(new Date((now - 30 * 86400) * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }))
    expect(formatWhen(now + 100, now)).toBe('just now') // clock skew never shows a negative age
  })
  it('author labels: (you) only for a known matching id', () => {
    const ana = { id: 'u1', name: 'Ana' }
    expect(isYou(ana, 'u1')).toBe(true)
    expect(isYou(ana, 'u2')).toBe(false)
    expect(isYou(ana, null)).toBe(false)
    expect(isYou({ id: null, name: 'Ana' }, 'u1')).toBe(false)
    expect(isYou(null, 'u1')).toBe(false)
    expect(authorLabel(ana, 'u1')).toBe('Ana (you)')
    expect(authorLabel(ana, 'u2')).toBe('Ana')
    expect(authorLabel(null, 'u1')).toBeNull()
  })
  it('bylines: unknown author is date only', () => {
    const now = 1_800_000_000
    const v = { createdBy: { id: 'u1', name: 'Ana' }, createdAt: now - 7200, version: '1.0.0' }
    expect(listByline(v, 'u1', now)).toBe('Ana (you) · 2 h ago')
    expect(listByline({ ...v, createdBy: null }, 'u1', now)).toBe('2 h ago')
    expect(detailByline(v, 'u2')).toBe(`Created by Ana · ${formatCreated(v.createdAt)}`)
    expect(detailByline({ ...v, createdBy: null })).toBe(`Created · ${formatCreated(v.createdAt)}`)
    expect(compareSide(v, 'u1')).toBe(`v1.0.0 · Ana (you), ${formatCreated(v.createdAt)}`)
    expect(compareSide({ ...v, createdBy: null })).toBe(`v1.0.0 · ${formatCreated(v.createdAt)}`)
  })
})

