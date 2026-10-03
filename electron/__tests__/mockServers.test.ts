import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '../lib/ids'
import { MockServers } from '../services/mockServers'
import { MOCK_LOG_LIMIT, type MockExample, type MockServerEvent } from '../../shared/types'
import { makeEnv, type TestEnv } from './helpers'

const REQ_A = newId()
const REQ_B = newId()
const WS = newId()
const COLL = newId()

function example(over: Partial<MockExample> = {}): MockExample {
  return {
    requestId: REQ_A,
    exampleIndex: 0,
    requestName: 'Get user',
    name: 'OK',
    method: 'GET',
    url: '{{baseUrl}}/users/:id',
    code: 200,
    status: 'OK',
    headers: [{ key: 'Content-Type', value: 'application/json' }],
    body: '{"id":1}',
    bodyEncoding: null,
    ...over,
  }
}

const EXAMPLES: MockExample[] = [
  example(),
  example({ exampleIndex: 1, name: 'Missing', code: 404, status: 'Not Found', body: '{"error":"missing"}' }),
  example({ requestId: REQ_B, exampleIndex: 0, requestName: 'Me', name: 'Me', url: 'https://api.example.com/users/me', body: '{"me":true}' }),
  example({
    requestId: REQ_B,
    exampleIndex: 1,
    requestName: 'Create',
    name: 'Created',
    method: 'POST',
    url: '{{baseUrl}}/users',
    code: 201,
    status: 'Created',
    headers: [
      { key: 'Location', value: '/users/7' },
      { key: 'Set-Cookie', value: 'a=1' },
      { key: 'Set-Cookie', value: 'b=2' },
      { key: 'Content-Length', value: '9999' },
      { key: 'Content-Encoding', value: 'gzip' },
    ],
    body: 'created',
  }),
  example({ requestId: REQ_B, exampleIndex: 2, name: 'Logo', url: '/logo.png', headers: [{ key: 'Content-Type', value: 'image/png' }], body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]).toString('base64'), bodyEncoding: 'base64' }),
]

let servers: MockServers
let events: MockServerEvent[]
beforeEach(() => {
  events = []
  servers = new MockServers({ emit: (e) => events.push(e), now: () => 1_700_000_000 })
})
afterEach(async () => {
  await servers.stopAll()
})

async function start(examples = EXAMPLES, port = 0, collectionId = COLL) {
  return servers.start({ workspaceId: WS, collectionId, port, examples })
}

