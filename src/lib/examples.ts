/**
 * Saved examples (Postman "example responses"). Pure functions, no DOM.
 *
 * Storage: examples live verbatim inside the request document as `responses`, which is the
 * Postman v2.1 item `response[]` array (name, originalRequest, status, code,
 * _postman_previewlanguage, header, cookie, body, ...). Keeping them there means sync, collection
 * versions and Postman export carry them without any extra table or IPC method.
 *
 * Editing is byte-faithful: `serializeExample` starts from the ORIGINAL stored object and only
 * replaces the fields whose parsed value was actually edited. Untouched examples (and untouched
 * fields of edited ones: cookie, responseTime, id, header shapes, unknown keys...) are written
 * back exactly as they were imported.
 *
 * Identity: examples imported from Postman usually have no `id`, and adding one would change
 * untouched data. The UI therefore addresses an example by its index plus a snapshot of its JSON
 * (`ExampleLocator`), which finds it again after other examples were added/removed. Examples that
 * Slinger creates (save as example, duplicate, add) get a Postman-schema `id` (a UUID).
 */
import type { ApiRequest, HttpResponseData, RequestHeader } from '../../shared/types'
import { dataRows, ensureTrailingEmpty, newRow, type KvRow } from './kv'
import { postmanRequestFromDocument, postmanUrlToString } from './postman'
import { draftFingerprint, parseDocument, serializeDraft, type RequestDraft } from './request'
import { analyzeResponse, base64ToBytes, formatBytes } from './response'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

/** Slinger-specific key marking a body that holds base64 bytes (binary responses saved as examples). */
export const BODY_ENCODING_KEY = '_slinger_body_encoding'
/** Largest body (characters, base64 included) stored in an example. Documents are synced as one item. */
export const EXAMPLE_BODY_LIMIT = 5_000_000

export type PreviewLanguage = 'json' | 'xml' | 'html' | 'text' | 'javascript'

export const PREVIEW_LANGUAGES: { id: PreviewLanguage; label: string; mime: string }[] = [
  { id: 'json', label: 'JSON', mime: 'application/json' },
  { id: 'xml', label: 'XML', mime: 'application/xml' },
  { id: 'html', label: 'HTML', mime: 'text/html' },
  { id: 'text', label: 'Text', mime: 'text/plain' },
  { id: 'javascript', label: 'JavaScript', mime: 'application/javascript' },
]

/** The editable response half of an example. */
export interface ExampleResponseDraft {
  name: string
  code: number | null
  status: string
  headers: KvRow[]
  body: string
  /** `_postman_previewlanguage` as stored ('' when absent). */
  language: string
  /** 'base64' when the body holds base64 bytes (see BODY_ENCODING_KEY). */
  bodyEncoding: 'base64' | null
}

export interface ParsedExample {
  response: ExampleResponseDraft
  /** The example's saved request (from `originalRequest`, else the parent request). */
  request: RequestDraft
  /** `originalRequest` was missing or unusable: the request part shows the parent request. */
  requestFromParent: boolean
  /** Numeric `responseTime` when stored (ms). */
  responseTime: number | null
}

export interface ExampleSummary {
  index: number
  name: string
  code: number | null
  id: string | null
}

/** How the UI finds an example again after the document changed. */
export interface ExampleLocator {
  index: number
  id: string | null
  /** JSON of the example when last loaded/saved. */
  snapshot: string
  name: string
  count: number
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

function parseObject(json: string): Json {
  try {
    const v = JSON.parse(json || '{}')
    return isObj(v) ? v : {}
  } catch {
    return {}
  }
}

/** The `responses` array of a request document (empty when missing or corrupt). */
export function readExamples(documentJson: string): unknown[] {
  const doc = parseObject(documentJson)
  return Array.isArray(doc.responses) ? doc.responses : []
}

/**
 * Returns the document with `responses` replaced by `fn(current)`. Every other key is kept (in its
 * position); a document without `responses` gets it appended.
 */
export function updateExamples(documentJson: string, fn: (list: unknown[]) => unknown[]): string {
  const doc = parseObject(documentJson)
  const current = Array.isArray(doc.responses) ? [...doc.responses] : []
  doc.responses = fn(current)
  return JSON.stringify(doc)
}

export const snapshotOf = (example: unknown): string => JSON.stringify(example ?? null)

export function exampleName(example: unknown): string {
  const n = isObj(example) && typeof example.name === 'string' ? example.name.trim() : ''
  return n || 'Untitled example'
}

function exampleId(example: unknown): string | null {
  return isObj(example) && typeof example.id === 'string' && example.id ? example.id : null
}

function statusCode(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'string' && /^\d{1,3}$/.test(v.trim())) return Number(v.trim())
  return null
}

