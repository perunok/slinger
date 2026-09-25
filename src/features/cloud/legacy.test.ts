import { beforeEach, describe, expect, it } from 'vitest'
import { collectLegacy, dismissLegacyHint, parseLegacyLinks } from './legacy'
import { DEFAULT_BASE_URL, isInsecureRemote, isValidBaseUrl, normalizeBaseUrl } from './url'

const DEFAULT = { apiBaseUrl: DEFAULT_BASE_URL, deviceName: 'Slinger Desktop' }
beforeEach(() => localStorage.clear())

describe('parseLegacyLinks', () => {
  it('extracts remote names per local workspace and ignores junk', () => {
    expect(parseLegacyLinks({ 'https://a': { w1: { remoteId: 'r', remoteName: 'Team' }, w2: {}, w3: null }, bad: 5 })).toEqual([{ localWorkspaceId: 'w1', remoteName: 'Team' }])
    expect(parseLegacyLinks(null)).toEqual([])
  })
})

describe('collectLegacy', () => {
  it('moves a custom config to the main process only while that one is still default, and removes the keys', () => {
    localStorage.setItem('slinger.cloud.config', JSON.stringify({ apiBaseUrl: 'http://127.0.0.1:8080/', deviceName: 'Laptop' }))
    localStorage.setItem('slinger.cloud.links', JSON.stringify({ 'http://127.0.0.1:8080': { w1: { remoteId: 'r', remoteName: 'Team' } } }))
    const r = collectLegacy(DEFAULT)
    expect(r.config).toEqual({ apiBaseUrl: 'http://127.0.0.1:8080', deviceName: 'Laptop' })
    expect(r.hints).toEqual([{ localWorkspaceId: 'w1', remoteName: 'Team' }])
    expect(localStorage.getItem('slinger.cloud.config')).toBeNull()
    expect(localStorage.getItem('slinger.cloud.links')).toBeNull()
    expect(JSON.parse(localStorage.getItem('slinger.cloud.legacyHints')!)).toHaveLength(1)
  })
  it('does not overwrite a config the user already changed in the main process', () => {
    localStorage.setItem('slinger.cloud.config', JSON.stringify({ apiBaseUrl: 'http://old', deviceName: 'x' }))
    expect(collectLegacy({ apiBaseUrl: 'https://mine', deviceName: 'Mine' }).config).toBeNull()
    expect(localStorage.getItem('slinger.cloud.config')).toBeNull()
  })
  it('a default legacy config needs no copy; nothing stored is a no-op', () => {
    localStorage.setItem('slinger.cloud.config', JSON.stringify({ apiBaseUrl: DEFAULT_BASE_URL, deviceName: 'Slinger Desktop' }))
    expect(collectLegacy(DEFAULT).config).toBeNull()
    expect(collectLegacy(DEFAULT)).toEqual({ config: null, hints: [] })
  })
  it('hints survive restarts until dismissed', () => {
    localStorage.setItem('slinger.cloud.links', JSON.stringify({ b: { w1: { remoteName: 'A' }, w2: { remoteName: 'B' } } }))
    collectLegacy(DEFAULT)
    expect(collectLegacy(DEFAULT).hints).toHaveLength(2) // second start: read from the hint key
    dismissLegacyHint('w1')
    expect(collectLegacy(DEFAULT).hints).toEqual([{ localWorkspaceId: 'w2', remoteName: 'B' }])
    dismissLegacyHint('w2')
    expect(localStorage.getItem('slinger.cloud.legacyHints')).toBeNull()
  })
})

describe('url helpers', () => {
  it('validates and normalises', () => {
    expect(isValidBaseUrl('https://x.io')).toBe(true)
    expect(isValidBaseUrl('ftp://x')).toBe(false)
    expect(isValidBaseUrl('nope')).toBe(false)
    expect(normalizeBaseUrl(' https://x.io// ')).toBe('https://x.io')
  })
  it('warns for plain http except on loopback', () => {
    expect(isInsecureRemote('http://api.example.com')).toBe(true)
    expect(isInsecureRemote('http://localhost:8080')).toBe(false)
    expect(isInsecureRemote('http://127.0.0.1:8080')).toBe(false)
    expect(isInsecureRemote('http://[::1]:8080')).toBe(false)
    expect(isInsecureRemote('https://api.example.com')).toBe(false)
    expect(isInsecureRemote('garbage')).toBe(false)
  })
})
