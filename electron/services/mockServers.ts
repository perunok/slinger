/**
 * Mock servers: a collection's saved examples served over HTTP on 127.0.0.1 (see docs/ARCHITECTURE.md, "Mock servers").
 *
 * Local-only and in memory: nothing is written to the database; every server stops when the app quits. The renderer
 * resolves the examples from the request documents (opaque to main) and sends them on start and whenever they change
 * (`update`); matching is shared/mockMatch.ts. Plain Node (no Electron import), so tests run real servers.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { STATUS_CODES } from 'node:http'
import { corsOriginAllowed, compileMockRoutes, isLoopbackHost, matchMockRequest, mockNotFoundBody, mockResponseHeaders, mockStatus, type MockRoute } from '../../shared/mockMatch'
import {
  DEFAULT_MOCK_OPTIONS,
  MOCK_LOG_BODY_LIMIT,
  MOCK_LOG_LIMIT,
  type MockExample,
  type MockServerEvent,
  type MockServerInfo,
  type MockServerLogEntry,
  type MockServerOptions,
} from '../../shared/types'
import { invalidInput, ioError, notFound } from '../lib/errors'

export const MOCK_HOST = '127.0.0.1'
/** Upper bound for all example bodies of one server together (characters). */
export const MOCK_TOTAL_BODY_LIMIT = 200 * 1024 * 1024
/** Request bodies are read up to this size for matching and the log; the rest is drained unread. */
export const MOCK_REQUEST_BODY_LIMIT = 10 * 1024 * 1024
const PATH_LOG_LIMIT = 2000
/** Header values kept in the log are cut to this length. */
const HEADER_LOG_LIMIT = 4096
/** Statuses that never carry a body (RFC 9110). */
const NO_BODY_STATUS = new Set([204, 205, 304])

interface Running {
  info: MockServerInfo
  server: Server
  routes: MockRoute<MockExample>[]
  log: MockServerLogEntry[]
  seq: number
  /** Answers waiting for the delay (cleared on stop). */
  delays: Set<ReturnType<typeof setTimeout>>
}

export interface MockServerDeps {
  /** Receives every MockServerEvent (main forwards them to the renderer). */
  emit?: (event: MockServerEvent) => void
  /** Unix seconds. */
  now?: () => number
}

function assertBodies(examples: readonly MockExample[]): void {
  let total = 0
  for (const e of examples) total += e.body.length
  if (total > MOCK_TOTAL_BODY_LIMIT) throw invalidInput('The saved examples are too large to serve together (over 200 MB of bodies)')
}

export class MockServers {
  private readonly servers = new Map<string, Running>()
  /** Collections whose start is in progress (a second start for the same collection waits for nothing: it is refused). */
  private readonly starting = new Set<string>()
  private readonly emit: (event: MockServerEvent) => void
  private readonly now: () => number

