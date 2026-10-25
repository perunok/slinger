import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fingerprintDocument } from '../../../shared/openapi/fingerprint'
import { isObj, loadSpec, type Json } from '../../../shared/openapi/load'
import { sampleFromSchema } from '../../../shared/openapi/sample'
import { openApiToPostman } from '../../../shared/openapi/toCollection'
import { makeEnv, type TestEnv } from '../helpers'

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8')
const SHOP = fixture('shop-3.0.yaml')
const SWAGGER = fixture('petstore-2.0.json')
const TYPES = fixture('types-3.1.yaml')

/** All request items of a Postman collection, with the folder they are in. */
function items(collection: Json): Array<{ folder: string | null; item: Json }> {
  const out: Array<{ folder: string | null; item: Json }> = []
  const walk = (list: unknown, folder: string | null) => {
    for (const it of Array.isArray(list) ? list : []) {
      if (!isObj(it)) continue
      if (Array.isArray(it.item)) walk(it.item, String(it.name))
      else out.push({ folder, item: it })
    }
  }
  walk(collection.item, null)
  return out
}
const req = (i: Json) => i.request as Json
const url = (i: Json) => req(i).url as Json

describe('loading documents', () => {
  it('reads OpenAPI 3.0 YAML with operations, merged path parameters and resolved refs', () => {
    const spec = loadSpec(SHOP)
    expect(spec.version).toBe('3.0')
    expect(spec.title).toBe('Shop API')
    expect(spec.operations.map((o) => o.key)).toEqual(['GET /pets', 'POST /pets', 'GET /pets/{petId}', 'DELETE /pets/{petId}', 'PUT /pets/{petId}/photo', 'POST /orders', 'GET /health'])
    const getPet = spec.operations.find((o) => o.key === 'GET /pets/{petId}')!
    expect(getPet.parameters).toMatchObject([{ name: 'petId', in: 'path', required: true, example: 7 }])
    expect(getPet.responses.map((r) => r.key)).toEqual(['200', '404'])
    expect(getPet.responses[1]!.description).toBe('Error')
    expect(spec.warnings).toEqual([])
  })

  it('converts Swagger 2.0: servers, body and formData parameters, shared parameters, security', () => {
    const spec = loadSpec(SWAGGER)
    expect(spec.version).toBe('2.0')
    expect(spec.doc.servers).toEqual([{ url: 'https://petstore.example.com/api' }])
    const find = spec.operations.find((o) => o.operationId === 'findPets')!
    expect(find.parameters.map((p) => `${p.in}:${p.name}`)).toEqual(['query:limit', 'query:tags'])
    expect(find.parameters[1]!.explode).toBe(true)
    expect(find.responses[0]!.content[0]).toMatchObject({ type: 'application/json', examples: [{ value: [{ id: 1, name: 'Kitty' }] }] })
    const add = spec.operations.find((o) => o.operationId === 'addPet')!
    expect(add.requestBody).toMatchObject({ required: true, content: [{ type: 'application/json', schema: { $ref: '#/components/schemas/Pet' } }] })
    const upload = spec.operations.find((o) => o.operationId === 'upload')!
    expect(upload.requestBody!.content[0]!.type).toBe('multipart/form-data')
    expect((upload.requestBody!.content[0]!.schema as Json).properties).toMatchObject({ file: { type: 'string', format: 'binary' } })
    expect(upload.security).toEqual([{ basic: [] }])
  })

  it('reads 3.1 (type arrays, $ref siblings) and reports what it skips', () => {
    const spec = loadSpec(TYPES)
    expect(spec.version).toBe('3.1')
    expect(spec.warnings.some((w) => w.includes('other.yaml'))).toBe(true)
    expect(spec.warnings).toContain('Webhooks are not imported.')
  })

  it('rejects what is not a document, with a reason', () => {
    expect(() => loadSpec('')).toThrow(/empty/)
    expect(() => loadSpec('{"info":{}}')).toThrow(/no "openapi" or "swagger"/)
    expect(() => loadSpec('openapi: 4.0.0\npaths: {}')).toThrow(/4.0.0 is not supported/)
    expect(() => loadSpec('openapi: 3.0.0\ninfo: {title: x}\npaths: {}')).toThrow(/no paths/)
    expect(() => loadSpec('a: [unclosed')).toThrow(/Not valid YAML.*\(line \d+, column \d+\)/)
    expect(() => loadSpec('{"openapi": ')).toThrow(/Not valid JSON/)
    // YAML custom tags are never executed (JSON schema only).
    expect(() => loadSpec('openapi: 3.0.0\npaths:\n  /x: !!js/function "function(){}"')).toThrow(/Not valid YAML/)
  })
})

