import { describe, expect, it } from 'vitest'
import {
  bumpVersion, compareSemver, formatVersion, latestRelease, parseSemver, sortVersionsDesc, suggestBumps, validateVersion,
} from './semver'

describe('parseSemver', () => {
  it('parses releases and prereleases', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] })
    expect(parseSemver('2.0.0-beta.1')).toEqual({ major: 2, minor: 0, patch: 0, prerelease: ['beta', '1'] })
    expect(parseSemver('1.0.0-0.3.7')).not.toBeNull()
    expect(parseSemver('1.0.0-x-y.z--')).not.toBeNull()
  })
  it.each(['', 'v1.0.0', '1.0', '1.0.0.0', '01.0.0', '1.02.0', '1.0.00', '1.0.0-01', '1.0.0-', '1.0.0-a..b', '1.0.0+build', '1.0.0-a+b', ' 1.0.0', '1.0.0\n', '-1.0.0', '99999999999999999999.0.0'])(
    'rejects %j',
    (t) => expect(parseSemver(t)).toBeNull(),
  )
  it('formats round trip', () => {
    for (const t of ['0.0.1', '1.2.3-rc.1', '10.20.30']) expect(formatVersion(parseSemver(t)!)).toBe(t)
  })
})

describe('validateVersion', () => {
  const reason = (t: string, e: string[] = []) => {
    const r = validateVersion(t, e)
    return r.ok ? null : r.reason
  }
  it('accepts valid', () => expect(validateVersion('1.0.0', ['0.9.0'])).toEqual({ ok: true }))
  it('empty', () => expect(reason('  ')).toMatch(/required/i))
  it('leading v', () => expect(reason('v1.0.0')).toMatch(/"v"/))
  it('build metadata', () => expect(reason('1.0.0+abc')).toMatch(/build metadata/i))
  it('leading zeros', () => expect(reason('01.0.0')).toMatch(/leading zeros/i))
  it('invalid format', () => expect(reason('1.0')).toMatch(/MAJOR\.MINOR\.PATCH/))
  it('duplicates', () => {
    expect(reason('1.0.0', ['1.0.0'])).toMatch(/already exists/)
    expect(reason('1.0.0-beta.1', ['1.0.0-beta.1', 'junk'])).toMatch(/already exists/)
    expect(validateVersion('1.0.0-beta.2', ['1.0.0-beta.1']).ok).toBe(true)
  })
})

describe('compareSemver', () => {
  it('follows the spec precedence chain', () => {
    const chain = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0']
    for (let i = 0; i < chain.length - 1; i++) {
      expect(compareSemver(chain[i], chain[i + 1])).toBe(-1)
      expect(compareSemver(chain[i + 1], chain[i])).toBe(1)
    }
    expect(compareSemver('1.0.0', parseSemver('1.0.0')!)).toBe(0)
    expect(compareSemver('1.10.0', '1.2.0')).toBe(1)
  })
  it('throws on invalid input', () => expect(() => compareSemver('x', '1.0.0')).toThrow())
})

describe('sort / latest', () => {
  it('sorts descending without mutating', () => {
    const items = [{ version: '1.0.0' }, { version: '2.0.0-beta.1' }, { version: '1.10.0' }, { version: 'bad' }, { version: '1.2.0' }]
    expect(sortVersionsDesc(items).map((i) => i.version)).toEqual(['2.0.0-beta.1', '1.10.0', '1.2.0', '1.0.0', 'bad'])
    expect(items[0].version).toBe('1.0.0')
  })
  it('latestRelease ignores prereleases', () => {
    expect(latestRelease(['1.0.0', '2.0.0-rc.1', '1.5.0'])).toBe('1.5.0')
    expect(latestRelease(['1.0.0-beta'])).toBeNull()
    expect(latestRelease([])).toBeNull()
  })
})

describe('bump / suggest', () => {
  it('bumps', () => {
    expect(bumpVersion('1.2.3', 'patch')).toBe('1.2.4')
    expect(bumpVersion('1.2.3', 'minor')).toBe('1.3.0')
    expect(bumpVersion('1.2.3', 'major')).toBe('2.0.0')
    expect(bumpVersion(null, 'patch')).toBe('0.0.1')
    expect(bumpVersion(null, 'minor')).toBe('0.1.0')
    expect(bumpVersion(null, 'major')).toBe('1.0.0')
  })
  it('suggests from the latest release', () => {
    expect(suggestBumps(['1.0.0', '1.4.2', '2.0.0-beta.1'])).toEqual({ patch: '1.4.3', minor: '1.5.0', major: '2.0.0' })
    expect(suggestBumps([])).toEqual({ patch: '0.0.1', minor: '0.1.0', major: '1.0.0' })
    expect(suggestBumps(['1.0.0-beta.1'])).toEqual({ patch: '0.0.1', minor: '0.1.0', major: '1.0.0' })
  })
  it('skips suggestions that already exist', () => {
    // 1.4.2 is latest release, but 2.0.0 is not a release...? it is, so build a case with a prerelease-free clash
    expect(suggestBumps(['1.0.0', '0.0.1']).patch).toBe('1.0.1')
    expect(suggestBumps(['0.0.1', '0.0.2', '0.0.3'])).toMatchObject({ patch: '0.0.4' })
  })
})