  constructor(deps: MockServerDeps = {}) {
    this.emit = deps.emit ?? (() => {})
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000))
  }

  list(): MockServerInfo[] {
    return [...this.servers.values()].map((r) => ({ ...r.info }))
  }

  log(collectionId: string): MockServerLogEntry[] {
    return [...(this.servers.get(collectionId)?.log ?? [])]
  }

  clearLog(collectionId: string): void {
    const running = this.servers.get(collectionId)
    if (running) running.log = []
  }

  /**
   * Starts serving `examples` for the collection on `port` (0 = any free port, for tests). A collection that is already
   * running on that port just gets the new examples; on another port the new server is bound first, so a busy port keeps
   * the old one running. A busy port is `io_error` with `details.reason === 'port_in_use'`.
   */
  async start(input: {
    workspaceId: string
    collectionId: string
    collectionName: string
    port: number
    examples: MockExample[]
    options?: MockServerOptions
  }): Promise<MockServerInfo> {
    assertBodies(input.examples)
    const existing = this.servers.get(input.collectionId)
    if (existing && existing.info.port === input.port) {
      if (input.options) this.setOptions(input.collectionId, input.options)
      return this.update(input.collectionId, input.examples, input.collectionName)
    }
    if (this.starting.has(input.collectionId)) throw invalidInput('This mock server is already starting')
    this.starting.add(input.collectionId)
    try {
      const running: Running = {
        info: {
          workspaceId: input.workspaceId,
          collectionId: input.collectionId,
          collectionName: input.collectionName,
          options: { ...(input.options ?? DEFAULT_MOCK_OPTIONS) },
          port: input.port,
          url: '',
          startedAt: this.now(),
          exampleCount: input.examples.length,
          requestCount: 0,
        },
        server: createServer(),
        routes: compileMockRoutes(input.examples),
        log: [],
        seq: 0,
        delays: new Set(),
      }
      running.server.on('request', (req, res) => {
        // Never an unhandled rejection in main: an unexpected failure is a 500 (or a closed connection once headers went out).
        this.handle(running, req, res).catch((err: unknown) => {
          if (!res.headersSent) sendJson(res, 500, `${JSON.stringify({ error: 'mockServerError', message: (err as Error)?.message ?? String(err) })}\n`)
          else res.destroy()
        })
      })
      // Idle keep-alive connections must not keep a stopped server (or the app) alive for long.
      running.server.keepAliveTimeout = 5000
      await listen(running.server, input.port)
      const port = (running.server.address() as AddressInfo).port
      running.info.port = port
      running.info.url = `http://${MOCK_HOST}:${port}`
      if (existing) await this.stop(input.collectionId, null, 'replaced')
      this.servers.set(input.collectionId, running)
      // A server that fails after it started (rare) is dropped and reported.
      running.server.on('error', (err) => {
        if (this.servers.get(input.collectionId) !== running) return
        this.servers.delete(input.collectionId)
        running.server.close()
        this.emit({ type: 'stopped', collectionId: input.collectionId, reason: err.message, by: 'error' })
      })
      this.emit({ type: 'started', server: { ...running.info } })
      return { ...running.info }
    } finally {
      this.starting.delete(input.collectionId)
    }
  }

  /** Replaces the examples of a running server (edits picked up live), and its collection name when given. */
  update(collectionId: string, examples: MockExample[], collectionName?: string): MockServerInfo {
    const running = this.servers.get(collectionId)
    if (!running) throw notFound('Mock server')
    assertBodies(examples)
    running.routes = compileMockRoutes(examples)
    running.info.exampleCount = examples.length
    const renamed = collectionName !== undefined && collectionName !== running.info.collectionName
    if (renamed) running.info.collectionName = collectionName
    if (renamed) this.emit({ type: 'updated', server: { ...running.info } })
    return { ...running.info }
  }

  /** CORS and delay of a running server; the next request uses them. */
  setOptions(collectionId: string, options: MockServerOptions): MockServerInfo {
    const running = this.servers.get(collectionId)
    if (!running) throw notFound('Mock server')
    running.info.options = { ...options }
    this.emit({ type: 'updated', server: { ...running.info } })
    return { ...running.info }
  }

  /** Stops the collection's server; nothing happens when it is not running. Open connections are closed. */
  async stop(collectionId: string, reason: string | null = null, by: 'user' | 'quit' | 'replaced' = 'user'): Promise<void> {
    const running = this.servers.get(collectionId)
    if (!running) return
    this.servers.delete(collectionId)
    for (const t of running.delays) clearTimeout(t)
    running.delays.clear()
    await new Promise<void>((resolve) => {
      running.server.close(() => resolve())
      running.server.closeAllConnections()
    })
    this.emit({ type: 'stopped', collectionId, reason, by })
  }

  /** App quit: stop everything (the renderer starts them again next time when the user chose so). */
  async stopAll(): Promise<void> {
    await Promise.all([...this.servers.keys()].map((id) => this.stop(id, 'app quit', 'quit')))
  }

  private async handle(running: Running, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const arrived = Date.now()
    const method = (req.method ?? 'GET').toUpperCase()
    const path = req.url ?? '/'
    const header = (name: string): string | undefined => {
      const v = req.headers[name]
      return Array.isArray(v) ? v[0] : v
    }
    const body = await readBody(req)
    if (res.destroyed) return
    const options = running.info.options
    const origin = header('origin')
    const cors = corsOriginAllowed(options.cors, origin)

    let status: number
    let kind: MockServerLogEntry['kind']
    let match: MockServerLogEntry['match'] = null
    let reason: string | null = null
    let send: () => void
    const preflight = method === 'OPTIONS' && origin !== undefined && header('access-control-request-method') !== undefined
    if (!isLoopbackHost(header('host'))) {
      kind = 'refused'
      reason = `Refused: Host "${header('host')}" is not a loopback name.`
      status = 403
      send = () => sendJson(res, status, `${JSON.stringify({ error: 'hostNotAllowed', message: reason })}\n`)
    } else if (preflight && !cors) {
      kind = 'refused'
      reason = `Refused a CORS preflight from ${origin}: only pages on this computer may call this mock server. Turn on "Allow any website" to allow it.`
      status = 403
      send = () => sendJson(res, status, `${JSON.stringify({ error: 'originNotAllowed', message: reason })}\n`)
    } else if (preflight) {
      kind = 'preflight'
      status = 204
      send = () => {
        res.setHeader('Access-Control-Allow-Methods', header('access-control-request-method') ?? 'GET')
        const requested = header('access-control-request-headers')
        if (requested) res.setHeader('Access-Control-Allow-Headers', requested)
        // Chrome's Private Network Access asks before a public page may call this computer ('any' only gets that far).
        if (header('access-control-request-private-network') === 'true') res.setHeader('Access-Control-Allow-Private-Network', 'true')
        res.setHeader('Access-Control-Max-Age', '600')
        res.writeHead(status)
        res.end()
      }
    } else {
      const found = matchMockRequest(running.routes, { method, path, header, body: body.text ?? undefined })
      if (found.route) {
        const example = found.route.example
        kind = 'example'
        status = mockStatus(example.code)
        match = { requestId: example.requestId, exampleIndex: example.exampleIndex, requestName: example.requestName, name: example.name }
        send = () => sendExample(res, status, example, method === 'HEAD')
      } else {
        kind = 'notFound'
        reason = found.reason
        status = 404
        send = () => sendJson(res, status, mockNotFoundBody(found.reason))
      }
    }
    if (cors && origin) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Access-Control-Allow-Credentials', 'true')
      res.setHeader('Access-Control-Expose-Headers', '*')
      res.setHeader('Vary', 'Origin')
    }

    const delayMs = kind === 'preflight' || kind === 'refused' ? 0 : options.delayMs
    if (delayMs > 0) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          running.delays.delete(t)
          resolve()
        }, delayMs)
        running.delays.add(t)
        // A client that gives up, or a stop, ends the wait.
        res.once('close', () => {
          clearTimeout(t)
          running.delays.delete(t)
          resolve()
        })
      })
      if (res.destroyed || this.servers.get(running.info.collectionId) !== running) return
    }
    send()

    running.info.requestCount++
    running.seq++
    const entry: MockServerLogEntry = {
      seq: running.seq,
      at: this.now(),
      method,
      path: path.length > PATH_LOG_LIMIT ? `${path.slice(0, PATH_LOG_LIMIT)}…` : path,
      status,
      match,
      reason,
      kind,
      request: {
        headers: logHeaders(req.rawHeaders),
        body: body.preview,
        bodyEncoding: body.encoding,
        bodyBytes: body.bytes,
        truncated: body.bytes > MOCK_LOG_BODY_LIMIT,
      },
      response: { statusText: res.statusMessage || STATUS_CODES[status] || '', headers: responseHeaders(res), delayMs },
      durationMs: Date.now() - arrived,
    }
    running.log.push(entry)
    if (running.log.length > MOCK_LOG_LIMIT) running.log.splice(0, running.log.length - MOCK_LOG_LIMIT)
    if (this.servers.get(running.info.collectionId) === running) {
      this.emit({ type: 'request', collectionId: running.info.collectionId, entry, requestCount: running.info.requestCount })
    }
  }
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.close()
      const where = `${MOCK_HOST}:${port}`
      if (err.code === 'EADDRINUSE') {
        reject(ioError(`Port ${port} is already in use (${where}). Choose another port or stop the program using it.`, { reason: 'port_in_use', port }))
      } else if (err.code === 'EACCES') {
        reject(ioError(`Not allowed to listen on ${where}. Ports below 1024 need special rights: choose a port above 1024.`, { reason: 'port_denied', port }))
      } else reject(ioError(`Could not start the mock server on ${where}: ${err.message}`))
    }
    server.once('error', onError)
    server.listen({ port, host: MOCK_HOST, exclusive: true }, () => {
      server.off('error', onError)
      resolve()
    })
  })
}

