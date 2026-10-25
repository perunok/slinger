/**
 * Mock server edge cases found in an audit (each test names the defect it pins), plus dynamic variables in responses
 * and Postman's request-matching headers.
 */
import { request as httpRequest } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '../lib/ids'
import { MockServers } from '../services/mockServers'
import { compileMockRoutes, matchMockRequest, mockPathOf } from '../../shared/mockMatch'
import { postmanUrlToString } from '../../shared/postmanUrl'
import { MOCK_LOG_BODY_LIMIT, type MockExample, type MockServerEvent } from '../../shared/types'
import { createServer } from 'node:net'
import { makeEnv } from './helpers'

const WS = newId()
const COLL = newId()

function example(over: Partial<MockExample> = {}): MockExample {
  return {
    requestId: newId(),
    exampleIndex: 0,
    requestName: 'R',
    name: 'OK',
    method: 'GET',
    url: '/users/:id',
    code: 200,
    status: 'OK',
    headers: [{ key: 'Content-Type', value: 'application/json' }],
    body: '{"id":1}',
    bodyEncoding: null,
    requestBody: null,
    ...over,
  }
}

let servers: MockServers
let events: MockServerEvent[]
beforeEach(() => {
  events = []
  servers = new MockServers({ emit: (e) => events.push(e) })
})
afterEach(async () => {
  await servers.stopAll()
})

const start = (examples: MockExample[], port = 0) => servers.start({ workspaceId: WS, collectionId: COLL, collectionName: 'C', port, examples })

function raw(port: number, o: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer } = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; rawHeaders: string[]; body: string }>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: o.method ?? 'GET', path: o.path ?? '/', headers: o.headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(o.body)
  })
}
const match = (examples: MockExample[], req: { method?: string; path: string; headers?: Record<string, string>; body?: string }) =>
  matchMockRequest(compileMockRoutes(examples), {
    method: req.method ?? 'GET',
    path: req.path,
    header: (n) => req.headers?.[n],
    body: req.body,
  })

