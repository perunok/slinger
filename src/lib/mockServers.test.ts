import { describe, expect, it } from 'vitest'
import { MOCK_LIMITS, type ApiFolder, type ApiRequest } from '../../shared/types'
import { compileMockRoutes, matchMockRequest } from '../../shared/mockMatch'
import {
  DEFAULT_MOCK_PORT,
  MOCK_SETTINGS_KEY,
  collectMockExamples,
  collectionMockSettings,
  displayHeaderValue,
  isCredentialHeader,
  loadMockSettings,
  logTime,
  mockBaseUrl,
  mockRequestBody,
  mockSourceKey,
  normalizeMockOptions,
  parseDelay,
  parsePort,
  pathOnly,
  prettyBody,
  queryParams,
  saveMockSettings,
  suggestPort,
  updateMockSettings,
  withCollectionSettings,
  withoutCollection,
  withRunning,
} from './mockServers'
import { parseBody } from './request'

const C = 'c0000000-0000-4000-8000-000000000000'
function folder(id: string, sortOrder: number, parentFolderId: string | null = null): ApiFolder {
  return { id, workspaceId: 'w', collectionId: C, parentFolderId, name: id, sortOrder, createdAt: 0, updatedAt: 0, version: 1 }
}
function request(id: string, over: Partial<ApiRequest> & { doc?: Record<string, unknown> } = {}): ApiRequest {
  const { doc, ...rest } = over
  return {
    id,
    workspaceId: 'w',
    collectionId: C,
    folderId: null,
    name: id,
    method: 'GET',
    url: '{{baseUrl}}/' + id,
    documentJson: JSON.stringify(doc ?? {}),
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    version: 1,
    ...rest,
  }
}

describe('collectMockExamples: ids, saved request headers and the IPC limits', () => {
  it('sends the example id and the enabled headers of its saved request', () => {
    const [ex] = collectMockExamples([], [
      request('r', {
        doc: {
          responses: [
            {
              id: 'ex-1',
              name: 'A',
              originalRequest: { method: 'GET', url: '/a', header: [{ key: 'X-Api-Version', value: '2' }, { key: 'X-Off', value: '1', disabled: true }] },
              code: 200,
              body: '{}',
            },
          ],
        },
      }),
    ])
    expect(ex!.id).toBe('ex-1')
    expect(ex!.requestHeaders).toEqual([{ key: 'X-Api-Version', value: '2' }])
  })

  it('clips what main would refuse, so one odd example never stops the collection from being served', () => {
    const big = 'x'.repeat(MOCK_LIMITS.requestBody + 1)
    const examples = collectMockExamples([], [
      request('r', {
        name: 'n'.repeat(MOCK_LIMITS.name + 10),
        doc: {
          responses: [
            { name: 'N'.repeat(MOCK_LIMITS.name + 1), originalRequest: { method: 'POST', url: '/a', body: { mode: 'raw', raw: big } }, code: 200, body: 'ok' },
            { name: 'too big', originalRequest: { method: 'GET', url: '/b' }, code: 200, body: 'b'.repeat(MOCK_LIMITS.body + 1) },
            { name: 'fine', originalRequest: { method: 'GET', url: '/c' }, code: 200, body: 'c', id: 'i'.repeat(MOCK_LIMITS.id + 1) },
          ],
        },
      }),
    ])
    expect(examples.map((e) => e.url)).toEqual(['/a', '/c'])
    expect(examples[0]!.name).toHaveLength(MOCK_LIMITS.name)
    expect(examples[0]!.requestName).toHaveLength(MOCK_LIMITS.name)
    expect(examples[0]!.requestBody).toBeNull()
    expect(examples[1]!.id).toBeNull()
  })
})

