import { beforeEach, describe, expect, it } from 'vitest'
import type { MockExample, MockServerEvent } from '../../../shared/types'
import { MOCK_LOG_BODY_LIMIT, MOCK_LOG_LIMIT } from '../../../shared/types'
import { createMockServersApi } from './mockServers'

const W = 'w'
const C = 'c'

function example(over: Partial<MockExample>): MockExample {
  return {
    requestId: 'r',
    exampleIndex: 0,
    requestName: 'Request',
    name: 'Example',
    method: 'GET',
    url: '{{baseUrl}}/users',
    code: 200,
    status: 'OK',
    headers: [],
    body: '',
    bodyEncoding: null,
    requestBody: null,
    ...over,
  }
}

let mock: ReturnType<typeof createMockServersApi>
let events: MockServerEvent[]
beforeEach(() => {
  mock = createMockServersApi()
  events = []
  mock.api.onMockServerEvent((e) => events.push(e))
})

const start = (examples: MockExample[], over: { port?: number; options?: { cors: 'local' | 'any'; delayMs: number } } = {}) =>
  mock.api.startMockServer({ workspaceId: W, collectionId: C, collectionName: 'Users', port: over.port ?? 4010, examples, options: over.options })

describe('browser mock of mock servers', () => {
  it('starts with a name and default options, and reports updates, options and stops as main does', async () => {
    const info = await start([example({})])
    expect(info).toMatchObject({ collectionName: 'Users', options: { cors: 'local', delayMs: 0 }, port: 4010, exampleCount: 1 })
    expect(events.map((e) => e.type)).toEqual(['started'])

    // Same name: no event; a rename: 'updated'.
    await mock.api.updateMockServer(C, [], 'Users')
    expect(events).toHaveLength(1)
    expect(await mock.api.updateMockServer(C, [], 'People')).toMatchObject({ collectionName: 'People', exampleCount: 0 })
    expect(events[1]).toMatchObject({ type: 'updated', server: { collectionName: 'People' } })

    expect(await mock.api.setMockServerOptions(C, { cors: 'any', delayMs: 20 })).toMatchObject({ options: { cors: 'any', delayMs: 20 } })
    expect(events[2]).toMatchObject({ type: 'updated', server: { options: { cors: 'any', delayMs: 20 } } })
    await expect(mock.api.setMockServerOptions(C, { cors: 'any', delayMs: 60001 })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(mock.api.setMockServerOptions(C, { cors: 'all' as 'any', delayMs: 0 })).rejects.toMatchObject({ code: 'invalid_input' })

    // Another port: the old one is 'replaced'.
    await start([], { port: 4020 })
    expect(events.slice(3).map((e) => (e.type === 'stopped' ? `stopped:${e.by}` : e.type))).toEqual(['stopped:replaced', 'started'])

    mock.controls.crash(C, 'boom')
    expect(events.at(-1)).toEqual({ type: 'stopped', collectionId: C, reason: 'boom', by: 'error' })
    await start([])
    await mock.api.stopMockServer(C)
    expect(events.at(-1)).toEqual({ type: 'stopped', collectionId: C, reason: null, by: 'user' })
    await start([])
    mock.controls.quit()
    expect(events.at(-1)).toEqual({ type: 'stopped', collectionId: C, reason: 'app quit', by: 'quit' })
    await expect(mock.api.setMockServerOptions(C, { cors: 'local', delayMs: 0 })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('logs the request headers and body and the answer', async () => {
    await start([example({ headers: [{ key: 'Content-Type', value: 'application/json' }, { key: 'Content-Length', value: '1' }], body: '[]' })], {
      options: { cors: 'local', delayMs: 15 },
    })
    const res = mock.controls.hit(C, { method: 'post', path: '/users?x=1', headers: { 'X-Thing': 'a', Accept: '*/*' }, body: '{"a":1}' })
    expect(res.status).toBe(404)
    const ok = mock.controls.hit(C, { path: '/users', headers: { 'X-Thing': 'a' } })
    expect(ok).toMatchObject({ status: 200, body: '[]' })
    expect(ok.entry).toMatchObject({
      kind: 'example',
      match: { name: 'Example' },
      request: { headers: [['x-thing', 'a']], body: null, bodyEncoding: null, bodyBytes: 0, truncated: false },
      // Framing headers are not sent.
      response: { statusText: 'OK', headers: [['content-type', 'application/json']], delayMs: 15 },
      durationMs: 15,
    })
    expect(res.entry).toMatchObject({
      kind: 'notFound',
      method: 'POST',
      path: '/users?x=1',
      request: { headers: [['x-thing', 'a'], ['accept', '*/*']], body: '{"a":1}', bodyEncoding: null, bodyBytes: 7, truncated: false },
      response: { statusText: 'Not Found', delayMs: 15 },
    })

    const binary = mock.controls.hit(C, { method: 'PUT', path: '/users', body: new Uint8Array([0xff, 0x00]) }).entry.request
    expect(binary).toMatchObject({ body: '/wA=', bodyEncoding: 'base64', bodyBytes: 2, truncated: false })
    const long = mock.controls.hit(C, { method: 'PUT', path: '/users', body: 'é'.repeat(MOCK_LOG_BODY_LIMIT) }).entry.request
    expect(long).toMatchObject({ bodyEncoding: null, bodyBytes: MOCK_LOG_BODY_LIMIT * 2, truncated: true })
    expect(long.body).toHaveLength(MOCK_LOG_BODY_LIMIT / 2)

    expect(await mock.api.getMockServerLog(C)).toHaveLength(4)
  })

  it('matches query parameters and the saved request body like main', async () => {
    await start([
      example({ name: 'All', url: '/users' }),
      example({ name: 'Page 2', url: '/users?page=2' }),
      example({ name: 'Ann', method: 'POST', url: '/users', requestBody: '{"name":"Ann"}' }),
      example({ name: 'Bob', method: 'POST', url: '/users', requestBody: '{"name":"Bob"}' }),
    ])
    const name = (req: Parameters<typeof mock.controls.hit>[1]) => mock.controls.hit(C, req).entry.match?.name
    expect(name({ path: '/users' })).toBe('All')
    expect(name({ path: '/users?page=2' })).toBe('Page 2')
    expect(name({ method: 'POST', path: '/users', body: '{ "name": "Bob" }' })).toBe('Bob')
    expect(name({ method: 'POST', path: '/users', body: 'nothing alike' })).toBe('Ann')
  })

  it('answers CORS per the options and refuses foreign hosts', async () => {
    await start([example({ body: '[]' })])
    const local = mock.controls.hit(C, { path: '/users', headers: { Origin: 'http://localhost:5173' } })
    expect(local.headers).toContainEqual(['access-control-allow-origin', 'http://localhost:5173'])
    // A foreign page still gets its answer but no CORS headers (the browser hides it).
    const foreign = mock.controls.hit(C, { path: '/users', headers: { Origin: 'https://site.example' } })
    expect(foreign.status).toBe(200)
    expect(foreign.headers.some(([k]) => k.startsWith('access-control'))).toBe(false)

    const preflight = { method: 'OPTIONS', path: '/users', headers: { Origin: 'https://site.example', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'x-a' } }
    expect(mock.controls.hit(C, preflight).entry).toMatchObject({ kind: 'refused', status: 403, reason: expect.stringMatching(/Allow any website/) })
    await mock.api.setMockServerOptions(C, { cors: 'any', delayMs: 100 })
    const allowed = mock.controls.hit(C, preflight)
    expect(allowed.entry).toMatchObject({ kind: 'preflight', status: 204, response: { statusText: 'No Content', delayMs: 0 } })
    expect(allowed.headers).toEqual(
      expect.arrayContaining([
        ['access-control-allow-methods', 'PUT'],
        ['access-control-allow-headers', 'x-a'],
        ['access-control-allow-origin', 'https://site.example'],
      ]),
    )

    const rebinding = mock.controls.hit(C, { path: '/users', headers: { Host: 'attacker.example' } })
    expect(rebinding.entry).toMatchObject({ kind: 'refused', status: 403, reason: 'Refused: Host "attacker.example" is not a loopback name.' })
  })

  it('keeps the latest MOCK_LOG_LIMIT entries', async () => {
    await start([])
    for (let i = 0; i < MOCK_LOG_LIMIT + 5; i++) mock.controls.hit(C, { path: `/x/${i}` })
    const log = await mock.api.getMockServerLog(C)
    expect(log).toHaveLength(MOCK_LOG_LIMIT)
    expect(log[0]!.seq).toBe(6)
  })
})