describe('samples', () => {
  const spec = loadSpec(SHOP)
  const schema = (name: string) => ({ $ref: `#/components/schemas/${name}` })

  it('uses examples first, merges allOf, stops at cycles, honours readOnly/writeOnly and formats', () => {
    const pet = sampleFromSchema(schema('Pet'), spec.doc, { direction: 'response' }) as Json
    expect(pet).toMatchObject({ name: 'string', kind: 'cat', id: 7, createdAt: '2024-01-01T00:00:00Z', tags: ['string', 'string'] })
    expect(isObj(pet.owner)).toBe(true) // the cycle Pet -> Owner -> Pet stops instead of recursing
    const newPet = sampleFromSchema(schema('NewPet'), spec.doc, { direction: 'request' }) as Json
    expect(newPet).toEqual({ name: 'string', kind: 'cat' }) // id is readOnly
    const order = sampleFromSchema(schema('Order'), spec.doc, { direction: 'response' }) as Json
    expect(order).toEqual({ id: '00000000-0000-4000-8000-000000000000', status: 'placed' })
  })

  it('is deterministic', () => {
    expect(JSON.stringify(sampleFromSchema(schema('Pet'), spec.doc, { direction: 'response' }))).toBe(JSON.stringify(sampleFromSchema(schema('Pet'), spec.doc, { direction: 'response' })))
  })
})

