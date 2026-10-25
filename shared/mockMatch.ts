/**
 * Mock server request matching (pure, no Node/DOM). Used by the main-process mock server (electron/services/mockServers.ts)
 * and the browser mock backend, so both answer the same way.
 *
 * An example's saved request URL is reduced to its path: the scheme and host, or a leading `{{variable}}` such as
 * `{{baseUrl}}`, and the query/fragment are dropped. Path segments are compared one by one:
 *  - a literal segment must be equal (case-sensitive, percent-decoded on both sides);
 *  - `:name` and a whole `{{name}}` segment match any one segment;
 *  - a segment mixing text and `{{name}}` (`v{{version}}`) matches with the variable part as a wildcard.
 * Empty segments are ignored, so `/users/` and `/users` are the same path.
 *
 * Choosing among the examples that match the method (HEAD falls back to GET) and path:
 *  1. Postman's selection headers narrow the list: `x-mock-response-id`, `x-mock-response-name` (case-insensitive),
 *     `x-mock-response-code`, `x-mock-match-request-headers: A, B` (the example's saved request must have headers A and B
 *     with the request's values; a `{{var}}` value matches any) and `x-mock-match-request-body: true` (its saved body must
 *     equal the request's). When they leave nothing, the answer is a 404 that says so.
 *  2. The most specific path wins: compared segment by segment from the left, literal > mixed > wildcard
 *     (`/users/me` beats `/users/:id`).
 *  3. Query parameters: an example whose saved parameters all appear in the request with the same values (a `{{var}}`,
 *     `:var` or empty value matches any value) beats one that has a parameter the request lacks or sets differently;
 *     among those, the one matching more parameters wins (`/users?page=2` answers `?page=2`, `/users` the rest).
 *  4. The request body: an example whose saved request body equals the incoming one (JSON compared by value, other text
 *     trimmed) wins.
 *  5. Ties go to the first example in collection order.
 */

export type MockSegment = { kind: 'literal'; value: string } | { kind: 'mixed'; re: RegExp } | { kind: 'wildcard' }

/** A saved query parameter; `value` null matches any value (template, `:var` or empty). */
export interface MockQueryParam {
  key: string
  value: string | null
}

export interface MockRoute<T> {
  method: string
  segments: MockSegment[]
  query: MockQueryParam[]
  /** Position in the list given to `compileMockRoutes` (collection order). */
  order: number
  example: T
}

/** What the matcher needs to know about an example. */
export interface MockRouteSource {
  method: string
  url: string
  name: string
  code: number | null
  /** A Postman example id when the example has one (`x-mock-response-id`). */
  id?: string | null
  /** Raw body of the example's saved request (tie-breaker, see the header comment). */
  requestBody?: string | null
  /** Headers of the example's saved request (for `x-mock-match-request-headers`). */
  requestHeaders?: ReadonlyArray<{ key: string; value: string }> | null
}

export interface MockRequestInfo {
  method: string
  /** Path, optionally with a query string (`/users/1?x=1`). */
  path: string
  /** Header lookup by lower-case name. */
  header: (name: string) => string | undefined
  /** The request body as text (undefined/'' when there was none). */
  body?: string
}

export type MockMatch<T> = { route: MockRoute<T>; reason: null } | { route: null; reason: string }

