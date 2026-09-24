/**
 * Postman Collection v2.1 / environment export. Pure functions.
 *
 * Request documents already keep the Postman item shape (see request.ts), so headers, body,
 * auth, scripts (`scripts` -> `event`) and `responses` (-> `response`) are passed through
 * verbatim; only the URL is decomposed and query params are rebuilt. `{{variables}}` are
 * never encoded or split.
 */
import type { ApiFolder, ApiRequest, Collection } from '../../shared/types'

export const POSTMAN_SCHEMA_V21 = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

export interface PostmanQueryParam {
  key: string
  value: string
  disabled?: boolean
  description?: unknown
}

export interface PostmanUrlVariable {
  key: string
  value?: string
  description?: unknown
  [k: string]: unknown
}

export interface PostmanUrl {
  raw: string
  protocol?: string
  host?: string[]
  path?: string[]
  port?: string
  query?: PostmanQueryParam[]
  hash?: string
  variable?: PostmanUrlVariable[]
}

export interface PostmanHeader {
  key: string
  value: string
  type?: string
  disabled?: boolean
  description?: unknown
  [k: string]: unknown
}

export interface PostmanRequest {
  method: string
  header: PostmanHeader[]
  url: PostmanUrl
  description?: unknown
  body?: unknown
  auth?: unknown
}

export interface PostmanItem {
  name: string
  item?: PostmanItem[]
  request?: PostmanRequest
  event?: unknown[]
  response?: unknown[]
}

export interface PostmanCollectionV21 {
  info: { _postman_id: string; name: string; schema: string }
  item: PostmanItem[]
}

export interface ExportPostmanInput {
  collection: Collection
  folders: ApiFolder[]
  requests: ApiRequest[]
}

// ---------------------------------------------------------------------------
// URL decomposition
// ---------------------------------------------------------------------------

const TOKEN = /(\{\{[^{}]*\}\})/

/** Splits on `sep` except inside `{{...}}`. Empty parts are dropped. */
function splitOutsideTokens(text: string, sep: string): string[] {
  const parts: string[] = []
  let current = ''
  text.split(TOKEN).forEach((piece, i) => {
    if (i % 2 === 1) {
      current += piece
      return
    }
    const segs = piece.split(sep)
    segs.forEach((seg, j) => {
      if (j > 0) {
        parts.push(current)
        current = ''
      }
      current += seg
    })
  })
  parts.push(current)
  return parts.filter((p) => p !== '')
}

/** Index of the last `:` outside `{{...}}`, or -1. */
function lastColonOutsideTokens(text: string): number {
  let idx = -1
  let offset = 0
  text.split(TOKEN).forEach((piece, i) => {
    if (i % 2 === 0) {
      const c = piece.lastIndexOf(':')
      if (c >= 0) idx = offset + c
    }
    offset += piece.length
  })
  return idx
}

function parseQueryText(q: string): PostmanQueryParam[] {
  return q
    .split('&')
    .filter((p) => p !== '')
    .map((p) => {
      const i = p.indexOf('=')
      return i >= 0 ? { key: p.slice(0, i), value: p.slice(i + 1) } : { key: p, value: '' }
    })
}

function looksLikeHost(firstSegment: string): boolean {
  return firstSegment.includes('.') || firstSegment.includes(':') || firstSegment.includes('{{') || firstSegment === 'localhost'
}

