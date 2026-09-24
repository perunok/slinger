import { describe, expect, it } from 'vitest'
import { compare, format, isValid, parse } from '../services/semver'

describe('parse / isValid', () => {
  it.each(['0.0.0', '1.2.3', '10.20.30', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-0.3.7', '1.0.0-x.7.z.92', '1.0.0-x-y-z', '2.0.0-beta.1', '1.0.0-1a', '1.0.0-a-1', '1.0.0-0', '1.0.0-0A', '9007199254740991.0.0'])(
    'accepts %s',
    (v) => {
      expect(isValid(v)).toBe(true)
      expect(format(parse(v)!)).toBe(v)
    },
  )

  it.each([
    '', ' ', '1', '1.2', '1.2.3.4', 'v1.2.3', 'V1.2.3', '=1.2.3', ' 1.2.3', '1.2.3 ', '1.2.3\n', '01.2.3', '1.02.3', '1.2.03', '-1.2.3', '1.-2.3', '1.2.3-', '1.2.3-.', '1.2.3-a..b', '1.2.3-a.', '1.2.3-.a', '1.2.3-01', '1.2.3-a.01', '1.2.3-a_b', '1.2.3-é',
    '1.2.3+build', '1.2.3+build.5', '1.2.3-beta+exp.sha', '1.2.3+', '1.x.3', '*', 'latest', '1.2.3-beta 1', '9007199254740992.0.0', '1e3.0.0', '1.2.3-' + 'a'.repeat(200),
  ])('rejects %j', (v) => {
    expect(isValid(v)).toBe(false)
    expect(parse(v)).toBeNull()
  })

  it('rejects non-strings', () => {
    for (const v of [null, undefined, 1, 1.2, {}, [], ['1.2.3']]) expect(isValid(v)).toBe(false)
  })

  it('exposes the parsed structure', () => {
    expect(parse('1.2.3-rc.1')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: ['rc', '1'] })
    expect(parse('4.5.6')).toEqual({ major: 4, minor: 5, patch: 6, prerelease: [] })
  })
})

describe('compare', () => {
  // The canonical precedence chain from the semver 2.0.0 spec, section 11.
  const chain = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '2.0.0', '2.1.0', '2.1.1']

  it('orders the spec example chain strictly ascending', () => {
    for (let i = 0; i < chain.length; i++) {
      for (let j = 0; j < chain.length; j++) {
        expect(compare(chain[i]!, chain[j]!), `${chain[i]} vs ${chain[j]}`).toBe(Math.sign(i - j))
      }
    }
  })

  it('compares numeric parts numerically, not lexically', () => {
    expect(compare('1.10.0', '1.9.0')).toBe(1)
    expect(compare('2.0.0', '10.0.0')).toBe(-1)
    expect(compare('1.0.10', '1.0.9')).toBe(1)
  })

  it('a release outranks its prereleases; prereleases of a higher core outrank lower releases', () => {
    expect(compare('1.0.0', '1.0.0-rc.99')).toBe(1)
    expect(compare('1.0.1-alpha', '1.0.0')).toBe(1)
  })

  it('numeric prerelease ids compare numerically, are lower than alphanumeric, and handle huge numbers exactly', () => {
    expect(compare('1.0.0-beta.2', '1.0.0-beta.11')).toBe(-1)
    expect(compare('1.0.0-1', '1.0.0-a')).toBe(-1)
    expect(compare('1.0.0-a', '1.0.0-1')).toBe(1)
    expect(compare('1.0.0-99999999999999999999', '1.0.0-99999999999999999998')).toBe(1)
    expect(compare('1.0.0-2', '1.0.0-10')).toBe(-1)
  })

  it('alphanumeric ids compare in ASCII order (uppercase before lowercase; hyphen before letters)', () => {
    expect(compare('1.0.0-B', '1.0.0-a')).toBe(-1)
    expect(compare('1.0.0-a-b', '1.0.0-ab')).toBe(-1)
    expect(compare('1.0.0-alpha', '1.0.0-beta')).toBe(-1)
  })

  it('a larger set of prerelease fields wins when all preceding fields are equal', () => {
    expect(compare('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1)
    expect(compare('1.0.0-alpha.1', '1.0.0-alpha')).toBe(1)
  })

  it('is reflexive and antisymmetric; works with parsed objects', () => {
    for (const v of chain) expect(compare(v, v)).toBe(0)
    expect(compare(parse('1.2.3')!, '1.2.4')).toBe(-1)
    expect(compare('1.2.4', parse('1.2.3')!)).toBe(1)
  })

  it('sorts a shuffled list into precedence order', () => {
    const shuffled = [...chain].sort((a, b) => (a < b ? 1 : -1))
    expect(shuffled.sort(compare)).toEqual(chain)
  })

  it('throws on invalid input', () => {
    expect(() => compare('nope', '1.0.0')).toThrow(TypeError)
    expect(() => compare('1.0.0', 'v1.0.0')).toThrow(TypeError)
  })
})