const TEMPLATE = /\{\{[^{}]*\}\}/g
const SCHEME = /^(?:[A-Za-z][A-Za-z0-9+.-]*|\{\{[^{}]*\}\}):\/\//

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** The path part of an example's saved URL (always starts with '/'). */
export function mockPathOf(url: string): string {
  let rest = url.trim().replace(/#.*$/, '')
  const q = rest.indexOf('?')
  if (q >= 0) rest = rest.slice(0, q)
  if (SCHEME.test(rest)) {
    rest = rest.replace(SCHEME, '')
    const slash = rest.indexOf('/')
    rest = slash >= 0 ? rest.slice(slash) : '/'
  } else if (!rest.startsWith('/')) {
    // `{{baseUrl}}/users`, `{{host}}:{{port}}/users`, `localhost:3000/users`, `api.example.com/users`: the first part is
    // the server (as Postman reads a URL without a scheme).
    const slash = rest.indexOf('/')
    rest = slash >= 0 ? rest.slice(slash) : '/'
  }
  return rest || '/'
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function compileMockPath(path: string): MockSegment[] {
  return path
    .split('/')
    .filter((s) => s !== '')
    .map((raw): MockSegment => {
      if (/^:./.test(raw)) return { kind: 'wildcard' }
      const templates = raw.match(TEMPLATE)
      if (!templates) return { kind: 'literal', value: decode(raw) }
      const parts = raw.split(TEMPLATE)
      // Only templates (`{{id}}`, `{{a}}{{b}}`): any one segment.
      if (parts.every((p) => p === '')) return { kind: 'wildcard' }
      // Text and templates (`v{{n}}`, `{{id}}.json`): the template parts match any text, also none (`v`).
      return { kind: 'mixed', re: new RegExp(`^${parts.map((p) => escapeRegExp(decode(p))).join('.*?')}$`) }
    })
}

/** Saved query parameters of an example's URL (templates, `:var` and empty values match anything). */
export function mockQueryOf(url: string): MockQueryParam[] {
  const raw = url.trim().replace(/#.*$/, '')
  const q = raw.indexOf('?')
  if (q < 0) return []
  return raw
    .slice(q + 1)
    .split('&')
    .filter((p) => p !== '')
    .map((pair) => {
      const eq = pair.indexOf('=')
      const key = decode((eq < 0 ? pair : pair.slice(0, eq)).replace(/\+/g, ' '))
      const value = eq < 0 ? '' : decode(pair.slice(eq + 1).replace(/\+/g, ' '))
      const wild = value === '' || /^:./.test(value) || /^\{\{[^{}]*\}\}$/.test(value)
      return { key, value: wild ? null : value }
    })
    .filter((p) => p.key !== '')
}

export function compileMockRoutes<T extends MockRouteSource>(examples: readonly T[]): MockRoute<T>[] {
  return examples.map((example, order) => ({
    method: example.method.trim().toUpperCase() || 'GET',
    segments: compileMockPath(mockPathOf(example.url)),
    query: mockQueryOf(example.url),
    order,
    example,
  }))
}

/** Query parameters of an incoming request (all values of a repeated key). */
function requestQuery(path: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const q = path.indexOf('?')
  if (q < 0) return out
  for (const pair of path.slice(q + 1).replace(/#.*$/, '').split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    const key = decode((eq < 0 ? pair : pair.slice(0, eq)).replace(/\+/g, ' '))
    const value = eq < 0 ? '' : decode(pair.slice(eq + 1).replace(/\+/g, ' '))
    out.set(key, [...(out.get(key) ?? []), value])
  }
  return out
}

/** -1: a saved parameter is missing or different; otherwise how many saved parameters the request matches. */
function queryScore(saved: MockQueryParam[], query: Map<string, string[]>): number {
  let score = 0
  for (const p of saved) {
    const values = query.get(p.key)
    if (!values) return -1
    if (p.value !== null && !values.includes(p.value)) return -1
    score++
  }
  return score
}

/**
 * Form fields as a comparable string: pairs sorted by name then value, so field order and `+` vs `%20` do not matter.
 * Null when the text is not form-shaped.
 */
function formKey(pairs: Array<[string, string]>): string | null {
  if (pairs.length === 0) return null
  return JSON.stringify([...pairs].sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1)))
}

function urlEncodedPairs(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const pair of text.trim().split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    out.push([decode((eq < 0 ? pair : pair.slice(0, eq)).replace(/\+/g, ' ')), eq < 0 ? '' : decode(pair.slice(eq + 1).replace(/\+/g, ' '))])
  }
  return out
}

/** The text fields of a multipart/form-data body (file parts are left out, as the saved form keeps text fields only). */
function multipartPairs(text: string, contentType: string): Array<[string, string]> {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)
  const boundary = m?.[1] ?? m?.[2]
  if (!boundary) return []
  const out: Array<[string, string]> = []
  for (const part of text.split(`--${boundary}`)) {
    const split = part.indexOf('\r\n\r\n')
    if (split < 0) continue
    const head = part.slice(0, split)
    const name = /content-disposition:[^\r\n]*\bname="([^"]*)"/i.exec(head)?.[1]
    if (name === undefined || /\bfilename\*?=/i.test(head)) continue
    out.push([name, part.slice(split + 4).replace(/\r\n$/, '')])
  }
  return out
}

