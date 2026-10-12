import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '../lib/ids'
import { MockServers } from '../services/mockServers'
import { MOCK_LOG_BODY_LIMIT, MOCK_LOG_LIMIT, type MockExample, type MockServerEvent } from '../../shared/types'
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
    requestBody: null,
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
  return servers.start({ workspaceId: WS, collectionId, collectionName: 'Shop API', port, examples })
}

/** A raw HTTP call (fetch may not set Origin or Host). */
function raw(port: number, o: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer } = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string; ms: number }>((resolve, reject) => {
    const t0 = Date.now()
    const req = httpRequest({ host: '127.0.0.1', port, method: o.method ?? 'GET', path: o.path ?? '/', headers: o.headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), ms: Date.now() - t0 }))
    })
    req.on('error', reject)
    req.end(o.body)
  })
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
    expect(log).toMatchObject([
      { seq: 1, at: 1_700_000_000, method: 'GET', path: '/users/5', status: 200, kind: 'example', match: { requestId: REQ_A, exampleIndex: 0, requestName: 'Get user', name: 'OK' }, reason: null },
      { seq: 2, at: 1_700_000_000, method: 'GET', path: '/missing', status: 404, kind: 'notFound', match: null, reason: 'No saved example matches GET /missing.' },
    ])
    expect(log[0]!.response).toMatchObject({ statusText: 'OK', delayMs: 0 })
    expect(log[0]!.response.headers).toContainEqual(['content-type', 'application/json'])
    expect(log[0]!.request).toMatchObject({ body: null, bodyBytes: 0, truncated: false })
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
    expect(servers.log(COLL)[0]).toMatchObject({ status: 403, match: null, kind: 'refused' })
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
    const again = await servers.start({ workspaceId: WS, collectionId: COLL, collectionName: 'Shop API', port: first.port, examples: [example({ url: '/only' })] })
    expect(again.port).toBe(first.port)
    expect(again.exampleCount).toBe(1)
    expect((await fetch(`${first.url}/only`)).status).toBe(200)
    expect((await fetch(`${first.url}/users/me`)).status).toBe(404)
    const moved = await start(EXAMPLES, 0)
    expect(moved.port).not.toBe(first.port)
    expect(servers.list()).toHaveLength(1)
    await expect(fetch(`${first.url}/only`)).rejects.toThrow()
    expect(events).toContainEqual({ type: 'stopped', collectionId: COLL, reason: null, by: 'replaced' })
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
    expect(events.at(-1)).toEqual({ type: 'stopped', collectionId: COLL, reason: null, by: 'user' })
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
    expect(events.filter((e) => e.type === 'stopped').every((e) => e.type === 'stopped' && e.reason === 'app quit' && e.by === 'quit')).toBe(true)
  })

  it('picks the example whose saved query parameters the request has', async () => {
    const { url } = await start([
      example({ url: '{{baseUrl}}/items', body: '"all"' }),
      example({ exampleIndex: 1, url: '{{baseUrl}}/items?page=2', body: '"page 2"' }),
      example({ exampleIndex: 2, url: '{{baseUrl}}/items?page=2&sort={{sort}}', body: '"page 2 sorted"' }),
    ])
    expect(await (await fetch(`${url}/items`)).json()).toBe('all')
    expect(await (await fetch(`${url}/items?page=3`)).json()).toBe('all')
    expect(await (await fetch(`${url}/items?page=2`)).json()).toBe('page 2')
    expect(await (await fetch(`${url}/items?sort=name&page=2`)).json()).toBe('page 2 sorted')
  })

  it('among equal matches, answers with the example saved with the same request body (JSON by value)', async () => {
    const { url } = await start([
      example({ method: 'POST', url: '/login', name: 'OK', requestBody: '{"user":"ann","pass":"right"}', body: '"welcome"' }),
      example({ exampleIndex: 1, method: 'POST', url: '/login', name: 'Wrong', code: 401, requestBody: '{"user":"ann","pass":"wrong"}', body: '"denied"' }),
    ])
    const login = (body: string) => fetch(`${url}/login`, { method: 'POST', body, headers: { 'content-type': 'application/json' } })
    expect((await login('{ "pass": "wrong", "user": "ann" }')).status).toBe(401)
    expect((await login('{"user":"ann","pass":"right"}')).status).toBe(200)
    expect((await login('{"user":"bob"}')).status).toBe(200) // no body matches: first in collection order
  })

  it('keeps what the client sent for the inspector: headers, body preview, sizes', async () => {
    const { port } = await start([example({ method: 'POST', url: '/upload' })])
    await raw(port, { method: 'POST', path: '/upload?x=1', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' }, body: '{"a":1}' })
    await raw(port, { method: 'POST', path: '/upload', body: Buffer.from([0xff, 0xfe, 0x00]) })
    await raw(port, { method: 'POST', path: '/upload', body: 'x'.repeat(MOCK_LOG_BODY_LIMIT + 10) })
    const [json, binary, big] = servers.log(COLL)
    expect(json!.path).toBe('/upload?x=1')
    expect(json!.request).toMatchObject({ body: '{"a":1}', bodyEncoding: null, bodyBytes: 7, truncated: false })
    expect(json!.request.headers).toContainEqual(['authorization', 'Bearer secret-token'])
    expect(json!.request.headers).toContainEqual(['content-type', 'application/json'])
    expect(binary!.request).toMatchObject({ body: Buffer.from([0xff, 0xfe, 0x00]).toString('base64'), bodyEncoding: 'base64', bodyBytes: 3 })
    expect(big!.request).toMatchObject({ bodyBytes: MOCK_LOG_BODY_LIMIT + 10, truncated: true })
    expect(big!.request.body).toHaveLength(MOCK_LOG_BODY_LIMIT)
  })

  it('CORS: pages on this computer by default, any website when allowed; preflights answered', async () => {
    const { port } = await start()
    const local = await raw(port, { path: '/users/1', headers: { Origin: 'http://localhost:5173' } })
    expect(local.headers['access-control-allow-origin']).toBe('http://localhost:5173')
    expect(local.headers['vary']).toBe('Origin')
    const pre = await raw(port, {
      method: 'OPTIONS',
      path: '/users/1',
      headers: { Origin: 'http://127.0.0.1:3000', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'authorization, content-type' },
    })
    expect(pre.status).toBe(204)
    expect(pre.headers).toMatchObject({
      'access-control-allow-origin': 'http://127.0.0.1:3000',
      'access-control-allow-methods': 'PUT',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-max-age': '600',
    })
    // A website elsewhere: no CORS headers, preflight refused (and said why in the log).
    const evil = await raw(port, { path: '/users/1', headers: { Origin: 'https://evil.example' } })
    expect(evil.status).toBe(200)
    expect(evil.headers['access-control-allow-origin']).toBeUndefined()
    const evilPre = await raw(port, { method: 'OPTIONS', path: '/users/1', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } })
    expect(evilPre.status).toBe(403)
    expect(servers.log(COLL).at(-1)).toMatchObject({ kind: 'refused', status: 403 })
    expect(servers.log(COLL).find((e) => e.kind === 'preflight')).toMatchObject({ method: 'OPTIONS', status: 204 })

    servers.setOptions(COLL, { cors: 'any', delayMs: 0 })
    expect(events.at(-1)).toMatchObject({ type: 'updated', server: { options: { cors: 'any' } } })
    const anyPre = await raw(port, {
      method: 'OPTIONS',
      path: '/users/1',
      headers: { Origin: 'https://app.example', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Private-Network': 'true' },
    })
    expect(anyPre.status).toBe(204)
    expect(anyPre.headers['access-control-allow-private-network']).toBe('true')
    expect((await raw(port, { path: '/users/1', headers: { Origin: 'https://app.example' } })).headers['access-control-allow-origin']).toBe('https://app.example')
  })

  it('waits the delay before answering (not for preflights); a stop ends the wait', async () => {
    const { port } = await start()
    servers.setOptions(COLL, { cors: 'local', delayMs: 150 })
    const slow = await raw(port, { path: '/users/1' })
    expect(slow.status).toBe(200)
    expect(slow.ms).toBeGreaterThanOrEqual(140)
    expect(servers.log(COLL).at(-1)).toMatchObject({ response: { delayMs: 150 } })
    expect(servers.log(COLL).at(-1)!.durationMs).toBeGreaterThanOrEqual(140)
    const pre = await raw(port, { method: 'OPTIONS', path: '/users/1', headers: { Origin: 'http://localhost:1', 'Access-Control-Request-Method': 'GET' } })
    expect(pre.ms).toBeLessThan(140)

    servers.setOptions(COLL, { cors: 'local', delayMs: 10_000 })
    const pending = raw(port, { path: '/users/1' }).catch(() => 'closed')
    await new Promise((r) => setTimeout(r, 50))
    const t0 = Date.now()
    await servers.stop(COLL)
    expect(await pending).toBe('closed')
    expect(Date.now() - t0).toBeLessThan(2000)
  })

  it('204/304 examples send no body or length; HEAD sends the length without the body', async () => {
    const { port } = await start([
      example({ method: 'DELETE', url: '/users/:id', code: 204, status: 'No Content', body: 'ignored' }),
      example({ exampleIndex: 1, url: '/cached', code: 304, status: 'Not Modified', body: 'ignored' }),
    ])
    const del = await raw(port, { method: 'DELETE', path: '/users/1' })
    expect(del.status).toBe(204)
    expect(del.body).toBe('')
    expect(del.headers['content-length']).toBeUndefined()
    expect((await raw(port, { path: '/cached' })).status).toBe(304)
    servers.update(COLL, [example()])
    const head = await raw(port, { method: 'HEAD', path: '/users/1' })
    expect(head.status).toBe(200)
    expect(head.body).toBe('')
    expect(head.headers['content-length']).toBe('8')
  })

  it('a rename reaches the server (tray label) as an updated event', async () => {
    await start()
    servers.update(COLL, EXAMPLES, 'Shop API v2')
    expect(servers.list()[0]!.collectionName).toBe('Shop API v2')
    expect(events.at(-1)).toMatchObject({ type: 'updated', server: { collectionName: 'Shop API v2' } })
    const before = events.length
    servers.update(COLL, EXAMPLES, 'Shop API v2')
    expect(events).toHaveLength(before) // same name: no event
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
    const base = { workspaceId: WS, collectionId: COLL, collectionName: 'Shop API', port: 4010, examples: [] }
    await expect(call('startMockServer', { ...base, port: 0 })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(call('startMockServer', { ...base, port: 70000 })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(call('startMockServer', { ...base, port: 4010.5 })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(call('startMockServer', { ...base, extra: 1 })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(call('startMockServer', { ...base, examples: [{ ...example(), bodyEncoding: 'hex' }] })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(call('startMockServer', { ...base, examples: [{ ...example(), requestId: 'x' }] })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(call('startMockServer', { ...base, options: { cors: 'everyone', delayMs: 0 } })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(call('startMockServer', { ...base, options: { cors: 'local', delayMs: 60_001 } })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(call('startMockServer', { ...base, examples: [{ ...example(), requestBody: 5 }] })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(call('setMockServerOptions', COLL, { cors: 'local', delayMs: -1 })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(call('setMockServerOptions', COLL, { cors: 'local', delayMs: 0 })).rejects.toMatchObject({ code: 'not_found' })
    await expect(call('updateMockServer', COLL, [])).rejects.toMatchObject({ code: 'not_found' })
    await expect(call('listMockServers', 1)).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('start / list / log / clear / stop through the API', async () => {
    // A free port picked by the OS, then released, so the API (which refuses port 0) can bind it.
    const probe = createServer()
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
    const port = (probe.address() as AddressInfo).port
    await new Promise((r) => probe.close(r))

    const info = await env.api.startMockServer({ workspaceId: WS, collectionId: COLL, collectionName: 'Shop API', port, examples: EXAMPLES })
    expect(info.url).toBe(`http://127.0.0.1:${port}`)
    expect(info.options).toEqual({ cors: 'local', delayMs: 0 })
    expect(await env.api.setMockServerOptions(COLL, { cors: 'any', delayMs: 5 })).toMatchObject({ options: { cors: 'any', delayMs: 5 } })
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
