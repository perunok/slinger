/**
 * Mock servers, renderer side (pure). The main process serves a collection's saved examples on 127.0.0.1
 * (electron/services/mockServers.ts, matching in shared/mockMatch.ts); this module turns the collection's request
 * documents into the `MockExample` list it serves, picks ports, remembers per collection its port, options and whether it
 * starts with Slinger, and formats log entries for the request inspector.
 */
import {
  DEFAULT_MOCK_OPTIONS,
  MOCK_MAX_DELAY_MS,
  type ApiFolder,
  type ApiRequest,
  type MockExample,
  type MockServerOptions,
  type RequestHeader,
} from '../../shared/types'
import { exampleName, mimeForLanguage, parseExample, readExamples } from './examples'
import { dataRows } from './kv'
import { MCP_METHOD } from './mcpRequest'
import type { BodyDraft } from './request'
import { buildTree, type TreeNode } from './tree'

/** First port offered for a collection that never had a mock server (Prism's default, rarely taken by dev servers). */
export const DEFAULT_MOCK_PORT = 4010
export const MOCK_SETTINGS_KEY = 'slinger.mockServers'

/** Requests of a collection in sidebar order (folders first, depth first), like the collection runner. */
function orderedRequests(nodes: TreeNode[], out: ApiRequest[] = []): ApiRequest[] {
  for (const n of nodes) {
    if (n.kind === 'folder') orderedRequests(n.children, out)
    else out.push(n.request)
  }
  return out
}

/** MCP requests (method MCP or a document with an `mcp` object) are not HTTP: a mock server never serves their examples. */
function isMcpRequest(request: ApiRequest): boolean {
  if (request.method.trim().toUpperCase() === MCP_METHOD) return true
  if (!request.documentJson.includes('"mcp"')) return false
  try {
    const doc: unknown = JSON.parse(request.documentJson)
    const mcp = doc && typeof doc === 'object' ? (doc as { mcp?: unknown }).mcp : null
    return !!mcp && typeof mcp === 'object' && !Array.isArray(mcp)
  } catch {
    return false
  }
}

/**
 * The body text an example's saved request sends, for the mock's body tie-breaker and nothing else: raw text as is,
 * url-encoded and form-data fields as `a=1&b=2` (enabled text fields), a GraphQL body as the JSON a client posts. Null when
 * there is none (no body, a file, an empty text).
 */
export function mockRequestBody(body: BodyDraft): string | null {
  const form = (rows: BodyDraft['urlEncoded']) => {
    const params = new URLSearchParams()
    for (const r of dataRows(rows)) if (r.enabled && r.key !== '' && r.kind !== 'file') params.append(r.key, r.value)
    return params.toString() || null
  }
  switch (body.kind) {
    case 'raw':
      return body.raw === '' ? null : body.raw
    case 'urlEncoded':
      return form(body.urlEncoded)
    case 'formData':
      return form(body.formData)
    case 'unsupported': {
      const b = body.preserved
      if (!b || typeof b !== 'object' || (b as { mode?: unknown }).mode !== 'graphql') return null
      const g = (b as { graphql?: unknown }).graphql
      if (!g || typeof g !== 'object') return null
      const { query, variables } = g as { query?: unknown; variables?: unknown }
      if (typeof query !== 'string' || !query.trim()) return null
      const out: Record<string, unknown> = { query }
      if (typeof variables === 'string' && variables.trim()) {
        try {
          out.variables = JSON.parse(variables)
        } catch {
          // Unparsable variables: the query alone.
        }
      } else if (variables && typeof variables === 'object') out.variables = variables
      return JSON.stringify(out)
    }
    default:
      return null
  }
}

function hasHeader(headers: RequestHeader[], name: string): boolean {
  const lower = name.toLowerCase()
  return headers.some((h) => h.key.trim().toLowerCase() === lower)
}

/**
 * Every saved example of the collection, in collection order, as the mock server serves it: method, URL and body from the
 * example's saved request (else the parent request), enabled headers, and a Content-Type from the example's preview
 * language when it has none. MCP requests are skipped.
 */
export function collectMockExamples(folders: ApiFolder[], requests: ApiRequest[]): MockExample[] {
  const out: MockExample[] = []
  for (const request of orderedRequests(buildTree(folders, requests))) {
    if (!request.documentJson?.includes('"responses"') || isMcpRequest(request)) continue
    readExamples(request.documentJson).forEach((stored, exampleIndex) => {
      const parsed = parseExample(stored, request)
      const r = parsed.response
      const headers = dataRows(r.headers)
        .filter((h) => h.enabled && h.key.trim())
        .map((h) => ({ key: h.key.trim(), value: h.value }))
      const mime = r.bodyEncoding ? '' : mimeForLanguage(r.language)
      if (mime && r.body && !hasHeader(headers, 'content-type')) headers.push({ key: 'Content-Type', value: `${mime}; charset=utf-8` })
      out.push({
        requestId: request.id,
        exampleIndex,
        requestName: request.name,
        name: exampleName(stored),
        method: (parsed.request.method || request.method || 'GET').toUpperCase(),
        url: parsed.request.url,
        code: r.code !== null && r.code >= 100 && r.code <= 999 ? r.code : null,
        status: r.status,
        headers,
        body: r.body,
        bodyEncoding: r.bodyEncoding,
        requestBody: mockRequestBody(parsed.request.body),
      })
    })
  }
  return out
}