/** The incoming body in comparable form, and whether it is a form (then saved bodies are read as forms too). */
function incomingBody(text: string | undefined, contentType: string | undefined): { value: string; form: boolean } | null {
  const ct = (contentType ?? '').toLowerCase()
  if (text && ct.includes('application/x-www-form-urlencoded')) {
    const key = formKey(urlEncodedPairs(text))
    return key === null ? null : { value: key, form: true }
  }
  if (text && ct.includes('multipart/form-data')) {
    const key = formKey(multipartPairs(text, contentType ?? ''))
    return key === null ? null : { value: key, form: true }
  }
  const value = normalizeBody(text)
  return value === null ? null : { value, form: false }
}

/** A saved request body (forms are saved as `a=1&b=2`) in the same comparable form. */
function savedBody(text: string | null | undefined, form: boolean): string | null {
  return form ? formKey(urlEncodedPairs(text ?? '')) : normalizeBody(text)
}

/** A body in comparable form: JSON by value (key order ignored), anything else trimmed. */
function normalizeBody(text: string | null | undefined): string | null {
  const t = (text ?? '').trim()
  if (!t) return null
  try {
    return JSON.stringify(sortKeys(JSON.parse(t)))
  } catch {
    return t
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as object).sort().map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]))
  }
  return value
}

