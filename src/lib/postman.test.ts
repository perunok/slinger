import { describe, expect, it } from 'vitest'
import type { ApiFolder, ApiRequest, Collection } from '../../shared/types'
import { newRow, type KvRow } from './kv'
import {
  buildPostmanCollection,
  buildPostmanEnvironment,
  decomposeUrl,
  exportPostmanCollection,
  exportPostmanEnvironment,
} from './postman'
import { newDraft, parseDocument, serializeDraft, type RequestDraft } from './request'
import exampleCollection from '../../example-postman-collection.json?raw'
import { buildTree, type TreeNode } from './tree'

// ---------------------------------------------------------------------------
// Faithful port of src-tauri/src/db.rs: collect_postman_entries + postman_url_to_string
// (sort order assigned by traversal order among siblings of the same kind).
// ---------------------------------------------------------------------------

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function joinParts(parts: unknown[], sep: string): string {
  return parts.filter((p): p is string => typeof p === 'string').join(sep)
}

function postmanUrlToString(url: unknown): string {
  if (typeof url === 'string') return url
  if (isObj(url)) {
    if (typeof url.raw === 'string') return url.raw
    const host = Array.isArray(url.host) ? joinParts(url.host, '.') : ''
    const path = Array.isArray(url.path) ? joinParts(url.path, '/') : ''
    if (!host && !path) return ''
    if (host && !path) return host
    if (!host && path) return path
    return `${host.replace(/\/+$/, '')}/${path}`
  }
  return ''
}

const nonEmptyTrim = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