describe('MockServers (real HTTP on 127.0.0.1)', () => {
  it('starts on 127.0.0.1 and serves the matching example with its status, headers and body', async () => {
    const info = await start()
    expect(info.url).toBe(`http://127.0.0.1:${info.port}`)
    expect(info).toMatchObject({ workspaceId: WS, collectionId: COLL, exampleCount: 5, requestCount: 0, startedAt: 1_700_000_000 })
    const res = await fetch(`${info.url}/users/42?x=1`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(await res.json()).toEqual({ id: 1 })
    expect(events[0]).toMatchObject({ type: 'started', server: { port: info.port } })
  })

  it('prefers the exact path, and selects with x-mock-response-name / -code', async () => {
    const { url } = await start()
    expect(await (await fetch(`${url}/users/me`)).json()).toEqual({ me: true })
    const named = await fetch(`${url}/users/1`, { headers: { 'x-mock-response-name': 'Missing' } })
    expect(named.status).toBe(404)
    expect(named.statusText).toBe('Not Found')
    expect(await named.json()).toEqual({ error: 'missing' })
    const coded = await fetch(`${url}/users/1`, { headers: { 'x-mock-response-code': '404' } })
    expect(coded.status).toBe(404)
  })

  it('sends repeated headers, drops framing headers, and serves base64 bodies as bytes', async () => {
    const { url } = await start()
    const res = await fetch(`${url}/users`, { method: 'POST', body: 'ignored' })
    expect(res.status).toBe(201)
    expect(res.headers.get('location')).toBe('/users/7')
    expect(res.headers.getSetCookie()).toEqual(['a=1', 'b=2'])
    expect(res.headers.get('content-encoding')).toBeNull()
    expect(res.headers.get('content-length')).toBe('7')
    expect(await res.text()).toBe('created')
    const logo = await fetch(`${url}/logo.png`)
    expect(logo.headers.get('content-type')).toBe('image/png')
    expect([...new Uint8Array(await logo.arrayBuffer())]).toEqual([0x89, 0x50, 0x4e, 0x47, 0, 255])
  })

  it('answers 404 with a JSON explanation when nothing matches', async () => {
    const { url } = await start()
    const res = await fetch(`${url}/nothing/here`)
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toMatchObject({ error: 'mockRequestNotFound', message: 'No saved example matches GET /nothing/here.' })
    const wrongMethod = await fetch(`${url}/users/me`, { method: 'DELETE' })
    expect(((await wrongMethod.json()) as { message: string }).message).toContain('examples on this path use GET')
  })

  it('logs every request (match, no match) and pushes request events', async () => {
    const { url } = await start()
    await fetch(`${url}/users/5`)
    await fetch(`${url}/missing`)
    const log = servers.log(COLL)
    expect(log).toEqual([
      { seq: 1, at: 1_700_000_000, method: 'GET', path: '/users/5', status: 200, match: { requestId: REQ_A, exampleIndex: 0, requestName: 'Get user', name: 'OK' }, reason: null },
      { seq: 2, at: 1_700_000_000, method: 'GET', path: '/missing', status: 404, match: null, reason: 'No saved example matches GET /missing.' },
    ])
    expect(events.filter((e) => e.type === 'request').map((e) => e.type === 'request' && e.requestCount)).toEqual([1, 2])
    expect(servers.list()[0]!.requestCount).toBe(2)
    servers.clearLog(COLL)
    expect(servers.log(COLL)).toEqual([])
  })

  it('caps the log', async () => {
    const { url } = await start()
    for (let i = 0; i < MOCK_LOG_LIMIT + 5; i++) await fetch(`${url}/users/${i}`)
    const log = servers.log(COLL)
    expect(log).toHaveLength(MOCK_LOG_LIMIT)
    expect(log[0]!.seq).toBe(6)
  })

  it('refuses requests whose Host is not a loopback name (DNS rebinding)', async () => {
    const { port } = await start()
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/users/1', headers: { Host: 'evil.example.com' } }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on('error', reject)
      req.end()
    })
    expect(status).toBe(403)
    expect(servers.log(COLL)[0]).toMatchObject({ status: 403, match: null })
  })

  it('reports a busy port as io_error port_in_use and keeps the running server', async () => {
    const blocker: Server = createServer()
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r))
    const busy = (blocker.address() as AddressInfo).port
    try {
      await expect(start(EXAMPLES, busy)).rejects.toMatchObject({ code: 'io_error', details: { reason: 'port_in_use', port: busy } })
      expect(servers.list()).toEqual([])
      const first = await start()
      await expect(start(EXAMPLES, busy)).rejects.toMatchObject({ details: { reason: 'port_in_use' } })
      expect(servers.list()[0]!.port).toBe(first.port)
      expect((await fetch(`${first.url}/users/me`)).status).toBe(200)
      // Another collection on a port a mock server already uses.
      await expect(start(EXAMPLES, first.port, newId())).rejects.toMatchObject({ details: { reason: 'port_in_use' } })
    } finally {
      await new Promise((r) => blocker.close(r))
    }
  })

  it('restarting on the same port swaps the examples; another port moves the server', async () => {
    const first = await start()
    const again = await servers.start({ workspaceId: WS, collectionId: COLL, port: first.port, examples: [example({ url: '/only' })] })
    expect(again.port).toBe(first.port)
    expect(again.exampleCount).toBe(1)
    expect((await fetch(`${first.url}/only`)).status).toBe(200)
    expect((await fetch(`${first.url}/users/me`)).status).toBe(404)
    const moved = await start(EXAMPLES, 0)
    expect(moved.port).not.toBe(first.port)
    expect(servers.list()).toHaveLength(1)
    await expect(fetch(`${first.url}/only`)).rejects.toThrow()
  })

  it('update() picks up edited examples live; not_found when not running', async () => {
    const { url } = await start()
    servers.update(COLL, [example({ url: '/v2/users/:id', body: '{"v":2}' })])
    expect(await (await fetch(`${url}/v2/users/1`)).json()).toEqual({ v: 2 })
    expect((await fetch(`${url}/users/1`)).status).toBe(404)
    expect(() => servers.update(newId(), [])).toThrow(expect.objectContaining({ code: 'not_found' }))
  })

  it('stop() closes the port and open keep-alive connections; stopping twice is fine', async () => {
    const { url } = await start()
    await fetch(`${url}/users/1`)
    await servers.stop(COLL)
    expect(servers.list()).toEqual([])
    expect(servers.log(COLL)).toEqual([])
    expect(events.at(-1)).toEqual({ type: 'stopped', collectionId: COLL, reason: null })
    await expect(fetch(`${url}/users/1`)).rejects.toThrow()
    await servers.stop(COLL)
  })

  it('stopAll() stops every server (app quit)', async () => {
    const a = await start(EXAMPLES, 0, newId())
    const b = await start(EXAMPLES, 0, newId())
    await servers.stopAll()
    expect(servers.list()).toEqual([])
    await expect(fetch(`${a.url}/users/1`)).rejects.toThrow()
    await expect(fetch(`${b.url}/users/1`)).rejects.toThrow()
    expect(events.filter((e) => e.type === 'stopped').every((e) => e.type === 'stopped' && e.reason === 'app quit')).toBe(true)
  })
})

