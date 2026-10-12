import { describe, expect, it } from 'vitest'
import {
  compileMockPath,
  compileMockRoutes,
  corsOriginAllowed,
  isLoopbackHost,
  isLoopbackOrigin,
  mockQueryOf,
  matchMockRequest,
  mockNotFoundBody,
  mockPathOf,
  mockResponseHeaders,
  mockStatus,
  requestSegments,
  type MockRouteSource,
} from '../../shared/mockMatch'

type Ex = MockRouteSource & { tag: string }
const ex = (method: string, url: string, name = `${method} ${url}`, code: number | null = 200, id: string | null = null): Ex => ({
  method,
  url,
  name,
  code,
  id,
  tag: name,
})

function pick(examples: Ex[], method: string, path: string, headers: Record<string, string> = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return matchMockRequest(compileMockRoutes(examples), { method, path, header: (n) => lower[n] })
}
const tagOf = (examples: Ex[], method: string, path: string, headers?: Record<string, string>) => pick(examples, method, path, headers).route?.example.tag ?? null

describe('mockPathOf', () => {
  it.each([
    ['https://api.example.com/users/1', '/users/1'],
    ['http://localhost:3000/v1/users?active=true#top', '/v1/users'],
    ['{{baseUrl}}/users/:id', '/users/:id'],
    ['{{baseUrl}}', '/'],
    ['{{host}}:{{port}}/orders', '/orders'],
    ['{{scheme}}://{{host}}/orders/{{orderId}}', '/orders/{{orderId}}'],
    ['https://{{host}}/a/b', '/a/b'],
    ['https://example.com', '/'],
    ['api.example.com/users', '/users'],
    ['localhost:8080/health', '/health'],
    ['/plain/path', '/plain/path'],
    ['  {{baseUrl}}/trimmed  ', '/trimmed'],
    ['', '/'],
  ])('%s -> %s', (url, path) => {
    expect(mockPathOf(url)).toBe(path)
  })
})

describe('compileMockPath', () => {
  it('classifies segments and ignores empty ones', () => {
    expect(compileMockPath('/users//:id/')).toEqual([{ kind: 'literal', value: 'users' }, { kind: 'wildcard' }])
    expect(compileMockPath('/a/{{b}}')).toEqual([{ kind: 'literal', value: 'a' }, { kind: 'wildcard' }])
    const [mixed] = compileMockPath('/v{{version}}.json')
    expect(mixed!.kind).toBe('mixed')
    expect(compileMockPath('/caf%C3%A9')).toEqual([{ kind: 'literal', value: 'café' }])
    expect(compileMockPath('/')).toEqual([])
    // A lone ':' is literal text, not a parameter.
    expect(compileMockPath('/:')).toEqual([{ kind: 'literal', value: ':' }])
  })

  it('escapes regex characters in mixed segments', () => {
    const [seg] = compileMockPath('/file.{{ext}}')
    expect(seg!.kind === 'mixed' && seg.re.test('file.json')).toBe(true)
    expect(seg!.kind === 'mixed' && seg.re.test('fileXjson')).toBe(false)
  })
})

describe('requestSegments', () => {
  it('drops the query and decodes', () => {
    expect(requestSegments('/users/1?x=/y#z')).toEqual(['users', '1'])
    expect(requestSegments('/a%20b/%E2%9C%93')).toEqual(['a b', '✓'])
    expect(requestSegments('/bad%E0%A4%A')).toEqual(['bad%E0%A4%A'])
    expect(requestSegments('/')).toEqual([])
  })
})

