/**
 * Postman-style path variables: a whole path segment `:name` in a request URL (`{{baseUrl}}/pets/:petId`) is replaced
 * at send time by the value of the request's path variable `name` (Postman's `url.variable`).
 *
 * Only whole segments of the path count: not the host or port (`localhost:3000`), not `::x`, not the query or hash,
 * not text inside `{{ }}`. The URL is the source of truth for which variables exist; the request keeps a value and a
 * description per name (`RequestDraft.pathVariables`, document key `pathVariables`).
 */
import { mapOutsideTokens, splitUrl } from './urlParams'

export interface PathVariable {
  key: string
  /** May contain `{{variables}}`. */
  value: string
  description: string
}

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//

/** Index in `base` (the URL without query and hash) where the path starts, or -1 when there is none. */
function pathStart(base: string): number {
  const scheme = SCHEME.exec(base)
  return base.indexOf('/', scheme ? scheme[0].length : 0)
}

/** The variable name of a path segment, or null when it is not `:name`. */
function segmentName(segment: string): string | null {
  if (segment.length < 2 || segment[0] !== ':' || segment[1] === ':') return null
  if (segment.includes('{{') || segment.includes('}}')) return null
  return segment.slice(1)
}

/** Path segments of a URL as [start, end) ranges with their variable name (null for ordinary segments). */
function pathSegments(url: string): { base: string; rest: string; segments: Array<{ start: number; end: number; name: string | null }> } {
  const { base } = splitUrl(url)
  const rest = url.slice(base.length)
  const start = pathStart(base)
  const segments: Array<{ start: number; end: number; name: string | null }> = []
  if (start < 0) return { base, rest, segments }
  let i = start + 1
  while (i <= base.length) {
    let end = base.indexOf('/', i)
    if (end < 0) end = base.length
    segments.push({ start: i, end, name: segmentName(base.slice(i, end)) })
    i = end + 1
  }
  return { base, rest, segments }
}

/** The path variable names in a URL, each once, in order of appearance. */
export function pathVariableNames(url: string): string[] {
  const names: string[] = []
  for (const s of pathSegments(url).segments) if (s.name !== null && !names.includes(s.name)) names.push(s.name)
  return names
}

/**
 * The path variable rows for a URL: one per `:name` in it, keeping the value and description of an existing row with
 * the same key (rows whose name left the URL are dropped, as in Postman).
 */
export function mergePathVariables(url: string, previous: readonly PathVariable[]): PathVariable[] {
  const prev = new Map<string, PathVariable>()
  for (const v of previous) if (!prev.has(v.key)) prev.set(v.key, v)
  return pathVariableNames(url).map((key) => {
    const p = prev.get(key)
    return { key, value: p?.value ?? '', description: p?.description ?? '' }
  })
}

/** Percent-encodes what cannot stand in a path segment; valid `%XX` escapes are kept (so encoding twice is harmless). */
export function encodePathSegment(text: string): string {
  return mapOutsideTokens(text, (part) =>
    part.replace(/%(?![0-9A-Fa-f]{2})|[/?#[\]@ "<>\\^`{|}\u0000-\u001f\u007f-\u{10ffff}]/gu, (ch) => {
      if (ch === '%') return '%25'
      try {
        return encodeURIComponent(ch)
      } catch {
        return '%EF%BF%BD'
      }
    }),
  )
}

export interface AppliedPathVariables {
  url: string
  /** Names in the URL without a (non-empty) value; their segments stay `:name`. */
  missing: string[]
}

/**
 * Replaces every `:name` segment of `url` with `resolve(value)`, percent-encoded (`{{tokens}}` left in the resolved
 * value stay as they are, so unresolved variables are still reported). Names without a value keep `:name`.
 */
export function applyPathVariables(url: string, variables: readonly PathVariable[], resolve: (text: string) => string): AppliedPathVariables {
  const { base, rest, segments } = pathSegments(url)
  const values = new Map<string, string>()
  for (const v of variables) if (!values.has(v.key)) values.set(v.key, v.value)
  const missing: string[] = []
  const resolved = new Map<string, string | null>()
  let out = ''
  let last = 0
  for (const s of segments) {
    if (s.name === null) continue
    if (!resolved.has(s.name)) {
      const raw = values.get(s.name) ?? ''
      const value = raw === '' ? '' : resolve(raw)
      resolved.set(s.name, value === '' ? null : encodePathSegment(value))
      if (value === '') missing.push(s.name)
    }
    const value = resolved.get(s.name)
    if (value === null || value === undefined) continue
    out += base.slice(last, s.start) + value
    last = s.end
  }
  return { url: out + base.slice(last) + rest, missing }
}

/** The send-outcome warning for path variables left without a value. */
export const missingPathVariablesWarning = (names: string[]): string =>
  `Path variable${names.length > 1 ? 's' : ''} ${names.map((n) => `:${n}`).join(', ')} ${names.length > 1 ? 'have' : 'has'} no value; ` +
  `sent as written. Set ${names.length > 1 ? 'them' : 'it'} under Params > Path Variables.`
