import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { postmanUrlToString } from '../services/postmanImport'
import { makeEnv, SAMPLE_COLLECTION, scaffold, type TestEnv } from './helpers'

let env: TestEnv
let wsId: string
beforeEach(async () => {
  env = makeEnv()
  wsId = (await scaffold(env)).workspace.id
})
afterEach(() => env.cleanup())

const collectionCount = () => (env.core.db.prepare('SELECT COUNT(*) n FROM collections WHERE workspace_id = ?').get(wsId) as { n: number }).n

describe('Postman import', () => {
  it('imports the sample collection (8 flat requests, first is POST "Create Charge Detail")', async () => {
    const imported = await env.api.importPostmanCollection(wsId, readFileSync(SAMPLE_COLLECTION, 'utf8'))
    const stored = await env.api.listRequests(imported.collection.id)
    expect(imported.collection.name).toBe('thub-collection')
    expect(imported.folders).toHaveLength(0)
    expect(imported.requests).toHaveLength(8)
    expect(stored).toHaveLength(8)
    expect(stored[0]).toMatchObject({ method: 'POST', name: 'Create Charge Detail' })
    expect(stored.map((r) => r.sortOrder)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    for (const r of stored) expect(() => JSON.parse(r.documentJson)).not.toThrow()
  })

  it('preserves nested folders and their parent links', async () => {
    const payload = JSON.stringify({
      info: { name: 'nested' },
      item: [
        {
          name: 'Admin',
          item: [
            { name: 'Users', item: [{ name: 'List Users', request: { method: 'GET', url: { raw: 'https://example.com/users' } } }] },
            { name: 'Health', request: { method: 'get', url: 'https://example.com/health' } },
          ],
        },
        { name: 'Root request', request: { method: 'DELETE', url: { host: ['example', 'com'], path: ['a', 'b'] } } },
      ],
    })
    const imported = await env.api.importPostmanCollection(wsId, payload)
    const folders = await env.api.listFolders(imported.collection.id)
    const requests = await env.api.listRequests(imported.collection.id)

    expect(folders.map((f) => f.name)).toEqual(['Admin', 'Users'])
    expect(folders[1]!.parentFolderId).toBe(folders[0]!.id)
    expect(folders[0]!.parentFolderId).toBeNull()
    const byName = Object.fromEntries(requests.map((r) => [r.name, r]))
    expect(byName['List Users']!.folderId).toBe(folders[1]!.id)
    expect(byName['Health']).toMatchObject({ folderId: folders[0]!.id, method: 'GET' })
    expect(byName['Root request']).toMatchObject({ folderId: null, method: 'DELETE', url: 'example.com/a/b' })
    expect(imported.folders).toHaveLength(2)
    expect(imported.requests).toHaveLength(3)
    expect(new Set([...folders, ...requests].map((x) => x.workspaceId))).toEqual(new Set([wsId]))
  })

  it('keeps v2.1 headers, body, auth, scripts and the source item in the request document', async () => {
    const item = {
      name: 'Create',
      event: [{ listen: 'test', script: { exec: ['pm.test()'] } }],
      request: {
        method: 'POST',
        header: [{ key: 'X-A', value: '1' }, { key: 'X-Off', value: '2', disabled: true }],
        body: { mode: 'raw', raw: '{"a":1}', options: { raw: { language: 'json' } } },
        auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] },
        url: { raw: '{{base}}/things?x=1', host: ['{{base}}'], path: ['things'] },
        description: 'makes a thing',
      },
      response: [{ name: 'ok' }],
    }
    const imported = await env.api.importPostmanCollection(wsId, JSON.stringify({ info: { name: 'c' }, item: [item] }))
    const doc = JSON.parse(imported.requests[0]!.documentJson)
    expect(imported.requests[0]).toMatchObject({ method: 'POST', url: '{{base}}/things?x=1' })
    expect(doc.headers).toEqual(item.request.header)
    expect(doc.body).toEqual(item.request.body)
    expect(doc.auth).toEqual(item.request.auth)
    expect(doc.scripts).toEqual(item.event)
    expect(doc.responses).toEqual(item.response)
    expect(doc.description).toBe('makes a thing')
    expect(doc.source).toEqual(item)
  })

  it('inherits auth from the nearest folder or collection when the request has none', async () => {
    const collectionAuth = { type: 'bearer', bearer: [{ key: 'token', value: 'root' }] }
    const folderAuth = { type: 'basic', basic: [{ key: 'username', value: 'u' }] }
    const own = { type: 'apikey', apikey: [] }
    const payload = JSON.stringify({
      info: { name: 'c' },
      auth: collectionAuth,
      item: [
        { name: 'top', request: { method: 'GET', url: 'http://a' } },
        { name: 'F', auth: folderAuth, item: [{ name: 'inF', request: { method: 'GET', url: 'http://b' } }, { name: 'own', request: { method: 'GET', url: 'http://c', auth: own } }] },
      ],
    })
    const { requests } = await env.api.importPostmanCollection(wsId, payload)
    const auth = Object.fromEntries(requests.map((r) => [r.name, JSON.parse(r.documentJson).auth]))
    expect(auth).toEqual({ top: collectionAuth, inF: folderAuth, own })
  })

  it('applies defaults for missing names/methods and preserves sibling order', async () => {
    const payload = JSON.stringify({
      item: [
        { request: { url: 'http://a' } },
        { name: '  ', item: [{ name: 'x', request: { method: '', url: 'http://b' } }] },
        { name: 'second', request: { method: 'patch', url: 'http://c' } },
      ],
    })
    const imported = await env.api.importPostmanCollection(wsId, payload)
    expect(imported.collection.name).toBe('Imported Collection')
    expect(imported.folders[0]!.name).toBe('Untitled Folder')
    const top = imported.requests.filter((r) => r.folderId === null)
    expect(top.map((r) => [r.name, r.method, r.sortOrder])).toEqual([['Untitled Request', 'GET', 0], ['second', 'PATCH', 1]])
  })

  it('is atomic: invalid or request-less payloads create nothing', async () => {
    const before = collectionCount()
    await expect(env.api.importPostmanCollection(wsId, 'not json')).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(env.api.importPostmanCollection(wsId, '{"info":{}}')).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(env.api.importPostmanCollection(wsId, '[]')).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(env.api.importPostmanCollection(wsId, JSON.stringify({ item: [{ name: 'empty folder', item: [] }] }))).rejects.toMatchObject({ code: 'invalid_input' })
    expect(collectionCount()).toBe(before)
    expect(env.core.db.prepare('SELECT COUNT(*) n FROM folders').get()).toEqual({ n: 0 })
  })

  it('rejects absurdly deep nesting', async () => {
    let node: unknown = { name: 'leaf', request: { method: 'GET', url: 'http://x' } }
    for (let i = 0; i < 150; i++) node = { name: `f${i}`, item: [node] }
    await expect(env.api.importPostmanCollection(wsId, JSON.stringify({ item: [node] }))).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('converts URL objects', () => {
    expect(postmanUrlToString('http://a')).toBe('http://a')
    expect(postmanUrlToString({ raw: 'http://raw' })).toBe('http://raw')
    expect(postmanUrlToString({ host: ['api', 'x', 'com'], path: ['v1', 'u'] })).toBe('api.x.com/v1/u')
    expect(postmanUrlToString({ host: ['h'] })).toBe('h')
    expect(postmanUrlToString(null)).toBe('')
  })
})