describe('audit fixes', () => {
  it('x-mock-response-id selects the example with that id (ids now reach main)', async () => {
    const env = makeEnv()
    const free = await new Promise<number>((resolve) => {
      const s = createServer().listen(0, '127.0.0.1', () => {
        const port = (s.address() as { port: number }).port
        s.close(() => resolve(port))
      })
    })
    try {
      // Through the IPC boundary: the strict schema used to reject the id, and the collector never sent it.
      const api = env.api
      const info = await api.startMockServer({
        workspaceId: WS,
        collectionId: COLL,
        collectionName: 'C',
        port: free,
        examples: [example({ body: '"a"', id: 'ex-a' }), example({ exampleIndex: 1, body: '"b"', id: 'ex-b' })],
      })
      expect((await raw(info.port, { path: '/users/1', headers: { 'x-mock-response-id': 'ex-b' } })).body).toBe('"b"')
      await api.stopMockServer(COLL)
    } finally {
      await env.core.mockServers.stopAll()
      env.cleanup()
    }
  })

  it('stop while a start is binding cancels it: nothing keeps serving', async () => {
    const p = start([example()])
    await servers.stop(COLL)
    await expect(p).rejects.toMatchObject({ code: 'io_error', details: { reason: 'stopped' } })
    expect(servers.list()).toEqual([])
    expect(events.filter((e) => e.type === 'started')).toEqual([])
  })

  it('an update while the start is binding is what gets served', async () => {
    const p = start([example({ body: '"old"' })])
    servers.update(COLL, [example({ body: '"new"' })], 'Renamed')
    const info = await p
    expect(info.collectionName).toBe('Renamed')
    expect((await raw(info.port, { path: '/users/1' })).body).toBe('"new"')
  })

  it('the log preview stays within MOCK_LOG_BODY_LIMIT bytes and never splits a character', async () => {
    const info = await start([example({ method: 'POST', url: '/up' })])
    const body = '中'.repeat(21845) + '😀'.repeat(30000)
    await raw(info.port, { method: 'POST', path: '/up', body })
    const entry = servers.log(COLL).at(-1)!
    expect(entry.request.bodyEncoding).toBeNull()
    expect(Buffer.byteLength(entry.request.body!, 'utf8')).toBeLessThanOrEqual(MOCK_LOG_BODY_LIMIT)
    expect(entry.request.body!.endsWith('�')).toBe(false)
    expect(/[\uD800-\uDBFF]$/.test(entry.request.body!)).toBe(false)
    expect(entry.request.truncated).toBe(true)
  })

  it('form bodies match by fields: url-encoded in any order and spacing, and multipart text fields', () => {
    const examples = [
      example({ name: 'first', method: 'POST', url: '/f', requestBody: 'name=Ann&role=user' }),
      example({ name: 'second', method: 'POST', url: '/f', requestBody: 'name=John+Doe&role=admin' }),
    ]
    const form = { 'content-type': 'application/x-www-form-urlencoded' }
    expect(match(examples, { method: 'POST', path: '/f', headers: form, body: 'role=admin&name=John%20Doe' }).route?.example.name).toBe('second')
    const boundary = 'XyZ'
    const multipart = [`--${boundary}`, 'Content-Disposition: form-data; name="role"', '', 'admin', `--${boundary}`, 'Content-Disposition: form-data; name="name"', '', 'John Doe', `--${boundary}`, 'Content-Disposition: form-data; name="file"; filename="a.txt"', 'Content-Type: text/plain', '', 'ignored', `--${boundary}--`, ''].join('\r\n')
    expect(match(examples, { method: 'POST', path: '/f', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body: multipart }).route?.example.name).toBe('second')
  })

  it('a Postman URL object without a host keeps its first path segment', () => {
    expect(postmanUrlToString({ path: ['users', ':id'] })).toBe('/users/:id')
    expect(mockPathOf(postmanUrlToString({ path: ['users', ':id'] }))).toBe('/users/:id')
    expect(postmanUrlToString({ host: ['{{baseUrl}}'], path: ['users'] })).toBe('{{baseUrl}}/users')
  })

  it('one invalid value of a repeated header does not drop the valid ones', async () => {
    const info = await start([example({ headers: [{ key: 'Set-Cookie', value: 'a=1' }, { key: 'Set-Cookie', value: 'b=☃' }] })])
    const res = await raw(info.port, { path: '/users/1' })
    expect(res.headers['set-cookie']).toEqual(['a=1'])
  })

  it("an example's Vary is merged with CORS's Vary: Origin; exposed headers are listed, not *", async () => {
    const info = await start([example({ headers: [{ key: 'Vary', value: 'Accept-Encoding' }, { key: 'X-Total', value: '3' }] })])
    const res = await raw(info.port, { path: '/users/1', headers: { origin: 'http://localhost:5173' } })
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173')
    expect(String(res.headers.vary).split(',').map((s) => s.trim()).sort()).toEqual(['Accept-Encoding', 'Origin'])
    expect(res.headers['access-control-expose-headers']).toBe('Vary, X-Total')
  })

  it('x-mock-response-code compares with the status actually sent', () => {
    const examples = [example({ name: 'odd', code: 102 }), example({ name: 'ok', code: 200 })]
    // 102 is sent as 200, so asking for 102 finds nothing and 200 finds both (first wins).
    expect(match(examples, { path: '/users/1', headers: { 'x-mock-response-code': '102' } }).route).toBeNull()
    expect(match(examples, { path: '/users/1', headers: { 'x-mock-response-code': '200' } }).route?.example.name).toBe('odd')
  })

  it('pattern segments: only-template segments are wildcards, template parts may be empty, absolute-form targets', () => {
    expect(match([example({ url: '/files/{{a}}{{b}}' })], { path: '/files/x' }).route).not.toBeNull()
    expect(match([example({ url: '/api/v{{n}}' })], { path: '/api/v' }).route).not.toBeNull()
    expect(match([example({ url: '/api/v{{n}}' })], { path: '/api/x2' }).route).toBeNull()
    expect(match([example({ url: '/users' })], { path: 'http://127.0.0.1:4010/users?x=1' }).route).not.toBeNull()
  })

  it('205 is sent with Content-Length: 0, not chunked', async () => {
    const info = await start([example({ code: 205, status: 'Reset Content', body: 'nope' })])
    const res = await raw(info.port, { path: '/users/1' })
    expect(res.status).toBe(205)
    expect(res.headers['content-length']).toBe('0')
    expect(res.headers['transfer-encoding']).toBeUndefined()
    expect(res.body).toBe('')
  })
})

