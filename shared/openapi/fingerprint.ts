/**
 * Has the user changed the parts of a request that came from an OpenAPI document? Imported requests carry
 * `openapi.itemHash`, the fingerprint of what the import generated; the same fingerprint of the request as stored now
 * tells "unchanged since import" from "edited here" (docs/ARCHITECTURE.md, "OpenAPI", identity).
 *
 * The fingerprint is semantic, because the renderer re-serialises documents in its own (Postman-like) shape when a request
 * is saved: method, URL, headers (key, value, enabled), the body by mode, the auth fields an import sets, and the
 * description text. Saving a request without changing anything keeps the fingerprint; saved examples are not part of it
 * (generated ones are replaced on update, the user's own are kept).
 */
import { isObj, type Json } from './load'

const s = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v))

function rows(list: unknown, withType = false): string[][] {
  if (!Array.isArray(list)) return []
  return list
    .filter(isObj)
    .filter((r) => s(r.key) !== '' || s(r.value) !== '')
    .map((r) => [s(r.key), r.type === 'file' ? s(r.src) : s(r.value), r.disabled === true ? '0' : '1', ...(withType ? [s(r.type) || 'text'] : [])])
}

function body(b: unknown): unknown {
  if (!isObj(b)) return null
  switch (b.mode) {
    case 'raw':
      return s(b.raw) === '' ? null : ['raw', s(b.raw)]
    case 'urlencoded':
      return rows(b.urlencoded).length ? ['urlencoded', rows(b.urlencoded)] : null
    case 'formdata':
      return rows(b.formdata, true).length ? ['formdata', rows(b.formdata, true)] : null
    case 'file':
      return ['file', isObj(b.file) ? s(b.file.src) : '']
    case 'graphql':
      return ['graphql', isObj(b.graphql) ? [s(b.graphql.query), s(b.graphql.variables)] : []]
    default:
      return null
  }
}

/** The auth fields an OpenAPI import can set, per type (other keys the editor adds with defaults are ignored). */
const AUTH_FIELDS: Record<string, string[]> = {
  bearer: ['token'],
  basic: ['username', 'password'],
  apikey: ['key', 'value', 'in'],
  oauth2: ['grant_type', 'authUrl', 'accessTokenUrl', 'clientId', 'scope'],
}

function auth(a: unknown): unknown {
  if (!isObj(a)) return null
  const type = s(a.type)
  const fields = AUTH_FIELDS[type]
  if (!fields) return type === 'noauth' || type === '' ? null : [type]
  const list = Array.isArray(a[type]) ? (a[type] as unknown[]).filter(isObj) : []
  const value = (k: string) => s(list.find((e) => e.key === k)?.value)
  return [type, ...fields.map((f) => (f === 'in' ? value(f) || 'header' : value(f)))]
}

function description(d: unknown): string {
  if (typeof d === 'string') return d.trim()
  if (isObj(d)) return s(d.content).trim()
  return ''
}

/** The fingerprint of a stored request document (the importer's and the renderer's shape alike). */
export function fingerprintDocument(doc: Json, method: string, url: string): string {
  const parts = [
    (typeof doc.method === 'string' ? doc.method : method).toUpperCase(),
    typeof doc.url === 'string' ? doc.url : url,
    rows(doc.headers),
    body(doc.body),
    auth(doc.auth),
    description(doc.description),
  ]
  return hash128(JSON.stringify(parts))
}

/** Hash of any JSON value with object keys sorted (spec text identity, plan staleness). */
export function stableHash(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort) : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v
  return hash128(JSON.stringify(sort(value)))
}

/**
 * 128-bit non-cryptographic hash as 32 hex digits (four 32-bit lanes of a cyrb-style mix). Pure JS so the same code runs
 * in main and in the browser mock backend; only used to detect changes, never for security.
 */
export function hash128(text: string): string {
  let h1 = 0xdeadbeef ^ text.length
  let h2 = 0x41c6ce57 ^ text.length
  let h3 = 0x9e3779b9 ^ text.length
  let h4 = 0x85ebca6b ^ text.length
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
    h3 = Math.imul(h3 ^ c, 2246822507)
    h4 = Math.imul(h4 ^ c, 3266489909)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h3 ^ (h3 >>> 13), 3266489909)
  h3 = Math.imul(h3 ^ (h3 >>> 16), 2246822507) ^ Math.imul(h4 ^ (h4 >>> 13), 3266489909)
  h4 = Math.imul(h4 ^ (h4 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return [h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, '0')).join('')
}