describe('collectMockExamples', () => {
  it('reads every example in collection order with method, URL, status, headers and body', () => {
    const folders = [folder('f1', 0)]
    const requests = [
      request('root', {
        sortOrder: 0,
        doc: {
          responses: [
            {
              name: 'List',
              originalRequest: { method: 'get', url: { raw: '{{baseUrl}}/users?page=1', host: ['{{baseUrl}}'], path: ['users'] } },
              code: 200,
              status: 'OK',
              header: [
                { key: 'Content-Type', value: 'application/json' },
                { key: 'X-Off', value: '1', disabled: true },
              ],
              body: '[]',
            },
          ],
        },
      }),
      request('inFolder', {
        folderId: 'f1',
        method: 'DELETE',
        url: '{{baseUrl}}/users/:id',
        // No originalRequest: the parent request's method and URL apply.
        doc: { responses: [{ name: 'Gone', code: 204, status: 'No Content', body: '' }, { code: 500 }] },
      }),
      request('noExamples'),
    ]
    const list = collectMockExamples(folders, requests)
    // Folders come first (sidebar order).
    expect(list.map((e) => [e.requestId, e.exampleIndex, e.name, e.method, e.url, e.code])).toEqual([
      ['inFolder', 0, 'Gone', 'DELETE', '{{baseUrl}}/users/:id', 204],
      ['inFolder', 1, 'Untitled example', 'DELETE', '{{baseUrl}}/users/:id', 500],
      ['root', 0, 'List', 'GET', '{{baseUrl}}/users?page=1', 200],
    ])
    const listEx = list[2]!
    expect(listEx.headers).toEqual([{ key: 'Content-Type', value: 'application/json' }])
    expect(listEx).toMatchObject({ requestName: 'root', status: 'OK', body: '[]', bodyEncoding: null, requestBody: null })
  })

  it('skips MCP requests (method MCP or an mcp document)', () => {
    const responses = [{ name: 'r', code: 200, body: '{}' }]
    const list = collectMockExamples([], [
      request('http', { doc: { responses } }),
      request('mcpMethod', { method: 'MCP', doc: { responses } }),
      request('mcpDoc', { method: 'POST', doc: { mcp: { v: 1, transport: 'http' }, responses } }),
      request('mcpNotObject', { doc: { mcp: 'x', responses } }),
    ])
    expect(list.map((e) => e.requestId)).toEqual(['http', 'mcpNotObject'])
  })

  it('fills requestBody from the example\'s saved request, else the parent request', () => {
    const list = collectMockExamples([], [
      request('raw', {
        method: 'POST',
        sortOrder: 0,
        doc: {
          body: { mode: 'raw', raw: '{"parent":true}' },
          responses: [
            { name: 'own', originalRequest: { method: 'POST', url: '/users', body: { mode: 'raw', raw: '{"name":"Ann"}' } } },
            { name: 'fromParent' },
            { name: 'noBody', originalRequest: { method: 'POST', url: '/users' } },
          ],
        },
      }),
      request('form', {
        method: 'POST',
        sortOrder: 1,
        doc: {
          responses: [
            {
              name: 'urlencoded',
              originalRequest: {
                method: 'POST',
                url: '/login',
                body: { mode: 'urlencoded', urlencoded: [{ key: 'user', value: 'a b' }, { key: 'pw', value: '1&2' }, { key: 'off', value: 'x', disabled: true }] },
              },
            },
            {
              name: 'formdata',
              originalRequest: {
                method: 'POST',
                url: '/upload',
                body: { mode: 'formdata', formdata: [{ key: 'title', value: 'T' }, { key: 'file', type: 'file', src: '/tmp/x' }] },
              },
            },
            { name: 'file', originalRequest: { method: 'POST', url: '/bin', body: { mode: 'file', file: { src: '/tmp/x' } } } },
          ],
        },
      }),
    ])
    expect(list.map((e) => [e.name, e.requestBody])).toEqual([
      ['own', '{"name":"Ann"}'],
      ['fromParent', '{"parent":true}'],
      ['noBody', null],
      ['urlencoded', 'user=a+b&pw=1%262'],
      ['formdata', 'title=T'],
      ['file', null],
    ])
  })

  it('adds a Content-Type from the preview language only when missing', () => {
    const list = collectMockExamples([], [
      request('a', { doc: { responses: [{ name: 'json', _postman_previewlanguage: 'json', body: '{}' }, { name: 'empty', _postman_previewlanguage: 'json', body: '' }] } }),
      request('b', { doc: { responses: [{ name: 'own', _postman_previewlanguage: 'json', header: [{ key: 'content-type', value: 'text/x' }], body: 'x' }] } }),
    ])
    expect(list[0]!.headers).toEqual([{ key: 'Content-Type', value: 'application/json; charset=utf-8' }])
    expect(list[1]!.headers).toEqual([])
    expect(list[2]!.headers).toEqual([{ key: 'content-type', value: 'text/x' }])
  })

  it('keeps base64 bodies encoded', () => {
    const [e] = collectMockExamples([], [request('bin', { doc: { responses: [{ name: 'png', body: 'iVBORw==', _slinger_body_encoding: 'base64' }] } })])
    expect(e).toMatchObject({ body: 'iVBORw==', bodyEncoding: 'base64' })
  })

  it('survives corrupt documents and odd codes', () => {
    const list = collectMockExamples([], [
      { ...request('bad'), documentJson: '{"responses": nope' },
      request('odd', { doc: { responses: ['not an object', { name: 'weird', code: 'abc' }] } }),
    ])
    expect(list.map((e) => [e.requestId, e.name, e.code])).toEqual([
      ['odd', 'Untitled example', null],
      ['odd', 'weird', null],
    ])
  })

  it('feeds the shared matcher (end to end through the URL forms Postman uses)', () => {
    const examples = collectMockExamples([], [
      request('one', { url: '{{baseUrl}}/users/:id', doc: { responses: [{ name: 'Found', code: 200 }, { name: 'Missing', code: 404 }] } }),
      request('me', { url: 'https://api.example.com/users/me', doc: { responses: [{ name: 'Me', code: 200 }] } }),
    ])
    const routes = compileMockRoutes(examples)
    const match = (path: string, headers: Record<string, string> = {}) => matchMockRequest(routes, { method: 'GET', path, header: (n) => headers[n] }).route?.example.name
    expect(match('/users/7')).toBe('Found')
    expect(match('/users/me')).toBe('Me')
    expect(match('/users/7', { 'x-mock-response-code': '404' })).toBe('Missing')
  })
})