describe('dynamic variables in responses', () => {
  it('bodies and header values get fresh values per answer; binary bodies are untouched', async () => {
    const info = await start([
      example({ headers: [{ key: 'Content-Type', value: 'application/json' }, { key: 'X-Request-Id', value: '{{$guid}}' }], body: '{"id":"{{$guid}}","at":{{$timestamp}},"keep":"{{baseUrl}}"}' }),
      example({ exampleIndex: 1, url: '/bin', body: Buffer.from('{{$guid}}').toString('base64'), bodyEncoding: 'base64', headers: [] }),
    ])
    const a = await raw(info.port, { path: '/users/1' })
    const b = await raw(info.port, { path: '/users/1' })
    const ja = JSON.parse(a.body) as { id: string; at: number; keep: string }
    expect(ja.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(ja.id).not.toBe((JSON.parse(b.body) as { id: string }).id)
    expect(Math.abs(ja.at - Date.now() / 1000)).toBeLessThan(5)
    expect(ja.keep).toBe('{{baseUrl}}')
    expect(a.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
    expect(Number(a.headers['content-length'])).toBe(Buffer.byteLength(a.body))
    expect((await raw(info.port, { path: '/bin' })).body).toBe('{{$guid}}')
  })
})

describe("Postman's matching headers", () => {
  const examples = [
    example({ name: 'v1', requestHeaders: [{ key: 'X-Api-Version', value: '1' }], body: '"v1"' }),
    example({ exampleIndex: 1, name: 'v2', requestHeaders: [{ key: 'x-api-version', value: '2' }, { key: 'Tenant', value: '{{tenant}}' }], body: '"v2"' }),
  ]
  it('x-mock-match-request-headers narrows to examples whose saved request has those header values', () => {
    expect(match(examples, { path: '/users/1', headers: { 'x-mock-match-request-headers': 'X-Api-Version', 'x-api-version': '2' } }).route?.example.name).toBe('v2')
    expect(match(examples, { path: '/users/1', headers: { 'x-mock-match-request-headers': 'x-api-version, tenant', 'x-api-version': '2', tenant: 'acme' } }).route?.example.name).toBe('v2')
    const none = match(examples, { path: '/users/1', headers: { 'x-mock-match-request-headers': 'x-api-version', 'x-api-version': '3' } })
    expect(none.route).toBeNull()
    expect(none.reason).toContain('x-api-version')
    // Without the header, the first example answers as before.
    expect(match(examples, { path: '/users/1', headers: { 'x-api-version': '2' } }).route?.example.name).toBe('v1')
  })

  it('x-mock-match-request-body: true requires an equal saved body', () => {
    const posts = [example({ name: 'ann', method: 'POST', url: '/u', requestBody: '{"name":"Ann"}' }), example({ name: 'any', method: 'POST', url: '/u', requestBody: null })]
    expect(match(posts, { method: 'POST', path: '/u', body: '{ "name": "Ann" }', headers: { 'x-mock-match-request-body': 'true' } }).route?.example.name).toBe('ann')
    expect(match(posts, { method: 'POST', path: '/u', body: '{"name":"Bob"}', headers: { 'x-mock-match-request-body': 'true' } }).route).toBeNull()
    expect(match(posts, { method: 'POST', path: '/u', body: '{"name":"Bob"}' }).route?.example.name).toBe('ann') // ranking only: first
  })
})