function simulateRustImport(json: string) {
  const root = JSON.parse(json)
  const folders: ApiFolder[] = []
  const requests: ApiRequest[] = []
  const counters = new Map<string, number>()
  const nextOrder = (kind: string, parent: string | null) => {
    const k = `${kind}:${parent}`
    const n = counters.get(k) ?? 0
    counters.set(k, n + 1)
    return n
  }
  let folderSeq = 0
  let reqSeq = 0

  function collect(items: Json[], parent: string | null) {
    for (const item of items) {
      if (Array.isArray(item.item)) {
        const id = `f${++folderSeq}`
        folders.push({
          id, workspaceId: 'w', collectionId: 'c', parentFolderId: parent,
          name: nonEmptyTrim(item.name) ?? 'Untitled Folder', sortOrder: nextOrder('f', parent), createdAt: 1, updatedAt: 1, version: 1,
        })
        collect(item.item, id)
        continue
      }
      const request = item.request
      if (request === undefined || request === null) continue
      const name = nonEmptyTrim(item.name) ?? 'Untitled Request'
      const method = (nonEmptyTrim(request.method) ?? 'GET').toUpperCase()
      const url = postmanUrlToString(request.url)
      const document = {
        name, method, url,
        description: request.description ?? null,
        headers: request.header ?? [],
        body: request.body ?? null,
        auth: request.auth ?? null,
        scripts: item.event ?? [],
        responses: item.response ?? [],
        source: item,
      }
      requests.push({
        id: `r${++reqSeq}`, workspaceId: 'w', collectionId: 'c', folderId: parent, name, method, url,
        documentJson: JSON.stringify(document), sortOrder: nextOrder('r', parent), createdAt: 1, updatedAt: 1, version: 1,
      })
    }
  }
  collect(Array.isArray(root.item) ? root.item : [], null)
  return { name: root.info?.name as string, folders, requests }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const collection: Collection = { id: 'col-1', workspaceId: 'w', name: 'My API', createdAt: 1, updatedAt: 1, version: 1 }

function fld(id: string, parent: string | null, sortOrder: number, name: string): ApiFolder {
  return { id, workspaceId: 'w', collectionId: 'col-1', parentFolderId: parent, name, sortOrder, createdAt: 1, updatedAt: 1, version: 1 }
}
function reqFromDraft(id: string, folderId: string | null, sortOrder: number, draft: RequestDraft, extraDoc: Record<string, unknown> = {}): ApiRequest {
  const s = serializeDraft(draft)
  const doc = { ...JSON.parse(s.documentJson), ...extraDoc }
  return {
    id, workspaceId: 'w', collectionId: 'col-1', folderId, name: s.name, method: s.method, url: s.url,
    documentJson: JSON.stringify(doc), sortOrder, createdAt: 1, updatedAt: 1, version: 1,
  }
}
const rows = (...r: Partial<KvRow>[]): KvRow[] => [...r.map((p) => newRow(p)), newRow()]

/** Ids and blank rows removed so drafts can be compared structurally. */
function norm(d: RequestDraft) {
  const strip = (rs: KvRow[]) =>
    rs.filter((r) => r.key || r.value || r.description || r.filePath).map(({ id: _id, ...rest }) => rest)
  const { extras: _e, ...rest } = d
  return {
    ...rest,
    params: strip(d.params),
    headers: strip(d.headers),
    body: { ...d.body, formData: strip(d.body.formData), urlEncoded: strip(d.body.urlEncoded) },
  }
}

function orderedNames(nodes: TreeNode[]): unknown[] {
  return nodes.map((n) => (n.kind === 'folder' ? { folder: n.folder.name, children: orderedNames(n.children) } : n.request.name))
}

function roundTrip(folders: ApiFolder[], requests: ApiRequest[]) {
  const json = exportPostmanCollection({ collection, folders, requests })
  return { json, imported: simulateRustImport(json) }
}

// ---------------------------------------------------------------------------
// Fixture collection covering every feature
// ---------------------------------------------------------------------------

const bigFolders = [fld('A', null, 1, 'Auth'), fld('A1', 'A', 0, 'Deep {{env}} folder'), fld('B', null, 0, 'Basics')]
const bigRequests: ApiRequest[] = [
  reqFromDraft('r-root', null, 1, newDraft({
    name: 'Root req', method: 'GET', url: '{{baseUrl}}/users/{{user.id}}?page=1&q={{term}}#top', description: 'Lists {{things}}',
    headers: rows({ key: 'X-Trace', value: '{{trace}}' }, { key: 'X-Off', value: 'v', enabled: false, description: 'disabled one' }),
    params: rows({ key: 'page', value: '1' }, { key: 'q', value: '{{term}}' }, { key: 'debug', value: '1', enabled: false, description: 'toggle' }),
  })),
  reqFromDraft('r-raw', 'B', 0, newDraft({
    name: 'Raw JSON', method: 'POST', url: 'https://api.example.com:8443/v1/items',
    body: { ...newDraft().body, kind: 'raw', raw: '{"a": "{{a}}", "n": [1,2]}', rawLanguage: 'json' },
    auth: { ...newDraft().auth, kind: 'bearer', bearer: { token: '{{token}}' } },
  }), { scripts: [{ listen: 'test', script: { exec: ['pm.test("x")'], type: 'text/javascript' } }], responses: [{ name: 'ok', code: 200 }] }),
  reqFromDraft('r-form', 'B', 1, newDraft({
    name: 'Form', method: 'PUT', url: 'http://localhost:3000/upload',
    body: {
      ...newDraft().body, kind: 'formData',
      formData: rows({ key: 'title', value: '{{title}}' }, { key: 'skip', value: 'x', enabled: false }, { key: 'file', kind: 'file', filePath: '/tmp/a.png' }),
    },
    auth: { ...newDraft().auth, kind: 'basic', basic: { username: '{{user}}', password: 'p@ss' } },
  })),
  reqFromDraft('r-url', 'A', 0, newDraft({
    name: 'Urlencoded', method: 'PATCH', url: '{{host}}/login',
    body: { ...newDraft().body, kind: 'urlEncoded', urlEncoded: rows({ key: 'u', value: '{{u}}' }, { key: 'off', value: '1', enabled: false }) },
    auth: { ...newDraft().auth, kind: 'apiKey', apiKey: { key: 'X-Key', value: '{{apikey}}', addTo: 'query' } },
  })),
  reqFromDraft('r-bin', 'A1', 0, newDraft({
    name: 'Binary', method: 'POST', url: 'https://x.io/bin', body: { ...newDraft().body, kind: 'binary', binaryPath: '/tmp/blob.bin' },
  })),
  reqFromDraft('r-last', 'A1', 1, newDraft({ name: 'Second in deep', method: 'DELETE', url: 'https://x.io/d' })),
]

describe('decomposeUrl', () => {
  it('splits a full URL', () => {
    expect(decomposeUrl('https://api.example.com:8443/v1/items?a=1&b=#frag')).toEqual({
      raw: 'https://api.example.com:8443/v1/items?a=1&b=#frag',
      protocol: 'https', host: ['api', 'example', 'com'], port: '8443', path: ['v1', 'items'],
      query: [{ key: 'a', value: '1' }, { key: 'b', value: '' }], hash: 'frag',
    })
  })
  it('does not split {{a.b}} at the dot or encode variables', () => {
    const u = decomposeUrl('{{a.b}}/x/{{p/q}}/{{c}}?k={{v w}}')
    expect(u.host).toEqual(['{{a.b}}'])
    expect(u.path).toEqual(['x', '{{p/q}}', '{{c}}'])
    expect(u.query).toEqual([{ key: 'k', value: '{{v w}}' }])
    const d = decomposeUrl('https://{{sub}}.{{base.domain}}:{{port}}/a')
    expect(d.host).toEqual(['{{sub}}', '{{base.domain}}'])
    expect(d.port).toBe('{{port}}')
  })
  it('handles relative paths, localhost and empty', () => {
    expect(decomposeUrl('/a/b')).toEqual({ raw: '/a/b', path: ['a', 'b'] })
    expect(decomposeUrl('localhost/api').host).toEqual(['localhost'])
    expect(decomposeUrl('')).toEqual({ raw: '' })
  })
})

describe('buildPostmanCollection', () => {
  it('orders folders first then requests, recursively by sortOrder', () => {
    const c = buildPostmanCollection({ collection, folders: bigFolders, requests: bigRequests })
    expect(c.info).toEqual({ _postman_id: 'col-1', name: 'My API', schema: expect.stringContaining('v2.1.0') })
    const shape = (items: typeof c.item): unknown[] => items.map((i) => (i.item ? { [i.name]: shape(i.item) } : i.name))
    expect(shape(c.item)).toEqual([
      { Basics: ['Raw JSON', 'Form'] },
      { Auth: [{ 'Deep {{env}} folder': ['Binary', 'Second in deep'] }, 'Urlencoded'] },
      'Root req',
    ])
  })
  it('writes url parts, disabled params, events and responses', () => {
    const c = buildPostmanCollection({ collection, folders: bigFolders, requests: bigRequests })
    const root = c.item[2].request!
    expect(root.url.raw).toBe('{{baseUrl}}/users/{{user.id}}?page=1&q={{term}}#top')
    expect(root.url.host).toEqual(['{{baseUrl}}'])
    expect(root.url.path).toEqual(['users', '{{user.id}}'])
    expect(root.url.hash).toBe('top')
    expect(root.url.query).toEqual([
      { key: 'page', value: '1' },
      { key: 'q', value: '{{term}}' },
      { key: 'debug', value: '1', disabled: true, description: 'toggle' },
    ])
    expect(root.header).toEqual([
      expect.objectContaining({ key: 'X-Trace', value: '{{trace}}' }),
      expect.objectContaining({ key: 'X-Off', value: 'v', disabled: true, description: 'disabled one' }),
    ])
    expect(root.description).toBe('Lists {{things}}')
    const raw = (c.item[0].item![0])
    expect(raw.event).toHaveLength(1)
    expect(raw.response).toEqual([{ name: 'ok', code: 200 }])
    expect(raw.request!.body).toMatchObject({ mode: 'raw', options: { raw: { language: 'json' } } })
    expect(raw.request!.auth).toMatchObject({ type: 'bearer' })
    expect(raw.request!.url.port).toBe('8443')
  })
  it('omits empty optional parts and keeps source url variables', () => {
    const r = reqFromDraft('x', null, 0, newDraft({ name: 'n', url: '{{h}}/:id' }), {
      source: { request: { url: { variable: [{ key: 'id', value: '5', description: 'the id' }, { key: '  ' }] } } },
    })
    const c = buildPostmanCollection({ collection, folders: [], requests: [r] })
    const req = c.item[0].request!
    expect(req).not.toHaveProperty('body')
    expect(req).not.toHaveProperty('auth')
    expect(req).not.toHaveProperty('description')
    expect(c.item[0]).not.toHaveProperty('event')
    expect(req.url.variable).toEqual([{ key: 'id', value: '5', description: 'the id' }])
    expect(req.url.path).toEqual([':id'])
  })
  it('does not lose folders in a parent cycle', () => {
    const c = buildPostmanCollection({ collection, folders: [fld('a', 'b', 0, 'a'), fld('b', 'a', 0, 'b')], requests: [] })
    const all = (items: typeof c.item): string[] => items.flatMap((i) => [i.name, ...(i.item ? all(i.item) : [])])
    expect(all(c.item).sort()).toEqual(['a', 'b'])
  })
  it('exports pretty JSON', () => {
    expect(exportPostmanCollection({ collection, folders: [], requests: [] })).toContain('\n  "info"')
  })
})

describe('Postman round trip (export -> Rust importer -> parseDocument)', () => {
  const { imported } = roundTrip(bigFolders, bigRequests)

  it('preserves folder nesting, names and order', () => {
    expect(orderedNames(buildTree(imported.folders, imported.requests))).toEqual(
      orderedNames(buildTree(bigFolders, bigRequests)),
    )
    expect(imported.name).toBe('My API')
  })

  it('preserves every request field', () => {
    const originalTree = buildTree(bigFolders, bigRequests)
    const importedTree = buildTree(imported.folders, imported.requests)
    const flat = (nodes: TreeNode[]): ApiRequest[] => nodes.flatMap((n) => (n.kind === 'folder' ? flat(n.children) : [n.request]))
    const before = flat(originalTree)
    const after = flat(importedTree)
    expect(after.map((r) => r.name)).toEqual(before.map((r) => r.name))
    for (let i = 0; i < before.length; i++) {
      expect(norm(parseDocument(after[i])), before[i].name).toEqual(norm(parseDocument(before[i])))
    }
  })

  it('keeps specific fields readable after import', () => {
    const byName = new Map(imported.requests.map((r) => [r.name, parseDocument(r)]))
    const root = byName.get('Root req')!
    expect(root.url).toBe('{{baseUrl}}/users/{{user.id}}?page=1&q={{term}}#top')
    expect(root.headers.find((h) => h.key === 'X-Off')).toMatchObject({ enabled: false, value: 'v', description: 'disabled one' })
    expect(root.params.find((p) => p.key === 'debug')).toMatchObject({ enabled: false, value: '1' })
    expect(root.description).toBe('Lists {{things}}')
    expect(byName.get('Raw JSON')!.body).toMatchObject({ kind: 'raw', rawLanguage: 'json', raw: '{"a": "{{a}}", "n": [1,2]}' })
    expect(byName.get('Raw JSON')!.auth).toMatchObject({ kind: 'bearer', bearer: { token: '{{token}}' } })
    expect(byName.get('Raw JSON')!.extras.scripts).toHaveLength(1)
    expect(byName.get('Form')!.auth).toMatchObject({ kind: 'basic', basic: { username: '{{user}}', password: 'p@ss' } })
    expect(byName.get('Form')!.body.formData.filter((r) => r.key)).toMatchObject([
      { key: 'title', value: '{{title}}', kind: 'text' },
      { key: 'skip', enabled: false },
      { key: 'file', kind: 'file', filePath: '/tmp/a.png' },
    ])
    expect(byName.get('Urlencoded')!.auth).toMatchObject({ kind: 'apiKey', apiKey: { key: 'X-Key', value: '{{apikey}}', addTo: 'query' } })
    expect(byName.get('Urlencoded')!.body.urlEncoded.filter((r) => r.key)).toMatchObject([
      { key: 'u', value: '{{u}}' },
      { key: 'off', enabled: false },
    ])
    expect(byName.get('Binary')!.body).toMatchObject({ kind: 'binary', binaryPath: '/tmp/blob.bin' })
    expect(byName.get('Second in deep')!.method).toBe('DELETE')
  })

  it('is stable: export -> import -> export yields the same items', () => {
    const first = buildPostmanCollection({ collection, folders: bigFolders, requests: bigRequests })
    const again = buildPostmanCollection({ collection, folders: imported.folders, requests: imported.requests })
    expect(again.item).toEqual(first.item)
  })
})

describe('Postman round trip with example-postman-collection.json', () => {
  const text: string = exampleCollection
  const first = simulateRustImport(text)
  const exported = roundTrip(first.folders, first.requests)

  it('imports something', () => expect(first.requests.length).toBeGreaterThan(0))

  it('re-imports to the same structure and requests', () => {
    expect(exported.imported.requests).toHaveLength(first.requests.length)
    expect(orderedNames(buildTree(exported.imported.folders, exported.imported.requests))).toEqual(
      orderedNames(buildTree(first.folders, first.requests)),
    )
    const a = buildTree(first.folders, first.requests)
    const b = buildTree(exported.imported.folders, exported.imported.requests)
    const flat = (nodes: TreeNode[]): ApiRequest[] => nodes.flatMap((n) => (n.kind === 'folder' ? flat(n.children) : [n.request]))
    const fa = flat(a)
    const fb = flat(b)
    fa.forEach((r, i) => expect(norm(parseDocument(fb[i])), r.name).toEqual(norm(parseDocument(r))))
  })

  it('matches the original Postman items structurally', () => {
    const original = JSON.parse(text)
    const out = JSON.parse(exported.json)
    expect(out.item).toHaveLength(original.item.length)
    original.item.forEach((o: Json, i: number) => {
      const e = out.item[i]
      expect(e.name).toBe(o.name)
      expect(e.request.method).toBe(o.request.method)
      expect(e.request.url.raw).toBe(o.request.url.raw)
      expect(e.request.header.map((h: Json) => [h.key, h.value])).toEqual((o.request.header ?? []).map((h: Json) => [h.key, h.value]))
      expect(e.request.body).toEqual(o.request.body)
      expect(e.request.description).toEqual(o.request.description)
      expect(e.request.url.host).toEqual(o.request.url.host)
      expect(e.request.url.path).toEqual(o.request.url.path)
    })
  })
})

describe('environments', () => {
  const vars = [
    { key: 'a', value: '1', isSecret: false },
    { key: 'token', value: null, isSecret: true },
    { key: 'leaky', value: 'oops', isSecret: true },
    { key: 'off', value: 'x', isSecret: false, enabled: false },
    { key: 'nul', value: null, isSecret: false },
  ]
  it('maps variables', () => {
    const env = buildPostmanEnvironment('Prod', vars)
    expect(env.name).toBe('Prod')
    expect(env._postman_variable_scope).toBe('environment')
    expect(env.values).toEqual([
      { key: 'a', value: '1', type: 'default', enabled: true },
      { key: 'token', value: '', type: 'secret', enabled: true },
      { key: 'leaky', value: '', type: 'secret', enabled: true },
      { key: 'off', value: 'x', type: 'default', enabled: false },
      { key: 'nul', value: '', type: 'default', enabled: true },
    ])
  })
  it('exports a string', () => {
    expect(JSON.parse(exportPostmanEnvironment('E', vars)).name).toBe('E')
  })
})
