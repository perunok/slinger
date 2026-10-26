import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { postmanUrlToString } from '../services/postmanImport'
import { buildPostmanCollection } from '../../src/lib/postman'
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

  it('keeps every saved example (16) and the renderer export writes them back byte for byte', async () => {
    const text = readFileSync(SAMPLE_COLLECTION, 'utf8')
    const original = JSON.parse(text)
    const imported = await env.api.importPostmanCollection(wsId, text)
    const requests = await env.api.listRequests(imported.collection.id)
    const stored = requests.map((r) => JSON.parse(r.documentJson).responses as unknown[])
    expect(stored.reduce((n, list) => n + list.length, 0)).toBe(16)
    const exported = buildPostmanCollection({ collection: imported.collection, folders: await env.api.listFolders(imported.collection.id), requests })
    expect(exported.item.map((i) => i.name)).toEqual(original.item.map((i: { name: string }) => i.name))
    exported.item.forEach((item, i) => expect(JSON.stringify(item.response)).toBe(JSON.stringify(original.item[i].response)))
  })

  it('keeps collection and folder auth on the collection and folders; requests without their own inherit (no copies)', async () => {
    const payload = JSON.stringify({
      info: { name: 'Auth C', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      auth: { type: 'bearer', bearer: [{ key: 'token', value: 'root' }] },
      item: [
        { name: 'F', auth: { type: 'bearer', bearer: [{ key: 'token', value: 'folder' }] }, item: [{ name: 'in', request: { method: 'GET', url: 'http://x' } }] },
        { name: 'N', auth: { type: 'noauth' }, item: [{ name: 'open', request: { method: 'GET', url: 'http://x' } }] },
        { name: 'I', item: [{ name: 'deep', request: { method: 'GET', url: 'http://x', auth: null } }] },
        { name: 'top', request: { method: 'GET', url: 'http://x' } },
      ],
    })
    const imported = await env.api.importPostmanCollection(wsId, payload)
    expect(JSON.parse(imported.collection.authJson!)).toEqual({ type: 'bearer', bearer: [{ key: 'token', value: 'root' }] })
    const folders = Object.fromEntries((await env.api.listFolders(imported.collection.id)).map((f) => [f.name, f.authJson]))
    expect(JSON.parse(folders.F!)).toEqual({ type: 'bearer', bearer: [{ key: 'token', value: 'folder' }] })
    expect(folders.N).toBe('{"type":"noauth"}')
    expect(folders.I).toBeNull()
    const docs = Object.fromEntries((await env.api.listRequests(imported.collection.id)).map((r) => [r.name, JSON.parse(r.documentJson)]))
    for (const name of ['in', 'open', 'deep', 'top']) expect(docs[name].auth, name).toBeNull()
  })

  it('round-trips container auth: export writes it back, re-import keeps the inheritance', async () => {
    const payload = JSON.stringify({
      info: { name: 'RT' },
      auth: { type: 'apikey', apikey: [{ key: 'key', value: 'X-Key' }, { key: 'value', value: '{{k}}' }] },
      item: [{ name: 'F', auth: { type: 'noauth' }, item: [{ name: 'a', request: { method: 'GET', url: 'http://a' } }] }, { name: 'b', request: { method: 'GET', url: 'http://b' } }],
    })
    const first = await env.api.importPostmanCollection(wsId, payload)
    const folders = await env.api.listFolders(first.collection.id)
    const requests = await env.api.listRequests(first.collection.id)
    const exported = buildPostmanCollection({ collection: first.collection, folders, requests })
    expect(exported.auth).toEqual(JSON.parse(payload).auth)
    expect(exported.item[0]!.auth).toEqual({ type: 'noauth' })
    expect(exported.item[0]!.item![0]!.request!.auth).toBeUndefined()
    expect(exported.item[1]!.request!.auth).toBeUndefined()
    const again = await env.api.importPostmanCollection(wsId, JSON.stringify(exported), { name: 'copy' })
    expect(again.collection.authJson).toBe(first.collection.authJson)
    expect((await env.api.listFolders(again.collection.id))[0]!.authJson).toBe('{"type":"noauth"}')
  })

  it('drops OAuth 2.0 tokens from container auth and treats {type: inherit} as none set', async () => {
    const payload = JSON.stringify({
      info: { name: 'O' },
      auth: { type: 'oauth2', oauth2: [{ key: 'accessToken', value: 'SECRET' }, { key: 'grant_type', value: 'client_credentials' }] },
      item: [{ name: 'F', auth: { type: 'inherit' }, item: [{ name: 'a', request: { method: 'GET', url: 'http://a', auth: { type: 'inherit' } } }] }],
    })
    const imported = await env.api.importPostmanCollection(wsId, payload)
    expect(imported.collection.authJson).not.toContain('SECRET')
    expect(JSON.parse(imported.collection.authJson!).oauth2).toEqual([{ key: 'grant_type', value: 'client_credentials' }])
    expect(imported.folders[0]!.authJson).toBeNull()
    expect(JSON.parse(imported.requests[0]!.documentJson).auth).toBeNull()
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

  it('keeps a request\'s own auth (including an explicit "no auth") as it is', async () => {
    const own = { type: 'apikey', apikey: [] }
    const payload = JSON.stringify({
      info: { name: 'c' },
      auth: { type: 'bearer', bearer: [{ key: 'token', value: 'root' }] },
      item: [
        { name: 'top', request: { method: 'GET', url: 'http://a', auth: { type: 'noauth' } } },
        { name: 'F', item: [{ name: 'own', request: { method: 'GET', url: 'http://c', auth: own } }] },
      ],
    })
    const { requests } = await env.api.importPostmanCollection(wsId, payload)
    const auth = Object.fromEntries(requests.map((r) => [r.name, JSON.parse(r.documentJson).auth]))
    expect(auth).toEqual({ top: { type: 'noauth' }, own })
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
    // No `raw` (Postman SDK / Newman toJSON): rebuilt from its parts, disabled params skipped, variables untouched.
    expect(postmanUrlToString({ protocol: 'https', host: ['api', 'x', 'com'], port: '8443', path: ['v1', ':id'], query: [{ key: 'a', value: '1' }, { key: 'off', value: '2', disabled: true }, { key: 'flag', value: null }], hash: 'top' }))
      .toBe('https://api.x.com:8443/v1/:id?a=1&flag#top')
    expect(postmanUrlToString({ host: ['{{baseUrl}}'], path: ['users'], query: [{ key: 'q', value: '{{term}}' }] })).toBe('{{baseUrl}}/users?q={{term}}')
    expect(postmanUrlToString({ protocol: 'http:', host: 'localhost', port: '3000' })).toBe('http://localhost:3000')
    expect(postmanUrlToString(null)).toBe('')
  })
})