describe('matchMockRequest', () => {
  const list = [
    ex('GET', '{{baseUrl}}/users', 'All users'),
    ex('GET', '{{baseUrl}}/users/:id', 'One user'),
    ex('GET', '{{baseUrl}}/users/me', 'Me'),
    ex('POST', '{{baseUrl}}/users', 'Created', 201),
    ex('GET', 'https://api.example.com/users/{{userId}}/posts', 'Posts'),
    ex('GET', '{{baseUrl}}/files/report.{{ext}}', 'Report'),
  ]

  it('matches by method and path, ignoring host, scheme, query and trailing slash', () => {
    expect(tagOf(list, 'GET', '/users')).toBe('All users')
    expect(tagOf(list, 'GET', '/users/?page=2')).toBe('All users')
    expect(tagOf(list, 'get', '/users')).toBe('All users')
    expect(tagOf(list, 'POST', '/users')).toBe('Created')
    expect(tagOf(list, 'GET', '/users/42/posts')).toBe('Posts')
    expect(tagOf(list, 'GET', '/files/report.csv')).toBe('Report')
  })

  it('treats :param and {{var}} segments as wildcards', () => {
    expect(tagOf(list, 'GET', '/users/42')).toBe('One user')
    expect(tagOf(list, 'GET', '/users/abc-def')).toBe('One user')
  })

  it('prefers an exact path over a wildcard, regardless of order', () => {
    expect(tagOf(list, 'GET', '/users/me')).toBe('Me')
    const reversed = [ex('GET', '/users/me', 'Me'), ex('GET', '/users/:id', 'One user')]
    expect(tagOf(reversed, 'GET', '/users/me')).toBe('Me')
    // Specificity from the left: /a/:x/c vs /:y/b/c for /a/b/c -> the first literal segment wins.
    expect(tagOf([ex('GET', '/:y/b/c', 'right'), ex('GET', '/a/:x/c', 'left')], 'GET', '/a/b/c')).toBe('left')
    // Mixed beats a plain wildcard.
    expect(tagOf([ex('GET', '/files/:f', 'any'), ex('GET', '/files/{{n}}.json', 'json')], 'GET', '/files/a.json')).toBe('json')
  })

  it('takes the first example in collection order among equals', () => {
    const two = [ex('GET', '/ping', 'first'), ex('GET', '/ping', 'second')]
    expect(tagOf(two, 'GET', '/ping')).toBe('first')
  })

  it('literal segments are case-sensitive and must have the same count', () => {
    expect(tagOf(list, 'GET', '/Users')).toBeNull()
    expect(tagOf(list, 'GET', '/users/1/2')).toBeNull()
    expect(tagOf(list, 'GET', '/')).toBeNull()
  })

  it('HEAD falls back to GET examples, other methods do not', () => {
    expect(tagOf(list, 'HEAD', '/users')).toBe('All users')
    expect(tagOf([ex('HEAD', '/users', 'head')], 'HEAD', '/users')).toBe('head')
    expect(tagOf(list, 'DELETE', '/users')).toBeNull()
  })

  it('selects with x-mock-response-name / -code / -id', () => {
    const variants = [
      ex('GET', '/items/:id', 'Found', 200),
      ex('GET', '/items/:id', 'Not found', 404),
      ex('GET', '/items/:id', 'Server error', 500, 'ex-500'),
      ex('GET', '/items/special', 'Special', 200),
    ]
    expect(tagOf(variants, 'GET', '/items/1')).toBe('Found')
    expect(tagOf(variants, 'GET', '/items/1', { 'x-mock-response-name': 'Not found' })).toBe('Not found')
    expect(tagOf(variants, 'GET', '/items/1', { 'x-mock-response-name': '  not FOUND ' })).toBe('Not found')
    expect(tagOf(variants, 'GET', '/items/1', { 'x-mock-response-code': '500' })).toBe('Server error')
    expect(tagOf(variants, 'GET', '/items/1', { 'x-mock-response-id': 'ex-500' })).toBe('Server error')
    // The header can pick a wildcard example even where a literal one matches too.
    expect(tagOf(variants, 'GET', '/items/special', { 'x-mock-response-code': '404' })).toBe('Not found')
    // Both headers narrow together.
    expect(tagOf(variants, 'GET', '/items/1', { 'x-mock-response-name': 'Found', 'x-mock-response-code': '404' })).toBeNull()
  })

  it('a null code counts as 200 for x-mock-response-code', () => {
    expect(tagOf([ex('GET', '/n', 'no code', null)], 'GET', '/n', { 'x-mock-response-code': '200' })).toBe('no code')
  })

  it('explains why nothing matched', () => {
    expect(pick([], 'GET', '/x').reason).toBe('This collection has no saved examples.')
    expect(pick(list, 'GET', '/nope').reason).toBe('No saved example matches GET /nope.')
    expect(pick(list, 'DELETE', '/users').reason).toBe('No saved example for DELETE /users; examples on this path use GET, POST.')
    const named = pick([ex('GET', '/a', 'One'), ex('GET', '/a', 'Two')], 'GET', '/a', { 'x-mock-response-name': 'Three' })
    expect(named.reason).toBe('No example named "Three" matches GET /a (examples: "One", "Two").')
    expect(pick([ex('GET', '/a', 'One', 201)], 'GET', '/a', { 'x-mock-response-code': '500' }).reason).toBe(
      'No example with status 500 matches GET /a (statuses: 201).',
    )
    expect(pick([ex('GET', '/a', 'One')], 'GET', '/a', { 'x-mock-response-id': 'zzz' }).reason).toBe('No example with id "zzz" matches GET /a.')
  })
})