export function decomposeUrl(rawUrl: string): Omit<PostmanUrl, 'variable'> {
  const url: PostmanUrl = { raw: rawUrl }
  let rest = rawUrl.trim()
  if (!rest) return url

  const hashAt = rest.indexOf('#')
  if (hashAt >= 0) {
    const hash = rest.slice(hashAt + 1)
    if (hash) url.hash = hash
    rest = rest.slice(0, hashAt)
  }
  const qAt = rest.indexOf('?')
  if (qAt >= 0) {
    const query = parseQueryText(rest.slice(qAt + 1))
    if (query.length > 0) url.query = query
    rest = rest.slice(0, qAt)
  }

  const proto = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(rest)
  let hasAuthority = false
  if (proto) {
    url.protocol = proto[1]
    rest = rest.slice(proto[0].length)
    hasAuthority = true
  } else if (rest.startsWith('//')) {
    rest = rest.slice(2)
    hasAuthority = true
  }

  const slash = rest.indexOf('/')
  const firstSegment = slash >= 0 ? rest.slice(0, slash) : rest
  if (hasAuthority || (!rest.startsWith('/') && looksLikeHost(firstSegment))) {
    let hostPart = firstSegment
    const pathPart = slash >= 0 ? rest.slice(slash + 1) : ''
    const colon = lastColonOutsideTokens(hostPart)
    if (colon > 0 && !hostPart.startsWith('[')) {
      const port = hostPart.slice(colon + 1)
      if (/^(\d+|\{\{[^{}]*\}\})$/.test(port)) {
        url.port = port
        hostPart = hostPart.slice(0, colon)
      }
    }
    const host = splitOutsideTokens(hostPart, '.')
    if (host.length > 0) url.host = host
    const path = splitOutsideTokens(pathPart, '/')
    if (path.length > 0) url.path = path
  } else {
    const path = splitOutsideTokens(rest, '/')
    if (path.length > 0) url.path = path
  }
  return url
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

function parseDoc(json: string): Json {
  try {
    const v = JSON.parse(json || '{}')
    return isObj(v) ? v : {}
  } catch {
    return {}
  }
}

function asText(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

function exportHeaders(list: unknown): PostmanHeader[] {
  if (!Array.isArray(list)) return []
  const out: PostmanHeader[] = []
  for (const h of list) {
    if (typeof h === 'string') {
      const i = h.indexOf(':')
      const key = (i >= 0 ? h.slice(0, i) : h).trim()
      if (key) out.push({ key, value: i >= 0 ? h.slice(i + 1).trim() : '' })
      continue
    }
    if (!isObj(h)) continue
    const key = asText(h.key)
    const value = asText(h.value)
    if (key === '' && value === '') continue
    const { description, ...rest } = h
    const header: PostmanHeader = { ...rest, key, value }
    if (h.disabled) header.disabled = true
    else delete header.disabled
    if (description !== undefined && description !== null && description !== '') header.description = description
    out.push(header)
  }
  return out
}

interface ParamRow {
  key: string
  value: string
  disabled: boolean
  description?: unknown
}

function paramRows(list: unknown): ParamRow[] {
  if (!Array.isArray(list)) return []
  return list.filter(isObj).map((p) => ({
    key: asText(p.key),
    value: asText(p.value),
    disabled: !!p.disabled,
    description: p.description,
  }))
}

function buildUrl(doc: Json, fallbackUrl: string): PostmanUrl {
  const raw = typeof doc.url === 'string' ? doc.url : fallbackUrl
  const { raw: _raw, ...parts } = decomposeUrl(raw)
  const url: PostmanUrl = { raw, ...parts }

  const sourceUrl = isObj(doc.source) && isObj(doc.source.request) && isObj(doc.source.request.url) ? doc.source.request.url : null

  // Disabled params live in doc.params (editor) or only in the imported source item.
  let known = paramRows(doc.params)
  if (known.length === 0 && sourceUrl) known = paramRows(sourceUrl.query)
  const disabled = known.filter((p) => p.disabled)
  const enabledMeta = known.filter((p) => !p.disabled)

  const query: PostmanQueryParam[] = (url.query ?? []).map((q, i) => {
    const meta = enabledMeta[i]
    const out: PostmanQueryParam = { ...q }
    if (meta && meta.key === q.key && meta.description != null && meta.description !== '') out.description = meta.description
    return out
  })
  for (const p of disabled) {
    const q: PostmanQueryParam = { key: p.key, value: p.value, disabled: true }
    if (p.description != null && p.description !== '') q.description = p.description
    query.push(q)
  }
  if (query.length > 0) url.query = query
  else delete url.query

  if (sourceUrl && Array.isArray(sourceUrl.variable)) {
    const variables = sourceUrl.variable.filter((v): v is PostmanUrlVariable => isObj(v) && typeof v.key === 'string' && v.key.trim() !== '')
    if (variables.length > 0) url.variable = variables
  }
  return url
}

/**
 * Builds a Postman v2.1 `request` object from a request document (our item-shaped JSON). Also used
 * for an example's `originalRequest` (lib/examples.ts), so both are written the same way.
 */
export function postmanRequestFromDocument(doc: Json, fallback: { method: string; url: string }): PostmanRequest {
  const method = (asText(doc.method).trim() || fallback.method || 'GET').toUpperCase()
  const req: PostmanRequest = {
    method,
    header: exportHeaders(doc.headers),
    url: buildUrl(doc, fallback.url),
  }
  const description = doc.description
  if (description !== null && description !== undefined && description !== '') req.description = description
  if (doc.body !== null && doc.body !== undefined) req.body = doc.body
  if (doc.auth !== null && doc.auth !== undefined) req.auth = doc.auth
  return req
}

/** Postman v2.0/v2.1 `url` (string or object) to a plain URL string (same rules as the importer). */
export function postmanUrlToString(url: unknown): string {
  if (typeof url === 'string') return url
  if (!isObj(url)) return ''
  if (typeof url.raw === 'string') return url.raw
  const join = (parts: unknown, sep: string) => (Array.isArray(parts) ? parts.filter((p): p is string => typeof p === 'string').join(sep) : '')
  const host = join(url.host, '.')
  const path = join(url.path, '/')
  if (host && path) return `${host.replace(/\/+$/, '')}/${path}`
  return host || path
}

function requestItem(request: ApiRequest): PostmanItem {
  const doc = parseDoc(request.documentJson)
  const item: PostmanItem = { name: request.name, request: postmanRequestFromDocument(doc, request) }
  if (Array.isArray(doc.scripts) && doc.scripts.length > 0) item.event = doc.scripts
  if (Array.isArray(doc.responses) && doc.responses.length > 0) item.response = doc.responses
  return item
}

type Sortable = { sortOrder: number; name: string; id: string }
function bySibling(a: Sortable, b: Sortable): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
  const n = a.name.localeCompare(b.name)
  if (n !== 0) return n
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function buildPostmanCollection({ collection, folders, requests }: ExportPostmanInput): PostmanCollectionV21 {
  const folderIds = new Set(folders.map((f) => f.id))
  const key = (id: string | null) => (id !== null && folderIds.has(id) ? id : '')
  const foldersByParent = new Map<string, ApiFolder[]>()
  for (const f of folders) {
    const p = f.parentFolderId === f.id ? '' : key(f.parentFolderId)
    foldersByParent.set(p, [...(foldersByParent.get(p) ?? []), f])
  }
  const requestsByFolder = new Map<string, ApiRequest[]>()
  for (const r of requests) {
    const p = key(r.folderId)
    requestsByFolder.set(p, [...(requestsByFolder.get(p) ?? []), r])
  }

  const seen = new Set<string>()
  const itemsFor = (parent: string): PostmanItem[] => {
    const out: PostmanItem[] = []
    for (const f of [...(foldersByParent.get(parent) ?? [])].sort(bySibling)) {
      if (seen.has(f.id)) continue
      seen.add(f.id)
      out.push({ name: f.name, item: itemsFor(f.id) })
    }
    for (const r of [...(requestsByFolder.get(parent) ?? [])].sort(bySibling)) out.push(requestItem(r))
    return out
  }
  const item = itemsFor('')
  // Folders caught in a parent cycle are unreachable; export them at the root rather than lose them.
  for (const f of [...folders].sort(bySibling)) {
    if (!seen.has(f.id)) {
      seen.add(f.id)
      item.push({ name: f.name, item: itemsFor(f.id) })
    }
  }
  return { info: { _postman_id: collection.id, name: collection.name, schema: POSTMAN_SCHEMA_V21 }, item }
}

export function exportPostmanCollection(input: ExportPostmanInput): string {
  return JSON.stringify(buildPostmanCollection(input), null, 2)
}

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

export interface PostmanEnvironmentValue {
  key: string
  value: string
  type: 'default' | 'secret'
  enabled: boolean
}

export interface PostmanEnvironment {
  name: string
  values: PostmanEnvironmentValue[]
  _postman_variable_scope: 'environment'
  _postman_exported_using: string
}

export function buildPostmanEnvironment(
  name: string,
  vars: { key: string; value: string | null; isSecret: boolean; enabled?: boolean }[],
): PostmanEnvironment {
  return {
    name,
    values: vars.map((v) => ({
      key: v.key,
      value: v.isSecret ? '' : (v.value ?? ''),
      type: v.isSecret ? 'secret' : 'default',
      enabled: v.enabled ?? true,
    })),
    _postman_variable_scope: 'environment',
    _postman_exported_using: 'Slinger',
  }
}

export function exportPostmanEnvironment(
  name: string,
  vars: { key: string; value: string | null; isSecret: boolean; enabled?: boolean }[],
): string {
  return JSON.stringify(buildPostmanEnvironment(name, vars), null, 2)
}
