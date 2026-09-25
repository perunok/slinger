/**
 * Strict Semantic Versioning 2.0.0 for collection version labels.
 *
 * Accepted: MAJOR.MINOR.PATCH with an optional -PRERELEASE (dot separated identifiers).
 * Rejected: a leading "v", leading zeros in numeric parts, empty identifiers, and build
 * metadata ("+build"), which Slinger does not allow because it never affects precedence and
 * would let two labels for the "same" version coexist.
 */

export interface SemVer {
  major: number
  minor: number
  patch: number
  /** Dot-separated identifiers; numeric identifiers are kept as strings without leading zeros. */
  prerelease: string[]
}

const IDENT = String.raw`(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)`
const RE = new RegExp(
  String.raw`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(${IDENT}(?:\.${IDENT})*))?$`,
)
const MAX_LENGTH = 128

export function parse(input: unknown): SemVer | null {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_LENGTH) return null
  const m = RE.exec(input)
  if (!m) return null
  const major = Number(m[1])
  const minor = Number(m[2])
  const patch = Number(m[3])
  if (![major, minor, patch].every(Number.isSafeInteger)) return null
  return { major, minor, patch, prerelease: m[4] ? m[4].split('.') : [] }
}

export const isValid = (input: unknown): boolean => parse(input) !== null

const isNumeric = (id: string) => /^\d+$/.test(id)

function compareIdentifiers(a: string, b: string): number {
  const an = isNumeric(a)
  const bn = isNumeric(b)
  if (an && bn) {
    // No leading zeros, so longer means larger; exact for arbitrarily large numbers.
    if (a.length !== b.length) return a.length < b.length ? -1 : 1
    return a === b ? 0 : a < b ? -1 : 1
  }
  if (an) return -1 // numeric identifiers have lower precedence than alphanumeric ones
  if (bn) return 1
  return a === b ? 0 : a < b ? -1 : 1 // ASCII order
}

/** Precedence comparison (semver 2.0.0 section 11). Returns -1, 0 or 1. Throws on invalid input. */
export function compare(a: string | SemVer, b: string | SemVer): -1 | 0 | 1 {
  const x = typeof a === 'string' ? parse(a) : a
  const y = typeof b === 'string' ? parse(b) : b
  if (!x || !y) throw new TypeError('invalid semver')
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (x[key] !== y[key]) return x[key] < y[key] ? -1 : 1
  }
  if (x.prerelease.length === 0 && y.prerelease.length === 0) return 0
  if (x.prerelease.length === 0) return 1 // a release outranks its pre-releases
  if (y.prerelease.length === 0) return -1
  const n = Math.min(x.prerelease.length, y.prerelease.length)
  for (let i = 0; i < n; i++) {
    const c = compareIdentifiers(x.prerelease[i]!, y.prerelease[i]!)
    if (c !== 0) return c < 0 ? -1 : 1
  }
  if (x.prerelease.length === y.prerelease.length) return 0
  return x.prerelease.length < y.prerelease.length ? -1 : 1
}

export const format = (v: SemVer): string =>
  `${v.major}.${v.minor}.${v.patch}${v.prerelease.length ? `-${v.prerelease.join('.')}` : ''}`
