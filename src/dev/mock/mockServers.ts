/**
 * Browser mock of the mock-server methods (electron/services/mockServers.ts). No socket is opened: a "server" is state,
 * and `window.__slingerMock.mockServers.hit(...)` plays an incoming request through the same matcher and CORS rules
 * (shared/mockMatch.ts), logging it (headers, body, answer) and pushing the event the real main process would push. The
 * delay option is recorded in the log entry but not waited for.
 */
import type { SlingerIpcApi } from '../../../shared/ipc-contract'
import { resolveDynamicVariables } from '../../../shared/dynamicVariables'
import {
  compileMockRoutes,
  corsOriginAllowed,
  isLoopbackHost,
  matchMockRequest,
  mockNotFoundBody,
  mockResponseHeaders,
  mockStatus,
  type MockRoute,
} from '../../../shared/mockMatch'
import {
  DEFAULT_MOCK_OPTIONS,
  MOCK_LOG_BODY_LIMIT,
  MOCK_LOG_LIMIT,
  MOCK_MAX_DELAY_MS,
  type MockExample,
  type MockServerEvent,
  type MockServerInfo,
  type MockServerLogEntry,
  type MockServerOptions,
} from '../../../shared/types'
import { statusReason } from '../../lib/examples'
import { bytesToBase64, clone, fail, nowSec } from './util'

type MockServersApi = Pick<
  SlingerIpcApi,
  | 'startMockServer'
  | 'updateMockServer'
  | 'setMockServerOptions'
  | 'stopMockServer'
  | 'listMockServers'
  | 'getMockServerLog'
  | 'clearMockServerLog'
  | 'onMockServerEvent'
>

export interface MockHitRequest {
  method?: string
  /** Path with an optional query string. */
  path: string
  /** Sent in this order; names are logged lower-case. */
  headers?: Record<string, string>
  /** Text body, or bytes (logged as base64 when not UTF-8). */
  body?: string | Uint8Array
}

export interface MockServerControls {
  /** Plays a request against the collection's running mock server; returns what it would answer. */
  hit(collectionId: string, request: MockHitRequest): { status: number; body: string; headers: Array<[string, string]>; entry: MockServerLogEntry }
  /** Pretends another program listens on this port (start then fails with port_in_use). */
  occupyPort(port: number | null): void
  /** Simulates the server failing after it started (`stopped` with by 'error'). */
  crash(collectionId: string, reason?: string): void
  /** Simulates Slinger quitting: every server stops with by 'quit'. */
  quit(): void
  reset(): void
}

interface Running {
  info: MockServerInfo
  routes: MockRoute<MockExample>[]
  log: MockServerLogEntry[]
  seq: number
}

function checkOptions(options: MockServerOptions): MockServerOptions {
  if (options.cors !== 'local' && options.cors !== 'any') fail('invalid_input', 'cors must be local or any')
  if (!Number.isInteger(options.delayMs) || options.delayMs < 0 || options.delayMs > MOCK_MAX_DELAY_MS) {
    fail('invalid_input', `delayMs must be 0-${MOCK_MAX_DELAY_MS}`)
  }
  return { cors: options.cors, delayMs: options.delayMs }
}

/** The logged form of a request body: text when it is UTF-8, else base64; cut to MOCK_LOG_BODY_LIMIT bytes. */
function logBody(body: string | Uint8Array | undefined): { text: string | undefined; log: MockServerLogEntry['request'] } {
  const bytes = body === undefined ? new Uint8Array() : typeof body === 'string' ? new TextEncoder().encode(body) : body
  if (bytes.length === 0) return { text: undefined, log: { headers: [], body: null, bodyEncoding: null, bodyBytes: 0, truncated: false } }
  const kept = bytes.subarray(0, MOCK_LOG_BODY_LIMIT)
  let text: string | undefined
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    text = undefined
  }
  const preview = text !== undefined ? new TextDecoder().decode(kept) : bytesToBase64(kept)
  return {
    text,
    log: {
      headers: [],
      body: preview,
      bodyEncoding: text !== undefined ? null : 'base64',
      bodyBytes: bytes.length,
      truncated: bytes.length > MOCK_LOG_BODY_LIMIT,
    },
  }
}