describe('mock server IPC methods', () => {
  let env: TestEnv
  beforeEach(() => {
    env = makeEnv()
  })
  afterEach(async () => {
    await env.core.mockServers.stopAll()
    env.cleanup()
  })

  it('validates input at the boundary', async () => {
    const call = (m: string, ...a: unknown[]) => (env.api as unknown as Record<string, (...x: unknown[]) => Promise<unknown>>)[m]!(...a)
    const base = { workspaceId: WS, collectionId: COLL, port: 4010, examples: [] }
    await expect(call('startMockServer', { ...base, port: 0 })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(call('startMockServer', { ...base, port: 70000 })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(call('startMockServer', { ...base, port: 4010.5 })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(call('startMockServer', { ...base, extra: 1 })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(call('startMockServer', { ...base, examples: [{ ...example(), bodyEncoding: 'hex' }] })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(call('startMockServer', { ...base, examples: [{ ...example(), requestId: 'x' }] })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(call('updateMockServer', COLL, [])).rejects.toMatchObject({ code: 'not_found' })
    await expect(call('listMockServers', 1)).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('start / list / log / clear / stop through the API', async () => {
    // A free port picked by the OS, then released, so the API (which refuses port 0) can bind it.
    const probe = createServer()
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
    const port = (probe.address() as AddressInfo).port
    await new Promise((r) => probe.close(r))

    const info = await env.api.startMockServer({ workspaceId: WS, collectionId: COLL, port, examples: EXAMPLES })
    expect(info.url).toBe(`http://127.0.0.1:${port}`)
    expect(await env.api.listMockServers()).toHaveLength(1)
    await fetch(`${info.url}/users/me`)
    expect(await env.api.getMockServerLog(COLL)).toHaveLength(1)
    await env.api.clearMockServerLog(COLL)
    expect(await env.api.getMockServerLog(COLL)).toEqual([])
    await env.api.updateMockServer(COLL, [])
    expect((await fetch(`${info.url}/users/me`)).status).toBe(404)
    await env.api.stopMockServer(COLL)
    expect(await env.api.listMockServers()).toEqual([])
  })
})