/**
 * Changes whenever the examples a collection serves could have changed (a request saved, added, moved, deleted, or a
 * folder moved), without parsing any document. Used to push edits to a running server.
 */
export function mockSourceKey(folders: ApiFolder[], requests: ApiRequest[]): string {
  const f = folders.map((x) => `${x.id}:${x.parentFolderId ?? ''}:${x.sortOrder}`).sort()
  const r = requests.map((x) => `${x.id}:${x.version}:${x.folderId ?? ''}:${x.sortOrder}:${x.name}`).sort()
  return `${f.join(',')}|${r.join(',')}`
}

export const mockBaseUrl = (port: number) => `http://127.0.0.1:${port}`

/** The port typed into the field, or an error message. */
export function parsePort(text: string): { port: number; error: null } | { port: null; error: string } {
  const t = text.trim()
  if (!/^\d{1,5}$/.test(t)) return { port: null, error: 'Enter a port number between 1024 and 65535.' }
  const port = Number(t)
  if (port < 1 || port > 65535) return { port: null, error: 'Enter a port number between 1024 and 65535.' }
  if (port < 1024) return { port: null, error: 'Ports below 1024 need administrator rights: choose one between 1024 and 65535.' }
  return { port, error: null }
}

/** The port to offer: the one this collection used last, else the first free one from DEFAULT_MOCK_PORT up. */
export function suggestPort(remembered: number | undefined, used: ReadonlySet<number>): number {
  if (remembered && !used.has(remembered)) return remembered
  let port = DEFAULT_MOCK_PORT
  while (used.has(port) && port < 65535) port++
  return port
}

// ---------------------------------------------------------------------------
// Remembered settings
// ---------------------------------------------------------------------------

/** What Slinger remembers about a collection's mock server. */
export interface MockCollectionSettings {
  /** Last port it ran on (null: never started). */
  port: number | null
  options: MockServerOptions
  /** Start it again when Slinger starts, if it was running when Slinger quit (default on). */
  startWithSlinger: boolean
}

/** A mock server that was running when Slinger last quit (or still runs). */
export interface MockRunningEntry {
  collectionId: string
  workspaceId: string
}

export interface MockSettings {
  collections: Record<string, MockCollectionSettings>
  running: MockRunningEntry[]
}

/**
 * `localStorage['slinger.mockServers']` =
 * `{ "v": 2, "collections": { "<collectionId>": { "port": 4010, "options": { "cors": "local", "delayMs": 0 },
 * "startWithSlinger": true } }, "running": [{ "collectionId": "...", "workspaceId": "..." }] }`.
 * The first format, `{ "ports": { "<collectionId>": 4010 } }`, is read as ports with default options.
 */
export const MOCK_SETTINGS_VERSION = 2

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const validPort = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 65535

export const emptyMockSettings = (): MockSettings => ({ collections: {}, running: [] })

export function defaultCollectionSettings(): MockCollectionSettings {
  return { port: null, options: { ...DEFAULT_MOCK_OPTIONS }, startWithSlinger: true }
}

/** Options from anything (stored JSON, a partial edit): unknown CORS values are 'local', the delay is clamped. */
export function normalizeMockOptions(value: unknown): MockServerOptions {
  const o = isObj(value) ? value : {}
  const delay = typeof o.delayMs === 'number' && Number.isFinite(o.delayMs) ? Math.round(o.delayMs) : DEFAULT_MOCK_OPTIONS.delayMs
  return { cors: o.cors === 'any' ? 'any' : 'local', delayMs: Math.min(MOCK_MAX_DELAY_MS, Math.max(0, delay)) }
}

export function parseMockSettings(raw: string | null | undefined): MockSettings {
  const out = emptyMockSettings()
  let parsed: unknown
  try {
    parsed = raw ? JSON.parse(raw) : null
  } catch {
    return out
  }
  if (!isObj(parsed)) return out
  // Version 1: ports only.
  if (isObj(parsed.ports)) {
    for (const [id, port] of Object.entries(parsed.ports)) {
      if (validPort(port)) out.collections[id] = { ...defaultCollectionSettings(), port }
    }
  }
  if (isObj(parsed.collections)) {
    for (const [id, c] of Object.entries(parsed.collections)) {
      if (!isObj(c)) continue
      out.collections[id] = {
        port: validPort(c.port) ? c.port : null,
        options: normalizeMockOptions(c.options),
        startWithSlinger: c.startWithSlinger !== false,
      }
    }
  }
  if (Array.isArray(parsed.running)) {
    const seen = new Set<string>()
    for (const r of parsed.running) {
      if (!isObj(r) || typeof r.collectionId !== 'string' || typeof r.workspaceId !== 'string' || !r.collectionId || seen.has(r.collectionId)) continue
      seen.add(r.collectionId)
      out.running.push({ collectionId: r.collectionId, workspaceId: r.workspaceId })
    }
  }
  return out
}