describe('response helpers', () => {
  it('drops framing headers and groups repeated ones', () => {
    expect(
      mockResponseHeaders([
        { key: 'Content-Type', value: 'application/json' },
        { key: 'Content-Length', value: '999' },
        { key: 'Content-Encoding', value: 'gzip' },
        { key: 'Transfer-Encoding', value: 'chunked' },
        { key: 'Set-Cookie', value: 'a=1' },
        { key: 'set-cookie', value: 'b=2' },
        { key: '  ', value: 'blank' },
      ]),
    ).toEqual([
      ['Content-Type', ['application/json']],
      ['Set-Cookie', ['a=1', 'b=2']],
    ])
  })

  it('uses final statuses only', () => {
    expect(mockStatus(201)).toBe(201)
    expect(mockStatus(599)).toBe(599)
    expect(mockStatus(null)).toBe(200)
    expect(mockStatus(101)).toBe(200)
    expect(mockStatus(700)).toBe(200)
  })

  it('builds a JSON 404 body', () => {
    expect(JSON.parse(mockNotFoundBody('nope'))).toMatchObject({ error: 'mockRequestNotFound', message: 'nope' })
  })

  it('accepts loopback Host headers only', () => {
    for (const ok of [undefined, '127.0.0.1:4010', 'localhost', 'LOCALHOST:1', '[::1]:4010', 'app.localhost:4010']) expect(isLoopbackHost(ok), String(ok)).toBe(true)
    for (const bad of ['evil.example.com', 'evil.example.com:4010', '192.168.1.5:4010', 'localhost.evil.com']) expect(isLoopbackHost(bad), bad).toBe(false)
  })

  it('reads saved query parameters; templates, :vars and empty values match any value', () => {
    expect(mockQueryOf('{{baseUrl}}/items?page=2&sort={{sort}}&id=:id&flag&q=a+b%21#frag')).toEqual([
      { key: 'page', value: '2' },
      { key: 'sort', value: null },
      { key: 'id', value: null },
      { key: 'flag', value: null },
      { key: 'q', value: 'a b!' },
    ])
    expect(mockQueryOf('/items')).toEqual([])
  })

  it('ranks by path first, then query parameters, then the request body, then collection order', () => {
    const src = (url: string, over: Partial<MockRouteSource> = {}): MockRouteSource => ({ method: 'GET', url, name: url, code: 200, ...over })
    const routes = compileMockRoutes([
      src('/items'),
      src('/items?page=2'),
      src('/items/:id?page=2'),
      src('/items/me'),
      src('/login', { method: 'POST', name: 'a', requestBody: '{"u":1}' }),
      src('/login', { method: 'POST', name: 'b', requestBody: '{"u":2}' }),
    ])
    const pick = (method: string, path: string, body?: string) =>
      matchMockRequest(routes, { method, path, header: () => undefined, body }).route?.example.name
    expect(pick('GET', '/items?page=2')).toBe('/items?page=2')
    expect(pick('GET', '/items?page=9')).toBe('/items')
    expect(pick('GET', '/items/me?page=2')).toBe('/items/me') // path specificity beats query
    expect(pick('POST', '/login', '{ "u": 2 }')).toBe('b')
    expect(pick('POST', '/login', 'not json')).toBe('a')
    expect(pick('POST', '/login')).toBe('a')
  })

  it('CORS origins: pages on this computer, or any with "any"', () => {
    for (const ok of ['http://localhost:5173', 'https://LOCALHOST', 'http://127.0.0.1:3000', 'http://[::1]:8080', 'http://app.localhost:1']) {
      expect(isLoopbackOrigin(ok), ok).toBe(true)
    }
    for (const bad of ['https://evil.example', 'http://localhost.evil.com', 'null', 'file://', 'http://192.168.1.2:3000', 'http://localhost:5173/path']) {
      expect(isLoopbackOrigin(bad), bad).toBe(false)
    }
    expect(corsOriginAllowed('local', 'https://evil.example')).toBe(false)
    expect(corsOriginAllowed('any', 'https://evil.example')).toBe(true)
    expect(corsOriginAllowed('any', undefined)).toBe(false)
  })
})
