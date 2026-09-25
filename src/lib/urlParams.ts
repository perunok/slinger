/**
 * URL <-> query-parameter table synchronisation.
 *
 * The URL string is the source of truth for *enabled* params; the table adds
 * disabled rows, descriptions and stable ids on top. `{{vars}}` are never
 * percent-encoded or decoded.
 */
import { ensureTrailingEmpty, isEmptyRow, newRow, type KvRow } from './kv'

const TOKEN_SPLIT = /(\{\{[^{}]*\}\})/

/** Applies `fn` to the non-template parts only. */
function mapOutsideTokens(text: string, fn: (part: string) => string): string {
  return text
    .split(TOKEN_SPLIT)
    .map((part, i) => (i % 2 === 1 ? part : fn(part)))
    .join('')
}

/**
 * Encodes a key/value so it cannot break the query structure. Idempotent for already-valid
 * escapes. `+` is left alone on purpose: parsing does not turn it into a space either, so the
 * URL text round-trips exactly.
 */
export function encodeQueryPart(text: string): string {
  return mapOutsideTokens(text, (part) =>
    part.replace(/%(?![0-9A-Fa-f]{2})|[&#= \u0000-\u001f\u007f-￿]/gu, (ch) => {
      if (ch === '%') return '%25'
      return encodeURIComponent(ch)
    }),
  )
}

export function decodeQueryPart(text: string): string {
  return mapOutsideTokens(text, (part) => {
    try {
      return decodeURIComponent(part)
    } catch {
      return part
    }
  })
}

export interface SplitUrl {
  base: string
  /** Text after `?` (without it), or null when there is no `?`. */
  query: string | null
  /** Text after `#` including nothing else, or null. */
  hash: string | null
}

export function splitUrl(url: string): SplitUrl {
  let hash: string | null = null
  let rest = url
  // `#` inside {{tokens}} is not possible per grammar, so a plain indexOf is safe.
  const h = rest.indexOf('#')
  if (h >= 0) {
    hash = rest.slice(h + 1)
    rest = rest.slice(0, h)
  }
  const q = rest.indexOf('?')
  if (q < 0) return { base: rest, query: null, hash }
  return { base: rest.slice(0, q), query: rest.slice(q + 1), hash }
}

export interface QueryPair {
  key: string
  value: string
}

export function parseQuery(query: string): QueryPair[] {
  if (!query) return []
  return query
    .split('&')
    .filter((p) => p !== '')
    .map((p) => {
      const i = p.indexOf('=')
      const key = i >= 0 ? p.slice(0, i) : p
      const value = i >= 0 ? p.slice(i + 1) : ''
      return { key: decodeQueryPart(key), value: decodeQueryPart(value) }
    })
}

/** Parses the enabled params out of a URL. */
export function paramsFromUrl(url: string): QueryPair[] {
  const { query } = splitUrl(url)
  return query ? parseQuery(query) : []
}

/**
 * Merges freshly parsed URL params into the existing table rows:
 *  - disabled rows stay where they are,
 *  - enabled rows are matched positionally so ids/descriptions/focus survive,
 *  - surplus rows are appended after the last enabled row; missing ones removed.
 * Always ends with one blank row.
 */
export function mergeParamsFromUrl(url: string, previous: KvRow[]): KvRow[] {
  const parsed = paramsFromUrl(url)
  const prevData = previous.filter((r) => !isEmptyRow(r) || !r.enabled)
  const result: KvRow[] = []
  let p = 0
  let lastEnabledIndex = -1
  for (const row of prevData) {
    if (!row.enabled) {
      result.push(row)
      continue
    }
    if (p < parsed.length) {
      result.push({ ...row, key: parsed[p].key, value: parsed[p].value })
      p += 1
      lastEnabledIndex = result.length - 1
    }
    // else: enabled row no longer present in the URL -> dropped
  }
  const extras = parsed.slice(p).map((q) => newRow({ key: q.key, value: q.value }))
  result.splice(lastEnabledIndex + 1, 0, ...extras)
  return ensureTrailingEmpty(result)
}

/** Builds the URL from its current base/hash and the enabled rows of the table. */
export function buildUrlFromParams(currentUrl: string, rows: KvRow[]): string {
  const { base, hash } = splitUrl(currentUrl)
  const enabled = rows.filter((r) => r.enabled && (r.key !== '' || r.value !== ''))
  const query = enabled
    .map((r) => `${encodeQueryPart(r.key)}=${encodeQueryPart(r.value)}`)
    .join('&')
  let out = base
  if (query) out += `?${query}`
  if (hash !== null) out += `#${hash}`
  return out
}