export function loadMockSettings(storage: Pick<Storage, 'getItem'> | null): MockSettings {
  try {
    return parseMockSettings(storage?.getItem(MOCK_SETTINGS_KEY))
  } catch {
    return emptyMockSettings()
  }
}

export function saveMockSettings(storage: Pick<Storage, 'setItem'> | null, settings: MockSettings): void {
  try {
    storage?.setItem(MOCK_SETTINGS_KEY, JSON.stringify({ v: MOCK_SETTINGS_VERSION, ...settings }))
  } catch {
    // Storage unavailable or full: the settings are just not remembered.
  }
}

/** Loads, changes and saves the settings in one go. */
export function updateMockSettings(storage: Pick<Storage, 'getItem' | 'setItem'> | null, fn: (s: MockSettings) => MockSettings): MockSettings {
  const next = fn(loadMockSettings(storage))
  saveMockSettings(storage, next)
  return next
}

/** A collection's settings, defaults filled in. */
export function collectionMockSettings(settings: MockSettings, collectionId: string): MockCollectionSettings {
  return settings.collections[collectionId] ?? defaultCollectionSettings()
}

export function withCollectionSettings(settings: MockSettings, collectionId: string, patch: Partial<MockCollectionSettings>): MockSettings {
  const current = collectionMockSettings(settings, collectionId)
  const next = { ...current, ...patch }
  if (patch.options) next.options = normalizeMockOptions(patch.options)
  return { ...settings, collections: { ...settings.collections, [collectionId]: next } }
}

/** Adds the collection to the running list (or moves it to another workspace id), or removes it. */
export function withRunning(settings: MockSettings, entry: MockRunningEntry, running: boolean): MockSettings {
  const rest = settings.running.filter((r) => r.collectionId !== entry.collectionId)
  return { ...settings, running: running ? [...rest, { collectionId: entry.collectionId, workspaceId: entry.workspaceId }] : rest }
}

/** Drops everything remembered about a collection (it was deleted). */
export function withoutCollection(settings: MockSettings, collectionId: string): MockSettings {
  const { [collectionId]: _gone, ...collections } = settings.collections
  return { collections, running: settings.running.filter((r) => r.collectionId !== collectionId) }
}

/** The delay typed into the field (whole milliseconds, 0-60000), or an error message. */
export function parseDelay(text: string): { delayMs: number; error: null } | { delayMs: null; error: string } {
  const t = text.trim()
  if (t === '') return { delayMs: 0, error: null }
  if (!/^\d{1,6}$/.test(t) || Number(t) > MOCK_MAX_DELAY_MS) return { delayMs: null, error: `Enter a delay between 0 and ${MOCK_MAX_DELAY_MS} ms.` }
  return { delayMs: Number(t), error: null }
}

// ---------------------------------------------------------------------------
// Request inspector
// ---------------------------------------------------------------------------

const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key'])

/** Headers whose values the inspector never shows in full (credentials, sent by the client or set by an example). */
export function isCredentialHeader(name: string): boolean {
  const n = name.trim().toLowerCase()
  return CREDENTIAL_HEADERS.has(n) || n.includes('token') || n.includes('secret')
}

/**
 * A credential shortened for display: the first 6 characters (fewer for short values, at most half of it), '…' and the
 * length. Other headers are returned as they are.
 */
export function displayHeaderValue(name: string, value: string): string {
  if (!isCredentialHeader(name)) return value
  const shown = value.slice(0, Math.min(6, Math.floor(value.length / 2)))
  return `${shown}… (${value.length} ${value.length === 1 ? 'character' : 'characters'})`
}

/** Query parameters of a logged path (`/users?a=1&b=x%20y`), decoded, in order. */
export function queryParams(path: string): Array<[string, string]> {
  const q = path.indexOf('?')
  if (q < 0) return []
  const query = path.slice(q + 1).replace(/#.*$/, '')
  if (!query) return []
  try {
    return [...new URLSearchParams(query).entries()]
  } catch {
    return []
  }
}

/** The path of a logged request without its query. */
export function pathOnly(path: string): string {
  const q = path.indexOf('?')
  return q < 0 ? path : path.slice(0, q)
}

/** A logged text body for display: pretty-printed when it is JSON, else as sent. */
export function prettyBody(body: string): { text: string; json: boolean } {
  const t = body.trim()
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return { text: JSON.stringify(JSON.parse(t), null, 2), json: true }
    } catch {
      // Not JSON after all.
    }
  }
  return { text: body, json: false }
}

/** "12:04:31" for a log entry's Unix-seconds time. */
export function logTime(at: number): string {
  const d = new Date(at * 1000)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
}