export function createMockServersApi(): { api: MockServersApi; controls: MockServerControls } {
  const servers = new Map<string, Running>()
  const listeners = new Set<(e: MockServerEvent) => void>()
  let occupied: number | null = null
  const emit = (e: MockServerEvent) => {
    for (const l of [...listeners]) l(clone(e))
  }
  const portTaken = (port: number, collectionId: string) =>
    port === occupied || [...servers.values()].some((r) => r.info.port === port && r.info.collectionId !== collectionId)

  const api: MockServersApi = {
    async startMockServer(input) {
      if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) fail('invalid_input', 'port must be 1-65535')
      if (typeof input.collectionName !== 'string') fail('invalid_input', 'collectionName is required')
      const options = checkOptions(input.options ?? DEFAULT_MOCK_OPTIONS)
      const existing = servers.get(input.collectionId)
      if (existing && existing.info.port === input.port) return api.updateMockServer(input.collectionId, input.examples, input.collectionName)
      if (portTaken(input.port, input.collectionId)) {
        fail('io_error', `Port ${input.port} is already in use (127.0.0.1:${input.port}). Choose another port or stop the program using it.`, {
          reason: 'port_in_use',
          port: input.port,
        })
      }
      if (existing) {
        servers.delete(input.collectionId)
        emit({ type: 'stopped', collectionId: input.collectionId, reason: null, by: 'replaced' })
      }
      const info: MockServerInfo = {
        workspaceId: input.workspaceId,
        collectionId: input.collectionId,
        collectionName: input.collectionName,
        options,
        port: input.port,
        url: `http://127.0.0.1:${input.port}`,
        startedAt: nowSec(),
        exampleCount: input.examples.length,
        requestCount: 0,
      }
      servers.set(input.collectionId, { info, routes: compileMockRoutes(input.examples), log: [], seq: 0 })
      emit({ type: 'started', server: info })
      return clone(info)
    },
    async updateMockServer(collectionId, examples, collectionName) {
      const r = servers.get(collectionId)
      if (!r) fail('not_found', 'Mock server not found')
      r.routes = compileMockRoutes(examples)
      r.info.exampleCount = examples.length
      if (collectionName !== undefined && collectionName !== r.info.collectionName) {
        r.info.collectionName = collectionName
        emit({ type: 'updated', server: r.info })
      }
      return clone(r.info)
    },
    async setMockServerOptions(collectionId, options) {
      const r = servers.get(collectionId)
      if (!r) fail('not_found', 'Mock server not found')
      r.info.options = checkOptions(options)
      emit({ type: 'updated', server: r.info })
      return clone(r.info)
    },
    async stopMockServer(collectionId) {
      if (!servers.delete(collectionId)) return
      emit({ type: 'stopped', collectionId, reason: null, by: 'user' })
    },
    async listMockServers() {
      return [...servers.values()].map((r) => clone(r.info))
    },
    async getMockServerLog(collectionId) {
      return clone(servers.get(collectionId)?.log ?? [])
    },
    async clearMockServerLog(collectionId) {
      const r = servers.get(collectionId)
      if (r) r.log = []
    },
    onMockServerEvent(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }

  const controls: MockServerControls = {
    hit(collectionId, request) {
      const r = servers.get(collectionId)
      if (!r) throw new Error('No mock server running for this collection')
      const method = (request.method ?? 'GET').toUpperCase()
      const sent = Object.entries(request.headers ?? {}).map(([k, v]): [string, string] => [k.toLowerCase(), v])
      const header = (name: string) => sent.find(([k]) => k === name)?.[1]
      const body = logBody(request.body)
      const origin = header('origin')
      const cors = corsOriginAllowed(r.info.options.cors, origin)
      const preflight = method === 'OPTIONS' && origin !== undefined && header('access-control-request-method') !== undefined

      let kind: MockServerLogEntry['kind']
      let status: number
      let statusText = ''
      let reason: string | null = null
      let match: MockServerLogEntry['match'] = null
      let responseBody = ''
      const headers: Array<[string, string]> = []
      if (!isLoopbackHost(header('host'))) {
        kind = 'refused'
        status = 403
        reason = `Refused: Host "${header('host')}" is not a loopback name.`
        responseBody = `${JSON.stringify({ error: 'hostNotAllowed', message: reason })}\n`
        headers.push(['content-type', 'application/json; charset=utf-8'])
      } else if (preflight && !cors) {
        kind = 'refused'
        status = 403
        reason = `Refused a CORS preflight from ${origin}: only pages on this computer may call this mock server. Turn on "Allow any website" to allow it.`
        responseBody = `${JSON.stringify({ error: 'originNotAllowed', message: reason })}\n`
        headers.push(['content-type', 'application/json; charset=utf-8'])
      } else if (preflight) {
        kind = 'preflight'
        status = 204
        headers.push(['access-control-allow-methods', header('access-control-request-method') ?? 'GET'])
        const requested = header('access-control-request-headers')
        if (requested) headers.push(['access-control-allow-headers', requested])
        headers.push(['access-control-max-age', '600'])
      } else {
        const found = matchMockRequest(r.routes, { method, path: request.path, header, body: body.text })
        if (found.route) {
          const example = found.route.example
          kind = 'example'
          status = mockStatus(example.code)
          statusText = example.status
          match = { requestId: example.requestId, exampleIndex: example.exampleIndex, requestName: example.requestName, name: example.name }
          for (const [key, values] of mockResponseHeaders(example.headers)) for (const v of values) headers.push([key.toLowerCase(), resolveDynamicVariables(v)])
          responseBody = example.bodyEncoding === 'base64' ? example.body : resolveDynamicVariables(example.body)
        } else {
          kind = 'notFound'
          status = 404
          reason = found.reason
          responseBody = mockNotFoundBody(found.reason)
          headers.push(['content-type', 'application/json; charset=utf-8'])
        }
      }
      statusText ||= statusReason(status)
      if (cors && origin) {
        // As main: the example's own header names are exposed (`*` is literal on credentialed requests).
        const expose = [...new Set(headers.map(([k]) => k).filter((k) => !k.startsWith('access-control-') && k !== 'content-type'))]
        headers.push(['access-control-allow-origin', origin], ['access-control-allow-credentials', 'true'])
        if (expose.length) headers.push(['access-control-expose-headers', expose.join(', ')])
        headers.push(['vary', 'Origin'])
      }
      const delayMs = kind === 'preflight' || kind === 'refused' ? 0 : r.info.options.delayMs

      r.seq++
      r.info.requestCount++
      const entry: MockServerLogEntry = {
        seq: r.seq,
        at: nowSec(),
        method,
        path: request.path,
        status,
        match,
        reason,
        kind,
        request: { ...body.log, headers: sent },
        response: { statusText, headers, delayMs },
        durationMs: delayMs,
      }
      r.log.push(entry)
      if (r.log.length > MOCK_LOG_LIMIT) r.log.splice(0, r.log.length - MOCK_LOG_LIMIT)
      emit({ type: 'request', collectionId, entry, requestCount: r.info.requestCount })
      return { status, body: responseBody, headers: clone(headers), entry: clone(entry) }
    },
    occupyPort(port) {
      occupied = port
    },
    crash(collectionId, reason = 'Simulated server failure') {
      if (servers.delete(collectionId)) emit({ type: 'stopped', collectionId, reason, by: 'error' })
    },
    quit() {
      for (const id of [...servers.keys()]) {
        servers.delete(id)
        emit({ type: 'stopped', collectionId: id, reason: 'app quit', by: 'quit' })
      }
    },
    reset() {
      servers.clear()
      occupied = null
    },
  }
  return { api, controls }
}