describe('conversion to a collection', () => {
  const { collection, warnings } = openApiToPostman(loadSpec(SHOP), { folders: 'tags', specText: SHOP })
  const all = items(collection)
  const byKey = (key: string) => all.find((x) => (x.item._slinger_openapi as Json).key === key)!

  it('folders by tag in the document order, untagged at the root; variables for servers and auth', () => {
    expect((collection.item as Json[]).map((i) => i.name)).toEqual(['pets', 'orders', 'Health check'])
    expect((collection.item as Json[])[0]!.description).toBe('Everything about pets')
    expect(collection.variable).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'baseUrl', value: 'https://eu.shop.example.com/v1' }),
        expect.objectContaining({ key: 'region', value: 'eu' }),
        expect.objectContaining({ key: 'bearerToken', value: '' }),
        expect.objectContaining({ key: 'apiKey', value: '' }),
      ]),
    )
    expect(warnings).toEqual([])
  })

  it('requests: names, URLs with path variables, query and header parameters', () => {
    const list = byKey('GET /pets').item
    expect(list.name).toBe('List pets')
    expect(url(list).raw).toBe('{{baseUrl}}/pets?status=available')
    expect(url(list).query).toEqual([
      { key: 'limit', value: '20', disabled: true },
      { key: 'status', value: 'available' },
    ])
    expect(req(list).header).toEqual([
      { key: 'Accept', value: 'application/json' },
      { key: 'X-Request-Id', value: '00000000-0000-4000-8000-000000000000', disabled: true },
    ])
    const get = byKey('GET /pets/{petId}').item
    expect(url(get).raw).toBe('{{baseUrl}}/pets/:petId')
    expect(url(get).variable).toEqual([{ key: 'petId', value: '7' }])
    const del = byKey('DELETE /pets/{petId}').item
    expect(del.name).toBe('deletePet (deprecated)')
  })

  it('bodies: JSON from the first named example, multipart with a file field, url-encoded form', () => {
    const create = byKey('POST /pets').item
    expect(req(create).body).toMatchObject({ mode: 'raw', raw: JSON.stringify({ name: 'Tom', kind: 'cat' }, null, 2), options: { raw: { language: 'json' } } })
    expect(req(create).header).toContainEqual({ key: 'Content-Type', value: 'application/json' })
    const photo = byKey('PUT /pets/{petId}/photo').item
    expect(req(photo).body).toEqual({ mode: 'formdata', formdata: [{ key: 'file', type: 'file', src: [] }, { key: 'caption', type: 'text', value: 'string', disabled: true }] })
    expect((req(photo).header as Json[]).some((h) => h.key === 'Content-Type')).toBe(false)
    const order = byKey('POST /orders').item
    expect(req(order).body).toEqual({ mode: 'urlencoded', urlencoded: [{ key: 'petId', value: '0' }, { key: 'note', value: 'leave at the door', disabled: true }] })
  })

  it('auth: shared bearer is not set per request; other schemes per request; security: [] is noauth', () => {
    expect(collection.auth).toBeUndefined() // not every operation uses bearer (orders: apiKey, health: none)
    expect(req(byKey('GET /pets').item).auth).toEqual({ type: 'bearer', bearer: [{ key: 'token', value: '{{bearerToken}}', type: 'string' }] })
    expect(req(byKey('POST /orders').item).auth).toEqual({
      type: 'apikey',
      apikey: [
        { key: 'key', value: 'X-API-Key', type: 'string' },
        { key: 'value', value: '{{apiKey}}', type: 'string' },
        { key: 'in', value: 'header', type: 'string' },
      ],
    })
    expect(req(byKey('GET /health').item).auth).toEqual({ type: 'noauth' })
  })

  it('examples: one per response (several for named examples), generated ones marked', () => {
    const list = byKey('GET /pets').item
    const ex = list.response as Json[]
    expect(ex.map((e) => [e.name, e.code])).toEqual([['200 A page of pets', 200], ['default Error', 500]])
    expect(ex[0]!.header).toEqual([{ key: 'Content-Type', value: 'application/json' }, { key: 'X-Total', value: '42' }])
    expect(JSON.parse(String(ex[0]!.body)).items).toHaveLength(1)
    expect(ex.every((e) => e._slinger_openapi === true)).toBe(true)
    const create = byKey('POST /pets').item
    expect((create.response as Json[]).map((e) => e.name)).toEqual(['201 Created', '422 Error'])
    expect(((byKey('POST /orders').item.response as Json[])[0]!).code).toBe(200)
    expect(((byKey('DELETE /pets/{petId}').item.response as Json[])[0]!)).toMatchObject({ code: 204, body: '' })
    expect(((byKey('PUT /pets/{petId}/photo').item.response as Json[])[0]!)).toMatchObject({ body: '', header: [{ key: 'Content-Type', value: 'image/png' }] })
    expect(((byKey('GET /health').item.response as Json[])[0]!)).toMatchObject({ body: 'ok' })
  })

  it('every request carries its key, operationId and the hash of what was generated', () => {
    const meta = byKey('GET /pets/{petId}').item._slinger_openapi as Json
    expect(meta).toMatchObject({ key: 'GET /pets/{petId}', operationId: 'getPet' })
    expect(String(meta.itemHash)).toMatch(/^[0-9a-f]{32}$/)
    const again = openApiToPostman(loadSpec(SHOP), { folders: 'tags', specText: SHOP })
    expect(JSON.stringify(again.collection)).toBe(JSON.stringify(collection)) // stable
  })

  it('folders by path or none', () => {
    const byPath = openApiToPostman(loadSpec(SHOP), { folders: 'paths', specText: SHOP }).collection
    expect((byPath.item as Json[]).map((i) => i.name)).toEqual(['pets', 'orders', 'health'])
    const flat = openApiToPostman(loadSpec(SHOP), { folders: 'none', specText: SHOP }).collection
    expect((flat.item as Json[]).every((i) => !Array.isArray(i.item))).toBe(true)
  })

  it('Swagger 2.0: OAuth 2.0 authorization code as the collection auth, multi query arrays, basic per request', () => {
    const sw = openApiToPostman(loadSpec(SWAGGER), { folders: 'tags', specText: SWAGGER }).collection
    const list = items(sw)
    const find = list.find((x) => (x.item._slinger_openapi as Json).operationId === 'findPets')!.item
    expect(url(find).query).toEqual([{ key: 'limit', value: '10', disabled: true }, { key: 'tags', value: 'string', disabled: true }])
    const upload = list.find((x) => (x.item._slinger_openapi as Json).operationId === 'upload')!.item
    expect((req(upload).auth as Json).type).toBe('basic')
    const add = list.find((x) => (x.item._slinger_openapi as Json).operationId === 'addPet')!.item
    expect(req(add).auth).toMatchObject({ type: 'oauth2' })
    expect((req(add).auth as Json).oauth2).toEqual(
      expect.arrayContaining([
        { key: 'grant_type', value: 'authorization_code_with_pkce', type: 'string' },
        { key: 'authUrl', value: 'https://auth.example.com/authorize', type: 'string' },
        { key: 'accessTokenUrl', value: 'https://auth.example.com/token', type: 'string' },
        { key: 'scope', value: 'read', type: 'string' },
      ]),
    )
  })

  it('3.1: a remote $ref is reported and left out of samples, siblings of $ref are kept', () => {
    const { collection: c, warnings: w } = openApiToPostman(loadSpec(TYPES), { folders: 'tags', specText: TYPES })
    expect(w.some((x) => x.includes('other.yaml'))).toBe(true)
    const body = JSON.parse(String(((items(c)[0]!.item.response as Json[])[0]!).body)) as Json
    expect(body).toEqual({ id: 'string', size: 0, meta: { created: '2024-01-01' } })
  })
})

