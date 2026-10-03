/**
 * Browser mock of the mock-server methods (electron/services/mockServers.ts). No socket is opened: a "server" is state,
 * and `window.__slingerMock.mockServers.hit(...)` plays an incoming request through the same matcher
 * (shared/mockMatch.ts), logging it and pushing the event the real main process would push.
 */
import type { SlingerIpcApi } from '../../../shared/ipc-contract'
import { compileMockRoutes, matchMockRequest, mockStatus, type MockRoute } from '../../../shared/mockMatch'
import { MOCK_LOG_LIMIT, type MockExample, type MockServerEvent, type MockServerInfo, type MockServerLogEntry } from '../../../shared/types'
import { clone, fail, nowSec } from './util'

type MockServersApi = Pick<
  SlingerIpcApi,
  'startMockServer' | 'updateMockServer' | 'stopMockServer' | 'listMockServers' | 'getMockServerLog' | 'clearMockServerLog' | 'onMockServerEvent'
>

export interface MockServerControls {
  /** Plays a request against the collection's running mock server; resolves with what it would answer. */
  hit(collectionId: string, request: { method?: string; path: string; headers?: Record<string, string> }): { status: number; body: string; entry: MockServerLogEntry }
  /** Pretends another program listens on this port (start then fails with port_in_use). */
  occupyPort(port: number | null): void
  /** Simulates the server failing after it started. */
  crash(collectionId: string, reason?: string): void
  reset(): void
}

interface Running {
  info: MockServerInfo
  routes: MockRoute<MockExample>[]
  log: MockServerLogEntry[]
  seq: number
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
      const existing = servers.get(input.collectionId)
      if (existing && existing.info.port === input.port) return api.updateMockServer(input.collectionId, input.examples)
      if (portTaken(input.port, input.collectionId)) {
        fail('io_error', `Port ${input.port} is already in use (127.0.0.1:${input.port}). Choose another port or stop the program using it.`, {
          reason: 'port_in_use',
          port: input.port,
        })
      }
      if (existing) {
        servers.delete(input.collectionId)
        emit({ type: 'stopped', collectionId: input.collectionId, reason: null })
      }
      const info: MockServerInfo = {
        workspaceId: input.workspaceId,
        collectionId: input.collectionId,
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
    async updateMockServer(collectionId, examples) {
      const r = servers.get(collectionId)
      if (!r) fail('not_found', 'Mock server not found')
      r.routes = compileMockRoutes(examples)
      r.info.exampleCount = examples.length
      return clone(r.info)
    },
    async stopMockServer(collectionId) {
      if (!servers.delete(collectionId)) return
      emit({ type: 'stopped', collectionId, reason: null })
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
      const headers = Object.fromEntries(Object.entries(request.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
      const found = matchMockRequest(r.routes, { method, path: request.path, header: (n) => headers[n] })
      const example = found.route?.example ?? null
      const status = example ? mockStatus(example.code) : 404
      r.seq++
      r.info.requestCount++
      const entry: MockServerLogEntry = {
        seq: r.seq,
        at: nowSec(),
        method,
        path: request.path,
        status,
        match: example ? { requestId: example.requestId, exampleIndex: example.exampleIndex, requestName: example.requestName, name: example.name } : null,
        reason: found.reason,
      }
      r.log.push(entry)
      if (r.log.length > MOCK_LOG_LIMIT) r.log.splice(0, r.log.length - MOCK_LOG_LIMIT)
      emit({ type: 'request', collectionId, entry, requestCount: r.info.requestCount })
      return { status, body: example ? example.body : JSON.stringify({ error: 'mockRequestNotFound', message: found.reason }), entry: clone(entry) }
    },
    occupyPort(port) {
      occupied = port
    },
    crash(collectionId, reason = 'Simulated server failure') {
      if (servers.delete(collectionId)) emit({ type: 'stopped', collectionId, reason })
    },
    reset() {
      servers.clear()
      occupied = null
    },
  }
  return { api, controls }
}
