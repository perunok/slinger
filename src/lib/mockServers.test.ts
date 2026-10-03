import { describe, expect, it } from 'vitest'
import type { ApiFolder, ApiRequest } from '../../shared/types'
import { compileMockRoutes, matchMockRequest } from '../../shared/mockMatch'
import {
  DEFAULT_MOCK_PORT,
  MOCK_PORTS_KEY,
  collectMockExamples,
  loadMockPorts,
  logTime,
  mockBaseUrl,
  mockSourceKey,
  parsePort,
  saveMockPort,
  suggestPort,
} from './mockServers'

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
    expect(listEx).toMatchObject({ requestName: 'root', status: 'OK', body: '[]', bodyEncoding: null })
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

  it('remembers the last port per collection and ignores junk', () => {
    const data = new Map<string, string>()
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) }
    expect(loadMockPorts(storage)).toEqual({})
    saveMockPort(storage, 'x', 5001)
    saveMockPort(storage, 'y', 5002)
    expect(loadMockPorts(storage)).toEqual({ x: 5001, y: 5002 })
    data.set(MOCK_PORTS_KEY, '{"ports":{"a":1.5,"b":"7","c":70000,"d":4010}}')
    expect(loadMockPorts(storage)).toEqual({ d: 4010 })
    data.set(MOCK_PORTS_KEY, 'not json')
    expect(loadMockPorts(storage)).toEqual({})
    const throwing = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    }
    expect(loadMockPorts(throwing)).toEqual({})
    expect(() => saveMockPort(throwing, 'x', 1)).not.toThrow()
    expect(loadMockPorts(null)).toEqual({})
  })

  it('formats URLs and times', () => {
    expect(mockBaseUrl(4010)).toBe('http://127.0.0.1:4010')
    expect(logTime(new Date(2026, 0, 2, 3, 4, 5).getTime() / 1000)).toBe('03:04:05')
  })
})