const summaryCache = new Map<string, { doc: string; list: ExampleSummary[] }>()

/** Tree data for a request's examples. Cached per request while its document is unchanged. */
export function exampleSummaries(request: Pick<ApiRequest, 'id' | 'documentJson'>): ExampleSummary[] {
  const doc = request.documentJson
  const hit = summaryCache.get(request.id)
  if (hit && hit.doc === doc) return hit.list
  // Most documents have no examples: skip parsing them.
  const list = doc && doc.includes('"responses"')
    ? readExamples(doc).map((e, index) => ({ index, name: exampleName(e), code: isObj(e) ? statusCode(e.code) : null, id: exampleId(e) }))
    : []
  if (summaryCache.size > 5000) summaryCache.clear()
  summaryCache.set(request.id, { doc, list })
  return list
}

export function locatorFor(list: unknown[], index: number): ExampleLocator {
  const example = list[index]
  return { index, id: exampleId(example), snapshot: snapshotOf(example), name: exampleName(example), count: list.length }
}

/**
 * Finds an example again. `changed` is true when it is still there (same id, or same slot with the
 * same name / same number of examples) but its content differs from the snapshot. Null: gone.
 */
export function locateExample(list: unknown[], loc: Pick<ExampleLocator, 'index' | 'id' | 'snapshot' | 'name' | 'count'>): { index: number; changed: boolean } | null {
  if (loc.id) {
    const i = list.findIndex((e) => exampleId(e) === loc.id)
    return i < 0 ? null : { index: i, changed: snapshotOf(list[i]) !== loc.snapshot }
  }
  if (loc.index < list.length && snapshotOf(list[loc.index]) === loc.snapshot) return { index: loc.index, changed: false }
  const same = list.findIndex((e) => snapshotOf(e) === loc.snapshot)
  if (same >= 0) return { index: same, changed: false }
  if (loc.index < list.length && !exampleId(list[loc.index]) && (exampleName(list[loc.index]) === loc.name || list.length === loc.count)) {
    return { index: loc.index, changed: true }
  }
  return null
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function headerRows(header: unknown): KvRow[] {
  let list: unknown[] = []
  if (Array.isArray(header)) list = header
  else if (typeof header === 'string') list = header.split(/\r?\n/).filter((l) => l.trim() !== '')
  const rows: KvRow[] = []
  for (const h of list) {
    if (typeof h === 'string') {
      const i = h.indexOf(':')
      rows.push(newRow({ key: (i >= 0 ? h.slice(0, i) : h).trim(), value: i >= 0 ? h.slice(i + 1).trim() : '' }))
    } else if (isObj(h)) {
      const text = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v))
      const description = typeof h.description === 'string' ? h.description : isObj(h.description) ? text(h.description.content) : ''
      rows.push(newRow({ key: text(h.key), value: text(h.value), enabled: !h.disabled, description }))
    }
  }
  return ensureTrailingEmpty(rows)
}

/** Postman request object (or URL string) to our request-document shape, for `parseDocument`. */
function documentFromPostmanRequest(req: unknown): { method: string; url: string; documentJson: string } | null {
  if (typeof req === 'string') return { method: 'GET', url: req, documentJson: JSON.stringify({ method: 'GET', url: req }) }
  if (!isObj(req)) return null
  const url = postmanUrlToString(req.url)
  const method = (typeof req.method === 'string' && req.method.trim() ? req.method.trim() : 'GET').toUpperCase()
  const header = typeof req.header === 'string' ? req.header.split(/\r?\n/).filter((l) => l.trim() !== '') : req.header
  const query = isObj(req.url) && Array.isArray(req.url.query) ? req.url.query : null
  const doc: Json = {
    method,
    url,
    description: req.description ?? null,
    headers: Array.isArray(header) ? header : [],
    body: req.body ?? null,
    auth: req.auth ?? null,
  }
  // Disabled query params only exist in url.query; enabled ones are re-read from the URL text.
  if (query) doc.params = query.filter((q) => isObj(q) && q.disabled)
  return { method, url, documentJson: JSON.stringify(doc) }
}

function bodyText(body: unknown): string {
  if (typeof body === 'string') return body
  if (body == null) return ''
  return JSON.stringify(body, null, 2)
}

