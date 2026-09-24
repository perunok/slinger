/** Semantic Versioning 2.0.0 (without build metadata, which Slinger rejects). */

export interface SemVer {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

const IDENT = '(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)'
const SEMVER_RE = new RegExp(`^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${IDENT}(?:\\.${IDENT})*))?$`)

export function parseSemver(text: string): SemVer | null {
  const m = SEMVER_RE.exec(text)
  if (!m) return null
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (![major, minor, patch].every(Number.isSafeInteger)) return null
  return { major, minor, patch, prerelease: m[4] ? m[4].split('.') : [] }
}

export function formatVersion(v: SemVer): string {
  const core = `${v.major}.${v.minor}.${v.patch}`
  return v.prerelease.length > 0 ? `${core}-${v.prerelease.join('.')}` : core
}

function toSemver(v: string | SemVer): SemVer {
  if (typeof v !== 'string') return v
  const parsed = parseSemver(v)
  if (!parsed) throw new Error(`Invalid semantic version: ${v}`)
  return parsed
}

const isNumeric = (s: string) => /^\d+$/.test(s)

/** Precedence per semver 2.0.0 section 11. Throws on an unparsable string. */
export function compareSemver(a: string | SemVer, b: string | SemVer): number {
  const x = toSemver(a)
  const y = toSemver(b)
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1
  }
  const px = x.prerelease
  const py = y.prerelease
  if (px.length === 0 && py.length === 0) return 0
  if (px.length === 0) return 1
  if (py.length === 0) return -1
  const n = Math.min(px.length, py.length)
  for (let i = 0; i < n; i++) {
    const p = px[i]
    const q = py[i]
    if (p === q) continue
    const pn = isNumeric(p)
    const qn = isNumeric(q)
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1
    if (pn) return -1
    if (qn) return 1
    return p < q ? -1 : 1
  }
  if (px.length === py.length) return 0
  return px.length < py.length ? -1 : 1
}

/** Highest first. Items with an unparsable version sort last. */
export function sortVersionsDesc<T extends { version: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const pa = parseSemver(a.version)
    const pb = parseSemver(b.version)
    if (!pa && !pb) return 0
    if (!pa) return 1
    if (!pb) return -1
    return compareSemver(pb, pa)
  })
}

export function validateVersion(text: string, existing: string[]): { ok: true } | { ok: false; reason: string } {
  if (text.trim() === '') return { ok: false, reason: 'Version is required.' }
  if (/^\s|\s$/.test(text)) return { ok: false, reason: 'Version must not contain leading or trailing spaces.' }
  if (/^[vV]/.test(text)) return { ok: false, reason: 'Do not prefix the version with "v" (use 1.2.3, not v1.2.3).' }
  if (text.includes('+')) return { ok: false, reason: 'Build metadata (+...) is not supported.' }
  const parsed = parseSemver(text)
  if (!parsed) {
    if (/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(text)) {
      return { ok: false, reason: 'Numbers must not have leading zeros and pre-release identifiers must not be empty.' }
    }
    return { ok: false, reason: 'Use the format MAJOR.MINOR.PATCH, optionally followed by -prerelease (e.g. 1.2.0 or 2.0.0-beta.1).' }
  }
  for (const e of existing) {
    const p = parseSemver(e)
    if (p && compareSemver(p, parsed) === 0) return { ok: false, reason: `Version ${e} already exists.` }
  }
  return { ok: true }
}

/** Highest non-prerelease version (original string), or null. */
export function latestRelease(versions: string[]): string | null {
  let best: { text: string; v: SemVer } | null = null
  for (const text of versions) {
    const v = parseSemver(text)
    if (!v || v.prerelease.length > 0) continue
    if (!best || compareSemver(v, best.v) > 0) best = { text, v }
  }
  return best?.text ?? null
}

/** null (or unparsable) latest => 0.0.1 / 0.1.0 / 1.0.0. Any prerelease part is dropped. */
export function bumpVersion(latest: string | null, kind: 'patch' | 'minor' | 'major'): string {
  const v = latest ? parseSemver(latest) : null
  if (!v) return kind === 'patch' ? '0.0.1' : kind === 'minor' ? '0.1.0' : '1.0.0'
  if (kind === 'major') return `${v.major + 1}.0.0`
  if (kind === 'minor') return `${v.major}.${v.minor + 1}.0`
  return `${v.major}.${v.minor}.${v.patch + 1}`
}

/** Next patch/minor/major from the latest release, bumping again while a suggestion already exists. */
export function suggestBumps(versions: string[]): { patch: string; minor: string; major: string } {
  const latest = latestRelease(versions)
  const taken = versions.map(parseSemver).filter((v): v is SemVer => v !== null)
  const pick = (kind: 'patch' | 'minor' | 'major'): string => {
    let candidate = bumpVersion(latest, kind)
    for (let i = 0; i < 1000; i++) {
      const c = parseSemver(candidate)!
      if (!taken.some((t) => compareSemver(t, c) === 0)) break
      candidate = bumpVersion(candidate, kind)
    }
    return candidate
  }
  return { patch: pick('patch'), minor: pick('minor'), major: pick('major') }
}
