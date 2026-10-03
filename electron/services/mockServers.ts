/**
 * Mock servers: a collection's saved examples served over HTTP on 127.0.0.1 (see docs/ARCHITECTURE.md, "Mock servers").
 *
 * Local-only and in memory: nothing is written to the database; every server stops when the app quits. The renderer
 * resolves the examples from the request documents (opaque to main) and sends them on start and whenever they change
 * (`update`); matching is shared/mockMatch.ts. Plain Node (no Electron import), so tests run real servers.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { compileMockRoutes, isLoopbackHost, matchMockRequest, mockNotFoundBody, mockResponseHeaders, mockStatus, type MockRoute } from '../../shared/mockMatch'
import { MOCK_LOG_LIMIT, type MockExample, type MockServerEvent, type MockServerInfo, type MockServerLogEntry } from '../../shared/types'
import { invalidInput, ioError, notFound } from '../lib/errors'

export const MOCK_HOST = '127.0.0.1'
/** Upper bound for all example bodies of one server together (characters). */
export const MOCK_TOTAL_BODY_LIMIT = 200 * 1024 * 1024
const PATH_LOG_LIMIT = 2000

interface Running {
  info: MockServerInfo
  server: Server
  routes: MockRoute<MockExample>[]
  log: MockServerLogEntry[]
  seq: number
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
  async start(input: { workspaceId: string; collectionId: string; port: number; examples: MockExample[] }): Promise<MockServerInfo> {
    assertBodies(input.examples)
    const existing = this.servers.get(input.collectionId)
    if (existing && existing.info.port === input.port) return this.update(input.collectionId, input.examples)
    if (this.starting.has(input.collectionId)) throw invalidInput('This mock server is already starting')
    this.starting.add(input.collectionId)
    try {
      const running: Running = {
        info: {
          workspaceId: input.workspaceId,
          collectionId: input.collectionId,
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
      }
      running.server.on('request', (req, res) => this.handle(running, req, res))
      // Idle keep-alive connections must not keep a stopped server (or the app) alive for long.
      running.server.keepAliveTimeout = 5000
      await listen(running.server, input.port)
      const port = (running.server.address() as AddressInfo).port
      running.info.port = port
      running.info.url = `http://${MOCK_HOST}:${port}`
      if (existing) await this.stop(input.collectionId, null)
      this.servers.set(input.collectionId, running)
      // A server that fails after it started (rare) is dropped and reported.
      running.server.on('error', (err) => {
        if (this.servers.get(input.collectionId) !== running) return
        this.servers.delete(input.collectionId)
        running.server.close()
        this.emit({ type: 'stopped', collectionId: input.collectionId, reason: err.message })
      })
      this.emit({ type: 'started', server: { ...running.info } })
      return { ...running.info }
    } finally {
      this.starting.delete(input.collectionId)
    }
  }

  /** Replaces the examples of a running server (edits picked up live). */
  update(collectionId: string, examples: MockExample[]): MockServerInfo {
    const running = this.servers.get(collectionId)
    if (!running) throw notFound('Mock server')
    assertBodies(examples)
    running.routes = compileMockRoutes(examples)
    running.info.exampleCount = examples.length
    return { ...running.info }
  }

  /** Stops the collection's server; nothing happens when it is not running. Open connections are closed. */
  async stop(collectionId: string, reason: string | null = null): Promise<void> {
    const running = this.servers.get(collectionId)
    if (!running) return
    this.servers.delete(collectionId)
    await new Promise<void>((resolve) => {
      running.server.close(() => resolve())
      running.server.closeAllConnections()
    })
    this.emit({ type: 'stopped', collectionId, reason })
  }

  /** App quit: stop everything. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.servers.keys()].map((id) => this.stop(id, 'app quit')))
  }

  private handle(running: Running, req: IncomingMessage, res: ServerResponse): void {
    const method = (req.method ?? 'GET').toUpperCase()
    const path = req.url ?? '/'
    const header = (name: string): string | undefined => {
      const v = req.headers[name]
      return Array.isArray(v) ? v[0] : v
    }
    let status: number
    let match: MockServerLogEntry['match'] = null
    let reason: string | null = null
    if (!isLoopbackHost(header('host'))) {
      reason = `Refused: Host "${header('host')}" is not a loopback name.`
      status = 403
      sendJson(res, status, `${JSON.stringify({ error: 'hostNotAllowed', message: reason })}\n`)
    } else {
      const found = matchMockRequest(running.routes, { method, path, header })
      if (found.route) {
        const example = found.route.example
        status = mockStatus(example.code)
        match = { requestId: example.requestId, exampleIndex: example.exampleIndex, requestName: example.requestName, name: example.name }
        sendExample(res, status, example)
      } else {
        reason = found.reason
        status = 404
        sendJson(res, status, mockNotFoundBody(found.reason))
      }
    }
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

function sendExample(res: ServerResponse, status: number, example: MockExample): void {
  for (const [key, values] of mockResponseHeaders(example.headers)) {
    try {
      res.setHeader(key, values.length === 1 ? values[0]! : values)
    } catch {
      // A header name or value Node refuses (control characters, ...) is left out rather than failing the response.
    }
  }
  const body = example.bodyEncoding === 'base64' ? Buffer.from(example.body, 'base64') : Buffer.from(example.body, 'utf8')
  res.setHeader('Content-Length', body.length)
  try {
    res.writeHead(status, example.status || undefined)
  } catch {
    res.writeHead(status)
  }
  res.end(body)
}