export function parseExample(example: unknown, parent: Pick<ApiRequest, 'method' | 'url' | 'documentJson'>): ParsedExample {
  const e = isObj(example) ? example : {}
  const fromOriginal = documentFromPostmanRequest(e.originalRequest)
  const source = fromOriginal ?? { method: parent.method, url: parent.url, documentJson: parent.documentJson }
  // Only the request shape matters here: the parent's scripts/responses/settings must not leak in.
  const request: RequestDraft = { ...parseDocument({ ...source, name: '' }), extras: {} }
  const encoding = e[BODY_ENCODING_KEY] === 'base64' && typeof e.body === 'string' ? 'base64' : null
  return {
    response: {
      name: typeof e.name === 'string' ? e.name : '',
      code: statusCode(e.code),
      status: typeof e.status === 'string' ? e.status : '',
      headers: headerRows(e.header),
      body: bodyText(e.body),
      language: typeof e._postman_previewlanguage === 'string' ? e._postman_previewlanguage : '',
      bodyEncoding: encoding,
    },
    request,
    requestFromParent: fromOriginal === null,
    responseTime: typeof e.responseTime === 'number' && Number.isFinite(e.responseTime) ? e.responseTime : null,
  }
}

// ---------------------------------------------------------------------------
// Serialising
// ---------------------------------------------------------------------------

const rowFacts = (rows: KvRow[]) => dataRows(rows).map((r) => [r.key, r.value, r.enabled, r.description])

/** Canonical string of the response half, for dirty checks. */
export function exampleFingerprint(r: ExampleResponseDraft): string {
  return JSON.stringify([r.name, r.code, r.status, rowFacts(r.headers), r.body, r.language, r.bodyEncoding])
}

function serializeHeaders(rows: KvRow[], original: unknown): Json[] {
  const before = Array.isArray(original) ? original : []
  return dataRows(rows).map((r, i) => {
    // Keep extra keys (name, type...) of a row that is still the same header in the same place.
    const prev = before[i]
    const base: Json = isObj(prev) && prev.key === r.key ? { ...prev } : {}
    base.key = r.key
    base.value = r.value
    if (!r.enabled) base.disabled = true
    else delete base.disabled
    if (r.description) base.description = r.description
    else if (typeof base.description === 'string') delete base.description
    return base
  })
}

function serializeRequest(draft: RequestDraft, original: unknown): Json {
  const s = serializeDraft({ ...draft, extras: {} })
  const built = postmanRequestFromDocument(parseObject(s.documentJson), { method: s.method, url: s.url }) as unknown as Json
  const out: Json = isObj(original) ? { ...original } : {}
  for (const k of ['method', 'header', 'body', 'url', 'auth', 'description']) {
    if (k in built) out[k] = built[k]
    else delete out[k]
  }
  // Path variables are not editable here; keep the stored ones.
  if (isObj(original) && isObj(original.url) && Array.isArray(original.url.variable) && isObj(out.url) && !('variable' in out.url)) {
    out.url = { ...out.url, variable: original.url.variable }
  }
  return out
}

/**
 * Writes an edited example back onto the original stored object. Fields whose value equals the
 * baseline parse are left untouched (same JSON), so unedited examples round-trip exactly.
 */
export function serializeExample(original: unknown, baseline: ParsedExample, edited: { response: ExampleResponseDraft; request: RequestDraft }): Json {
  const out: Json = isObj(original) ? { ...original } : {}
  const b = baseline.response
  const r = edited.response
  if (r.name !== b.name) out.name = r.name.trim() || 'Untitled example'
  if (draftFingerprint(edited.request) !== draftFingerprint(baseline.request)) out.originalRequest = serializeRequest(edited.request, out.originalRequest)
  if (r.status !== b.status) out.status = r.status
  if (r.code !== b.code) {
    if (r.code === null) delete out.code
    else out.code = r.code
  }
  if (r.language !== b.language) {
    if (r.language) out._postman_previewlanguage = r.language
    else delete out._postman_previewlanguage
  }
  if (JSON.stringify(rowFacts(r.headers)) !== JSON.stringify(rowFacts(b.headers))) out.header = serializeHeaders(r.headers, out.header)
  if (r.body !== b.body || r.bodyEncoding !== b.bodyEncoding) {
    out.body = r.body
    if (r.bodyEncoding) out[BODY_ENCODING_KEY] = r.bodyEncoding
    else delete out[BODY_ENCODING_KEY]
  }
  return out
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

export function newExampleId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const n = (Math.random() * 16) | 0
    return (c === 'x' ? n : (n & 0x3) | 0x8).toString(16)
  })
}

function languageOfResponse(res: HttpResponseData): PreviewLanguage {
  const info = analyzeResponse(res)
  if (info.kind === 'json' || info.kind === 'xml' || info.kind === 'html') return info.kind
  if (info.language === 'javascript') return 'javascript'
  return 'text'
}

/**
 * An example from a live response and the request that produced it (templates kept unresolved).
 * Text bodies are stored as text. Binary bodies (no UTF-8 text) are stored as base64 in `body` with
 * `_slinger_body_encoding: "base64"`; Postman ignores the marker and shows the base64 text.
 * A binary body above EXAMPLE_BODY_LIMIT is replaced by a short note; a text body above it is refused.
 */