describe('import through IPC', () => {
  let env: TestEnv
  beforeEach(() => {
    env = makeEnv()
  })
  afterEach(() => env.cleanup())

  it('previews, imports into folders, links the collection and keeps the operation in each request document', async () => {
    const ws = (await env.api.listWorkspaces())[0]!.id
    const preview = await env.api.previewOpenApi({ text: SHOP })
    expect(preview).toMatchObject({ title: 'Shop API', specVersion: '1.4.0', oasVersion: '3.0', operationCount: 7, untaggedCount: 1, securitySchemes: ['bearerAuth', 'apiKey'] })
    expect(preview.tags).toEqual([{ name: 'pets', count: 5 }, { name: 'orders', count: 1 }])
    const result = await env.api.importOpenApi({ workspaceId: ws, text: preview.text, source: { kind: 'text', value: null }, folders: 'tags' })
    expect(result.collection.name).toBe('Shop API')
    expect(result.folders.map((f) => f.name)).toEqual(['pets', 'orders'])
    expect(result.requests).toHaveLength(7)
    expect(result.openapi).toMatchObject({ collectionId: result.collection.id, title: 'Shop API', specVersion: '1.4.0', oasVersion: '3.0', operationCount: 7, sourceKind: 'text' })
    const getPet = result.requests.find((r) => r.name === 'Get a pet')!
    const doc = JSON.parse(getPet.documentJson) as Json
    expect(doc.openapi).toMatchObject({ key: 'GET /pets/{petId}', operationId: 'getPet' })
    expect(doc.source).not.toHaveProperty('_slinger_openapi')
    // The stored document fingerprints to the generated hash: "unchanged since import".
    expect(fingerprintDocument(doc, getPet.method, getPet.url)).toBe((doc.openapi as Json).itemHash)
    expect(await env.api.getOpenApiLink(result.collection.id)).toEqual(result.openapi)
    const vars = await env.api.listCollectionVariables(result.collection.id)
    expect(vars.find((v) => v.key === 'baseUrl')?.value).toBe('https://eu.shop.example.com/v1')
    await env.api.unlinkOpenApi(result.collection.id)
    expect(await env.api.getOpenApiLink(result.collection.id)).toBeNull()
  })

  it('imports a copy under another name and validates its input', async () => {
    const ws = (await env.api.listWorkspaces())[0]!.id
    const r = await env.api.importOpenApi({ workspaceId: ws, text: SWAGGER, source: { kind: 'file', value: 'petstore.json' }, folders: 'none', name: 'Pets (2)' })
    expect(r.collection.name).toBe('Pets (2)')
    expect(r.openapi).toMatchObject({ sourceKind: 'file', source: 'petstore.json', folders: 'none' })
    const call = (m: string, ...a: unknown[]) => (env.api as unknown as Record<string, (...x: unknown[]) => Promise<unknown>>)[m]!(...a)
    await expect(call('importOpenApi', { workspaceId: ws, text: SHOP, source: { kind: 'ftp', value: null }, folders: 'tags' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(call('previewOpenApi', { url: 'file:///etc/passwd' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(call('previewOpenApi', {})).rejects.toMatchObject({ code: 'invalid_input' })
  })
})

describe('documents by URL (fetched by main)', () => {
  let env: TestEnv
  let server: import('node:http').Server
  let base: string
  beforeEach(async () => {
    env = makeEnv()
    const { createServer } = await import('node:http')
    server = createServer((req, res) => {
      if (req.url === '/openapi.yaml') {
        res.writeHead(200, { 'Content-Type': 'application/yaml' })
        res.end(SHOP)
      } else if (req.url === '/moved') {
        res.writeHead(302, { Location: '/openapi.yaml' })
        res.end()
      } else {
        res.writeHead(404)
        res.end('nope')
      }
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
  })
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()))
    env.cleanup()
  })

  it('previews a URL (following redirects) and reports HTTP errors', async () => {
    const p = await env.api.previewOpenApi({ url: `${base}/moved` })
    expect(p).toMatchObject({ title: 'Shop API', operationCount: 7 })
    expect(p.text).toBe(SHOP)
    await expect(env.api.previewOpenApi({ url: `${base}/missing` })).rejects.toMatchObject({ code: 'io_error', message: expect.stringContaining('404') })
  })
})
