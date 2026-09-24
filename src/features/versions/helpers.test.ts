import { describe, expect, it } from 'vitest'
import { copyName, createFormState, formatCreated, isPrerelease, methodColor, snapshotTree, truncate } from './helpers'

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
})