export function exampleFromResponse(input: { name: string; request: RequestDraft; response: HttpResponseData; id?: string }): { example: Json; note: string | null } {
  const res = input.response
  const binary = res.bodyText === null && !!res.bodyBase64
  let body = binary ? (res.bodyBase64 ?? '') : (res.bodyText ?? '')
  let note: string | null = null
  let encoded = binary
  if (!binary && body.length > EXAMPLE_BODY_LIMIT) {
    throw new Error(`The response body (${formatBytes(res.bodyByteLength)}) is too large to keep as an example (limit ${formatBytes(EXAMPLE_BODY_LIMIT)}).`)
  }
  if (binary && body.length > EXAMPLE_BODY_LIMIT) {
    const mime = analyzeResponse(res).mime || 'application/octet-stream'
    body = `[binary response body not stored: ${mime}, ${formatBytes(res.bodyByteLength)}]`
    note = 'The binary body was too large to store; the example keeps a note instead.'
    encoded = false
  } else if (binary) note = 'The binary body is stored as base64.'
  const example: Json = {
    id: input.id ?? newExampleId(),
    name: input.name.trim() || 'Untitled example',
    originalRequest: serializeRequest({ ...input.request, extras: {} }, undefined),
    status: res.statusText || statusReason(res.status),
    code: res.status,
    _postman_previewlanguage: encoded ? 'text' : languageOfResponse(res),
    header: res.headers.map((h) => ({ key: h.key, value: h.value })),
    cookie: [],
    responseTime: Math.round(res.durationMs),
    body,
  }
  if (encoded) example[BODY_ENCODING_KEY] = 'base64'
  return { example, note }
}

/** A new, empty 200 example for a request ("Add example"). */
export function blankExample(name: string, request: RequestDraft, id?: string): Json {
  return {
    id: id ?? newExampleId(),
    name: name.trim() || 'New example',
    originalRequest: serializeRequest({ ...request, extras: {} }, undefined),
    status: 'OK',
    code: 200,
    _postman_previewlanguage: 'json',
    header: [{ key: 'Content-Type', value: 'application/json' }],
    cookie: [],
    body: '',
  }
}

/** A copy with a new name and a fresh id; everything else is kept as stored. */
export function duplicateExample(example: unknown, name: string, id?: string): Json {
  const copy: Json = isObj(example) ? structuredClone(example) : {}
  return { ...copy, id: id ?? newExampleId(), name }
}

// ---------------------------------------------------------------------------
// Viewing
// ---------------------------------------------------------------------------

export function mimeForLanguage(language: string): string {
  return PREVIEW_LANGUAGES.find((l) => l.id === language.toLowerCase())?.mime ?? ''
}

/** The response half as HttpResponseData for the response viewer. */
export function exampleResponseData(r: ExampleResponseDraft, responseTime: number | null = null): HttpResponseData {
  const headers: RequestHeader[] = dataRows(r.headers)
    .filter((h) => h.enabled && h.key)
    .map((h) => ({ key: h.key, value: h.value }))
  let bytes: Uint8Array | null = null
  if (r.bodyEncoding === 'base64') {
    try {
      bytes = base64ToBytes(r.body)
    } catch {
      bytes = null
    }
  }
  return {
    status: r.code ?? 0,
    statusText: r.status,
    durationMs: responseTime ?? 0,
    headers,
    bodyText: bytes ? null : r.body,
    bodyBase64: bytes ? r.body : null,
    bodyByteLength: bytes ? bytes.length : new TextEncoder().encode(r.body).length,
  }
}

const REASONS: Record<number, string> = {
  100: 'Continue', 101: 'Switching Protocols', 200: 'OK', 201: 'Created', 202: 'Accepted', 203: 'Non-Authoritative Information',
  204: 'No Content', 205: 'Reset Content', 206: 'Partial Content', 301: 'Moved Permanently', 302: 'Found', 303: 'See Other',
  304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect', 400: 'Bad Request', 401: 'Unauthorized',
  402: 'Payment Required', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 406: 'Not Acceptable', 408: 'Request Timeout',
  409: 'Conflict', 410: 'Gone', 411: 'Length Required', 412: 'Precondition Failed', 413: 'Payload Too Large', 415: 'Unsupported Media Type',
  418: "I'm a teapot", 422: 'Unprocessable Entity', 425: 'Too Early', 428: 'Precondition Required', 429: 'Too Many Requests',
  500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
}

/** Standard reason phrase for a status code ('' when unknown). */
export function statusReason(code: number | null): string {
  return code === null ? '' : (REASONS[code] ?? '')
}