function sendJson(res: ServerResponse, status: number, body: string): void {
  const bytes = Buffer.from(body, 'utf8')
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': bytes.length })
  res.end(bytes)
}

interface ReadBody {
  /** The body as UTF-8 text (null: none, or not valid UTF-8). Used for matching. */
  text: string | null
  /** What the log keeps (first MOCK_LOG_BODY_LIMIT bytes). */
  preview: string | null
  encoding: 'base64' | null
  bytes: number
}

/** Reads up to MOCK_REQUEST_BODY_LIMIT bytes and drains the rest, so keep-alive connections stay usable. */
function readBody(req: IncomingMessage): Promise<ReadBody> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let kept = 0
    let bytes = 0
    const done = () => {
      const buf = Buffer.concat(chunks)
      if (bytes === 0) return resolve({ text: null, preview: null, encoding: null, bytes: 0 })
      const text = utf8(buf)
      const head = buf.subarray(0, MOCK_LOG_BODY_LIMIT)
      // A cut in the middle of a multi-byte character still counts as text: drop the partial character at the end.
      const headText = text !== null ? (utf8(head) ?? utf8(head.subarray(0, head.length - 3)) ?? text.slice(0, MOCK_LOG_BODY_LIMIT)) : null
      resolve(headText !== null ? { text, preview: headText, encoding: null, bytes } : { text: null, preview: head.toString('base64'), encoding: 'base64', bytes })
    }
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (kept < MOCK_REQUEST_BODY_LIMIT) {
        const part = chunk.subarray(0, MOCK_REQUEST_BODY_LIMIT - kept)
        chunks.push(part)
        kept += part.length
      }
    })
    req.on('end', done)
    req.on('error', done)
    req.on('aborted', done)
  })
}