/** Path of an incoming request as segments (query dropped, percent-decoded, empty segments ignored). */
export function requestSegments(path: string): string[] {
  // A request target in absolute form (`GET http://127.0.0.1:4010/users`, as proxies send it): only its path counts.
  const target = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(path) ? path.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/, '') || '/' : path
  const q = target.search(/[?#]/)
  return (q >= 0 ? target.slice(0, q) : target)
    .split('/')
    .filter((s) => s !== '')
    .map(decode)
}

function pathMatches(route: MockSegment[], segments: string[]): boolean {
  if (route.length !== segments.length) return false
  return route.every((s, i) => {
    const value = segments[i]!
    if (s.kind === 'wildcard') return true
    if (s.kind === 'literal') return s.value === value
    return s.re.test(value)
  })
}

const RANK = { literal: 2, mixed: 1, wildcard: 0 } as const

/** Negative when `a`'s path is more specific than `b`'s (0: equally specific). */
function pathSpecificity<T>(a: MockRoute<T>, b: MockRoute<T>): number {
  for (let i = 0; i < a.segments.length; i++) {
    const d = RANK[b.segments[i]!.kind] - RANK[a.segments[i]!.kind]
    if (d !== 0) return d
  }
  return 0
}

function quoteList(values: string[]): string {
  const unique = [...new Set(values)]
  const shown = unique.slice(0, 5).map((v) => `"${v}"`)
  return unique.length > 5 ? `${shown.join(', ')}, ...` : shown.join(', ')
}

export function matchMockRequest<T extends MockRouteSource>(routes: readonly MockRoute<T>[], req: MockRequestInfo): MockMatch<T> {
  const method = req.method.toUpperCase()
  const segments = requestSegments(req.path)
  const display = `${method} /${segments.join('/')}`
  const onPath = routes.filter((r) => pathMatches(r.segments, segments))
  let candidates = onPath.filter((r) => r.method === method)
  if (candidates.length === 0 && method === 'HEAD') candidates = onPath.filter((r) => r.method === 'GET')
  if (candidates.length === 0) {
    if (routes.length === 0) return { route: null, reason: 'This collection has no saved examples.' }
    if (onPath.length > 0) {
      const methods = [...new Set(onPath.map((r) => r.method))].join(', ')
      return { route: null, reason: `No saved example for ${display}; examples on this path use ${methods}.` }
    }
    return { route: null, reason: `No saved example matches ${display}.` }
  }

  const id = req.header('x-mock-response-id')?.trim()
  const name = req.header('x-mock-response-name')?.trim()
  const codeText = req.header('x-mock-response-code')?.trim()
  if (id) {
    const narrowed = candidates.filter((r) => r.example.id === id)
    if (narrowed.length === 0) return { route: null, reason: `No example with id "${id}" matches ${display}.` }
    candidates = narrowed
  }
  if (name) {
    const wanted = name.toLowerCase()
    const narrowed = candidates.filter((r) => r.example.name.trim().toLowerCase() === wanted)
    if (narrowed.length === 0) {
      return { route: null, reason: `No example named "${name}" matches ${display} (examples: ${quoteList(candidates.map((r) => r.example.name))}).` }
    }
    candidates = narrowed
  }
  if (codeText) {
    // Compared with the status the example is really answered with (an out-of-range code is sent as 200).
    const narrowed = candidates.filter((r) => String(mockStatus(r.example.code)) === codeText)
    if (narrowed.length === 0) {
      const codes = candidates.map((r) => String(mockStatus(r.example.code)))
      return { route: null, reason: `No example with status ${codeText} matches ${display} (statuses: ${[...new Set(codes)].join(', ')}).` }
    }
    candidates = narrowed
  }
  const matchHeaders = (req.header('x-mock-match-request-headers') ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h && !h.startsWith('x-mock-'))
  if (matchHeaders.length > 0) {
    const narrowed = candidates.filter((r) => matchHeaders.every((h) => savedHeaderMatches(r.example.requestHeaders, h, req.header(h))))
    if (narrowed.length === 0) return { route: null, reason: `No example of ${display} has saved request headers matching ${quoteList(matchHeaders)}.` }
    candidates = narrowed
  }
  const body = incomingBody(req.body, req.header('content-type'))
  const sameBody = (saved: string | null | undefined) => body !== null && savedBody(saved, body.form) === body.value
  if (req.header('x-mock-match-request-body')?.trim().toLowerCase() === 'true') {
    const narrowed = candidates.filter((r) => sameBody(r.example.requestBody))
    if (narrowed.length === 0) return { route: null, reason: `No example of ${display} has a saved request body equal to this one.` }
    candidates = narrowed
  }
  const query = requestQuery(req.path)
  const ranked = candidates.map((route) => ({
    route,
    query: queryScore(route.query, query),
    body: sameBody(route.example.requestBody) ? 1 : 0,
  }))
  ranked.sort((a, b) => pathSpecificity(a.route, b.route) || b.query - a.query || b.body - a.body || a.route.order - b.route.order)
  return { route: ranked[0]!.route, reason: null }
}

/** Does the saved request have header `name` (lower case) with the incoming value? A `{{var}}` saved value matches any. */
function savedHeaderMatches(saved: MockRouteSource['requestHeaders'], name: string, incoming: string | undefined): boolean {
  if (incoming === undefined) return false
  const values = (saved ?? []).filter((h) => h.key.trim().toLowerCase() === name).map((h) => h.value.trim())
  return values.some((v) => /^\{\{[^{}]*\}\}$/.test(v) || v === incoming.trim())
}

/** Response headers that would break the mock's answer: the server sets its own framing, and bodies are stored decoded. */
const DROPPED_HEADERS = new Set([
  'content-length',
  'transfer-encoding',
  'content-encoding',
  'connection',
  'keep-alive',
  'proxy-connection',
  'upgrade',
  'trailer',
  'te',
])

/** The example's headers the mock sends, grouped by name (first spelling kept) in order. */
export function mockResponseHeaders(headers: readonly { key: string; value: string }[]): [string, string[]][] {
  const out = new Map<string, [string, string[]]>()
  for (const h of headers) {
    const key = h.key.trim()
    if (!key || DROPPED_HEADERS.has(key.toLowerCase())) continue
    const entry = out.get(key.toLowerCase())
    if (entry) entry[1].push(h.value)
    else out.set(key.toLowerCase(), [key, [h.value]])
  }
  return [...out.values()]
}

/** Status the mock answers with: the example's code when it is a final HTTP status (200-599), otherwise 200. */
export function mockStatus(code: number | null): number {
  return code !== null && Number.isInteger(code) && code >= 200 && code <= 599 ? code : 200
}

/** Body of the 404 sent when nothing matched. */
export function mockNotFoundBody(reason: string): string {
  return `${JSON.stringify(
    {
      error: 'mockRequestNotFound',
      message: reason,
      hint: 'A request matches a saved example of the collection by method and path. Choose among several with the x-mock-response-name or x-mock-response-code header.',
    },
    null,
    2,
  )}\n`
}

/** An Origin served from this computer: http(s) on localhost, 127.0.0.1, [::1] or a *.localhost name (any port). */
export function isLoopbackOrigin(origin: string): boolean {
  const m = /^https?:\/\/(\[::1\]|[^/:]+)(?::\d+)?$/i.exec(origin.trim())
  if (!m) return false
  const host = m[1]!.toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost')
}

/** Whether a browser page with this Origin may read the mock's answers ('null' and other origins only with 'any'). */
export function corsOriginAllowed(cors: 'local' | 'any', origin: string | undefined): boolean {
  if (!origin) return false
  return cors === 'any' || isLoopbackOrigin(origin)
}

/** Host header values the mock accepts (loopback names only; stops DNS-rebinding pages from reading it). */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return true
  const name = host.trim().toLowerCase().replace(/:\d+$/, '')
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name.endsWith('.localhost')
}