describe('mockRequestBody', () => {
  it('turns every body kind into text or null', () => {
    expect(mockRequestBody(parseBody(null))).toBeNull()
    expect(mockRequestBody(parseBody({ mode: 'raw', raw: '' }))).toBeNull()
    expect(mockRequestBody(parseBody({ mode: 'raw', raw: '<a/>' }))).toBe('<a/>')
    expect(mockRequestBody(parseBody({ mode: 'urlencoded', urlencoded: [] }))).toBeNull()
    expect(mockRequestBody(parseBody({ mode: 'graphql', graphql: { query: '{ me { id } }', variables: '{"a":1}' } }))).toBe('{"query":"{ me { id } }","variables":{"a":1}}')
    expect(mockRequestBody(parseBody({ mode: 'graphql', graphql: { query: '{ me }', variables: 'not json' } }))).toBe('{"query":"{ me }"}')
    expect(mockRequestBody(parseBody({ mode: 'graphql', graphql: { query: '' } }))).toBeNull()
    expect(mockRequestBody(parseBody({ mode: 'something' }))).toBeNull()
  })
})

describe('mockSourceKey', () => {
  it('changes when a request version, place or name changes, not on reordering the input', () => {
    const a = request('a')
    const b = request('b')
    const key = mockSourceKey([], [a, b])
    expect(mockSourceKey([], [b, a])).toBe(key)
    expect(mockSourceKey([], [{ ...a, version: 2 }, b])).not.toBe(key)
    expect(mockSourceKey([], [{ ...a, sortOrder: 5 }, b])).not.toBe(key)
    expect(mockSourceKey([folder('f', 0)], [a, b])).not.toBe(key)
    expect(mockSourceKey([], [a])).not.toBe(key)
  })
})

describe('ports', () => {
  it('parsePort accepts 1024-65535', () => {
    expect(parsePort(' 4010 ')).toEqual({ port: 4010, error: null })
    expect(parsePort('65535').port).toBe(65535)
    expect(parsePort('80').error).toMatch(/administrator/)
    for (const bad of ['', 'abc', '70000', '-1', '40.5', '0']) expect(parsePort(bad).port, bad).toBeNull()
  })

  it('suggestPort prefers the remembered port, else the first free from the default', () => {
    expect(suggestPort(undefined, new Set())).toBe(DEFAULT_MOCK_PORT)
    expect(suggestPort(5000, new Set())).toBe(5000)
    expect(suggestPort(5000, new Set([5000]))).toBe(DEFAULT_MOCK_PORT)
    expect(suggestPort(undefined, new Set([4010, 4011]))).toBe(4012)
  })

  it('formats URLs and times', () => {
    expect(mockBaseUrl(4010)).toBe('http://127.0.0.1:4010')
    expect(logTime(new Date(2026, 0, 2, 3, 4, 5).getTime() / 1000)).toBe('03:04:05')
  })
})

function memoryStorage(initial?: string) {
  const data = new Map<string, string>()
  if (initial !== undefined) data.set(MOCK_SETTINGS_KEY, initial)
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) }
}

