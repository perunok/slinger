/**
 * Mock servers, renderer side (pure). The main process serves a collection's saved examples on 127.0.0.1
 * (electron/services/mockServers.ts, matching in shared/mockMatch.ts); this module turns the collection's request
 * documents into the `MockExample` list it serves, picks ports and remembers the last one per collection.
 */
import type { ApiFolder, ApiRequest, MockExample, RequestHeader } from '../../shared/types'
import { exampleName, mimeForLanguage, parseExample, readExamples } from './examples'
import { dataRows } from './kv'
import { buildTree, type TreeNode } from './tree'

/** First port offered for a collection that never had a mock server (Prism's default, rarely taken by dev servers). */
export const DEFAULT_MOCK_PORT = 4010
export const MOCK_PORTS_KEY = 'slinger.mockServers'

/** Requests of a collection in sidebar order (folders first, depth first), like the collection runner. */
function orderedRequests(nodes: TreeNode[], out: ApiRequest[] = []): ApiRequest[] {
  for (const n of nodes) {
    if (n.kind === 'folder') orderedRequests(n.children, out)
    else out.push(n.request)
  }
  return out
}

function hasHeader(headers: RequestHeader[], name: string): boolean {
  const lower = name.toLowerCase()
  return headers.some((h) => h.key.trim().toLowerCase() === lower)
}

/**
 * Every saved example of the collection, in collection order, as the mock server serves it: method and URL from the
 * example's saved request (else the parent request), enabled headers, and a Content-Type from the example's preview
 * language when it has none.
 */
export function collectMockExamples(folders: ApiFolder[], requests: ApiRequest[]): MockExample[] {
  const out: MockExample[] = []
  for (const request of orderedRequests(buildTree(folders, requests))) {
    if (!request.documentJson?.includes('"responses"')) continue
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

/** `localStorage['slinger.mockServers']` = `{ "ports": { "<collectionId>": 4010 } }` (last port per collection). */
export function loadMockPorts(storage: Pick<Storage, 'getItem'> | null): Record<string, number> {
  try {
    const raw = storage?.getItem(MOCK_PORTS_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    const ports = parsed && typeof parsed === 'object' ? (parsed as { ports?: unknown }).ports : null
    if (!ports || typeof ports !== 'object') return {}
    return Object.fromEntries(
      Object.entries(ports as Record<string, unknown>).filter((e): e is [string, number] => Number.isInteger(e[1]) && (e[1] as number) >= 1 && (e[1] as number) <= 65535),
    )
  } catch {
    return {}
  }
}

export function saveMockPort(storage: Pick<Storage, 'getItem' | 'setItem'> | null, collectionId: string, port: number): void {
  try {
    const ports = { ...loadMockPorts(storage), [collectionId]: port }
    storage?.setItem(MOCK_PORTS_KEY, JSON.stringify({ ports }))
  } catch {
    // Storage unavailable or full: the port is just not remembered.
  }
}

/** "12:04:31" for a log entry's Unix-seconds time. */
export function logTime(at: number): string {
  const d = new Date(at * 1000)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
}
