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
 *  1. Postman's selection headers narrow the list: `x-mock-response-id`, `x-mock-response-name` (case-insensitive) and
 *     `x-mock-response-code`. When they leave nothing, the answer is a 404 that says so.
 *  2. The most specific path wins: compared segment by segment from the left, literal > mixed > wildcard
 *     (`/users/me` beats `/users/:id`).
 *  3. Ties go to the first example in collection order.
 */

export type MockSegment = { kind: 'literal'; value: string } | { kind: 'mixed'; re: RegExp } | { kind: 'wildcard' }

export interface MockRoute<T> {
  method: string
  segments: MockSegment[]
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
}

export interface MockRequestInfo {
  method: string
  /** Path, optionally with a query string (`/users/1?x=1`). */
  path: string
  /** Header lookup by lower-case name. */
  header: (name: string) => string | undefined
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
      if (templates.length === 1 && templates[0] === raw) return { kind: 'wildcard' }
      const parts = raw.split(TEMPLATE).map((p) => escapeRegExp(decode(p)))
      return { kind: 'mixed', re: new RegExp(`^${parts.join('.+?')}$`) }
    })
}

export function compileMockRoutes<T extends MockRouteSource>(examples: readonly T[]): MockRoute<T>[] {
  return examples.map((example, order) => ({
    method: example.method.trim().toUpperCase() || 'GET',
    segments: compileMockPath(mockPathOf(example.url)),
    order,
    example,
  }))
}

/** Path of an incoming request as segments (query dropped, percent-decoded, empty segments ignored). */
export function requestSegments(path: string): string[] {
  const q = path.search(/[?#]/)
  return (q >= 0 ? path.slice(0, q) : path)
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

/** Negative when `a` is more specific than `b`. */
function bySpecificity<T>(a: MockRoute<T>, b: MockRoute<T>): number {
  for (let i = 0; i < a.segments.length; i++) {
    const d = RANK[b.segments[i]!.kind] - RANK[a.segments[i]!.kind]
    if (d !== 0) return d
  }
  return a.order - b.order
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
    const narrowed = candidates.filter((r) => String(r.example.code ?? 200) === codeText)
    if (narrowed.length === 0) {
      const codes = candidates.map((r) => String(r.example.code ?? 200))
      return { route: null, reason: `No example with status ${codeText} matches ${display} (statuses: ${[...new Set(codes)].join(', ')}).` }
    }
    candidates = narrowed
  }
  return { route: [...candidates].sort(bySpecificity)[0]!, reason: null }
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

/** Host header values the mock accepts (loopback names only; stops DNS-rebinding pages from reading it). */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return true
  const name = host.trim().toLowerCase().replace(/:\d+$/, '')
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name.endsWith('.localhost')
}