describe('remembered settings', () => {
  it('migrates the old ports-only format', () => {
    const storage = memoryStorage('{"ports":{"a":5001,"b":1.5,"c":"7","d":70000}}')
    expect(loadMockSettings(storage)).toEqual({
      collections: { a: { port: 5001, options: { cors: 'local', delayMs: 0 }, startWithSlinger: true } },
      running: [],
    })
  })

  it('round-trips collections and the running list, dropping junk', () => {
    const storage = memoryStorage()
    expect(loadMockSettings(storage)).toEqual({ collections: {}, running: [] })
    let s = withCollectionSettings(loadMockSettings(storage), 'x', { port: 5001, options: { cors: 'any', delayMs: 250 } })
    s = withCollectionSettings(s, 'y', { startWithSlinger: false })
    s = withRunning(s, { collectionId: 'x', workspaceId: 'w1' }, true)
    s = withRunning(s, { collectionId: 'x', workspaceId: 'w2' }, true)
    saveMockSettings(storage, s)
    expect(JSON.parse(storage.data.get(MOCK_SETTINGS_KEY)!).v).toBe(2)
    const loaded = loadMockSettings(storage)
    expect(loaded).toEqual({
      collections: {
        x: { port: 5001, options: { cors: 'any', delayMs: 250 }, startWithSlinger: true },
        y: { port: null, options: { cors: 'local', delayMs: 0 }, startWithSlinger: false },
      },
      running: [{ collectionId: 'x', workspaceId: 'w2' }],
    })
    expect(collectionMockSettings(loaded, 'nope')).toEqual({ port: null, options: { cors: 'local', delayMs: 0 }, startWithSlinger: true })
    expect(withRunning(loaded, { collectionId: 'x', workspaceId: '' }, false).running).toEqual([])
    expect(withoutCollection(loaded, 'x')).toEqual({ collections: { y: loaded.collections.y }, running: [] })

    storage.data.set(
      MOCK_SETTINGS_KEY,
      JSON.stringify({
        v: 2,
        collections: { a: { port: 0, options: { cors: 'everyone', delayMs: 999999 } }, b: 'junk' },
        running: [{ collectionId: 'a', workspaceId: 'w' }, { collectionId: 'a', workspaceId: 'w' }, { collectionId: 5 }, 'x'],
      }),
    )
    expect(loadMockSettings(storage)).toEqual({
      collections: { a: { port: null, options: { cors: 'local', delayMs: 60000 }, startWithSlinger: true } },
      running: [{ collectionId: 'a', workspaceId: 'w' }],
    })
    storage.data.set(MOCK_SETTINGS_KEY, 'not json')
    expect(loadMockSettings(storage)).toEqual({ collections: {}, running: [] })
  })

  it('survives storage that throws or is missing', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    }
    expect(loadMockSettings(throwing)).toEqual({ collections: {}, running: [] })
    expect(() => saveMockSettings(throwing, { collections: {}, running: [] })).not.toThrow()
    expect(loadMockSettings(null)).toEqual({ collections: {}, running: [] })
    expect(updateMockSettings(null, (s) => withCollectionSettings(s, 'x', { port: 4010 })).collections.x!.port).toBe(4010)
  })

  it('normalizes options and parses the delay field', () => {
    expect(normalizeMockOptions(undefined)).toEqual({ cors: 'local', delayMs: 0 })
    expect(normalizeMockOptions({ cors: 'any', delayMs: 12.6 })).toEqual({ cors: 'any', delayMs: 13 })
    expect(normalizeMockOptions({ delayMs: -5 })).toEqual({ cors: 'local', delayMs: 0 })
    expect(parseDelay(' 1500 ')).toEqual({ delayMs: 1500, error: null })
    expect(parseDelay('')).toEqual({ delayMs: 0, error: null })
    expect(parseDelay('60000').delayMs).toBe(60000)
    for (const bad of ['60001', '-1', '1.5', 'abc']) expect(parseDelay(bad).error, bad).toMatch(/between 0 and 60000/)
  })
})

describe('request inspector helpers', () => {
  it('shortens credential headers and leaves the rest alone', () => {
    for (const name of ['Authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'X-API-Key', 'x-csrf-token', 'X-Client-Secret']) {
      expect(isCredentialHeader(name), name).toBe(true)
    }
    for (const name of ['content-type', 'accept', 'x-request-id']) expect(isCredentialHeader(name), name).toBe(false)
    expect(displayHeaderValue('authorization', 'Bearer abcdefghijklmnop')).toBe('Bearer… (23 characters)')
    expect(displayHeaderValue('x-api-key', 'abcd')).toBe('ab… (4 characters)')
    expect(displayHeaderValue('cookie', 'a')).toBe('… (1 character)')
    expect(displayHeaderValue('accept', 'application/json')).toBe('application/json')
  })

  it('splits query parameters and pretty-prints JSON bodies', () => {
    expect(queryParams('/users?page=2&q=a%20b&flag&q=c')).toEqual([
      ['page', '2'],
      ['q', 'a b'],
      ['flag', ''],
      ['q', 'c'],
    ])
    expect(queryParams('/users')).toEqual([])
    expect(queryParams('/users?')).toEqual([])
    expect(pathOnly('/users?page=2')).toBe('/users')
    expect(prettyBody('{"a":[1,2]}')).toEqual({ text: '{\n  "a": [\n    1,\n    2\n  ]\n}', json: true })
    expect(prettyBody('{not json')).toEqual({ text: '{not json', json: false })
    expect(prettyBody('a=1')).toEqual({ text: 'a=1', json: false })
  })
})