const decoder = new TextDecoder('utf-8', { fatal: true })
function utf8(buf: Buffer): string | null {
  try {
    return decoder.decode(buf)
  } catch {
    return null
  }
}

/** Request headers for the log: lower-case names in order, long values cut. */
function logHeaders(raw: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const value = raw[i + 1]!
    out.push([raw[i]!.toLowerCase(), value.length > HEADER_LOG_LIMIT ? `${value.slice(0, HEADER_LOG_LIMIT)}…` : value])
  }
  return out
}

function responseHeaders(res: ServerResponse): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const [name, value] of Object.entries(res.getHeaders())) {
    if (value === undefined) continue
    for (const v of Array.isArray(value) ? value : [value]) out.push([name, String(v)])
  }
  return out
}

function sendExample(res: ServerResponse, status: number, example: MockExample, head: boolean): void {
  for (const [key, values] of mockResponseHeaders(example.headers)) {
    try {
      res.setHeader(key, values.length === 1 ? values[0]! : values)
    } catch {
      // A header name or value Node refuses (control characters, ...) is left out rather than failing the response.
    }
  }
  const body = example.bodyEncoding === 'base64' ? Buffer.from(example.body, 'base64') : Buffer.from(example.body, 'utf8')
  // 204, 205 and 304 never carry a body or a length; HEAD sends the length of the body it leaves out.
  const noBody = NO_BODY_STATUS.has(status)
  if (noBody) res.removeHeader('Content-Type')
  else res.setHeader('Content-Length', body.length)
  try {
    res.writeHead(status, example.status || undefined)
  } catch {
    res.writeHead(status)
  }
  res.end(noBody || head ? undefined : body)
}
