import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import type { ApiFolder, ApiRequest } from '../../shared/types'
import { postmanUrlToString } from '../../shared/postmanUrl'
import {
  buildOpenApiExport,
  exportOpenApi,
  openApiToJson,
  openApiToYaml,
  operationIdFromName,
  splitRequestUrl,
  type OpenApiDocument,
  type OpenApiExportInput,
  type OpenApiOperation,
} from './openapiExport'

type Json = Record<string, unknown>

const collection = { name: 'Petstore', description: 'A sample API' }

let seq = 0
function folder(name: string, parentFolderId: string | null = null, description: string | null = null): ApiFolder {
  seq++
  return {
    id: `f${seq}`, workspaceId: 'w', collectionId: 'c', parentFolderId, name, sortOrder: seq, description, descriptionType: null,
    createdAt: 0, updatedAt: 0, version: 1,
  }
}

function request(name: string, method: string, url: string, doc: Json = {}, folderId: string | null = null): ApiRequest {
  seq++
  return {
    id: `r${seq}`, workspaceId: 'w', collectionId: 'c', folderId, name, method, url, sortOrder: seq,
    documentJson: JSON.stringify({ url, method, ...doc }), createdAt: 0, updatedAt: 0, version: 1,
  }
}

/**
 * The request document the main-process Postman importer (`collect()` in electron/services/postmanImport.ts) stores for
 * an item: requests inherit the collection's auth, the item is kept as `source`, and an OpenAPI import's
 * `_slinger_openapi` becomes the document's `openapi`.
 */
function imported(item: Json, folderId: string | null, inheritedAuth: unknown = null): ApiRequest {
  const req = item.request as Json
  const { _slinger_openapi: openapi, ...source } = item
  const method = String(req.method ?? 'GET').toUpperCase()
  const url = postmanUrlToString(req.url)
  const document: Json = {
    name: item.name,
    method,
    url,
    description: req.description ?? null,
    headers: Array.isArray(req.header) ? req.header : [],
    body: req.body ?? null,
    auth: req.auth ?? inheritedAuth ?? null,
    scripts: Array.isArray(item.event) ? item.event : [],
    responses: Array.isArray(item.response) ? item.response : [],
    source,
  }
  if (openapi) document.openapi = openapi
  seq++
  return {
    id: `r${seq}`, workspaceId: 'w', collectionId: 'c', folderId, name: String(item.name), method, url, sortOrder: seq,
    documentJson: JSON.stringify(document), createdAt: 0, updatedAt: 0, version: 1,
  }
}

const json = { key: 'Content-Type', value: 'application/json' }
const example = (name: string, code: number, body: unknown, header: Json[] = [json]) => ({
  name, code, status: '', header, body: typeof body === 'string' ? body : JSON.stringify(body, null, 2),
})
const meta = (key: string, operationId: string) => ({ key, operationId, specHash: 'spec', itemHash: 'item' })

/** A Postman collection shaped like the OpenAPI import's output for the classic petstore. */
function petstore(): OpenApiExportInput {
  const pets = folder('pets', null, 'Everything about pets')
  const auth = { type: 'apikey', apikey: [{ key: 'key', value: 'X-API-Key' }, { key: 'value', value: '{{apiKey}}' }, { key: 'in', value: 'header' }] }
  const items: [Json, string | null][] = [
    [
      {
        name: 'List all pets',
        _slinger_openapi: meta('GET /pets', 'listPets'),
        request: {
          method: 'GET',
          header: [{ key: 'Accept', value: 'application/json' }],
          url: {
            raw: '{{baseUrl}}/pets',
            host: ['{{baseUrl}}'],
            path: ['pets'],
            query: [{ key: 'limit', value: '20', disabled: true, description: 'How many items to return at one time (max 100)' }],
          },
        },
        response: [
          example('200 A paged array of pets', 200, [{ id: 1, name: 'Rex', tag: 'dog' }, { id: 2, name: 'Tom' }]),
          example('default unexpected error', 500, { code: 0, message: 'string' }),
        ],
      },
      pets.id,
    ],
    [
      {
        name: 'Create a pet',
        _slinger_openapi: meta('POST /pets', 'createPets'),
        request: {
          method: 'POST',
          header: [json, { key: 'Accept', value: 'application/json' }],
          url: { raw: '{{baseUrl}}/pets', host: ['{{baseUrl}}'], path: ['pets'] },
          body: { mode: 'raw', raw: JSON.stringify({ name: 'Rex', tag: 'dog' }, null, 2), options: { raw: { language: 'json' } } },
        },
        response: [example('201 Null response', 201, '', [])],
      },
      pets.id,
    ],
    [
      {
        name: 'Info for a specific pet',
        _slinger_openapi: meta('GET /pets/{petId}', 'showPetById'),
        request: {
          method: 'GET',
          header: [{ key: 'X-Request-Id', value: 'abc', description: 'Correlation id' }, { key: 'X-Debug', value: 'true', disabled: true }],
          url: {
            raw: '{{baseUrl}}/pets/:petId',
            host: ['{{baseUrl}}'],
            path: ['pets', ':petId'],
            variable: [{ key: 'petId', value: '1', description: 'The id of the pet to retrieve' }],
          },
        },
        response: [example('200 Expected response to a valid request', 200, { id: 1, name: 'Rex' }), example('default unexpected error', 500, { code: 0, message: 'x' })],
      },
      pets.id,
    ],
  ]
  return {
    collection,
    folders: [pets],
    requests: items.map(([item, folderId]) => imported(item, folderId, auth)),
    variables: [
      { key: 'baseUrl', value: 'http://petstore.swagger.io/v1', enabled: true },
      { key: 'apiKey', value: '', enabled: true },
    ],
    latestVersion: null,
  }
}

const op = (doc: OpenApiDocument, path: string, method: string): OpenApiOperation => {
  const o = doc.paths[path]?.[method]
  if (!o) throw new Error(`no ${method} ${path} in ${Object.keys(doc.paths).join(', ')}`)
  return o
}

/** Structural checks an OpenAPI 3.1 validator would make on what the exporter writes. */
function expectOpenApiShape(doc: OpenApiDocument) {
  expect(doc.openapi).toBe('3.1.0')
  expect(typeof doc.info.title).toBe('string')
  expect(typeof doc.info.version).toBe('string')
  const ids: string[] = []
  for (const [path, item] of Object.entries(doc.paths)) {
    expect(path.startsWith('/')).toBe(true)
    for (const [method, o] of Object.entries(item)) {
      expect(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']).toContain(method)
      ids.push(o.operationId)
      expect(Object.keys(o.responses).length).toBeGreaterThan(0)
      for (const [code, r] of Object.entries(o.responses)) {
        expect(code).toMatch(/^(default|[1-5](\d\d|XX))$/)
        expect(typeof r.description).toBe('string')
      }
      // Every path template has a required path parameter and vice versa.
      const templates = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1])
      const pathParams = (o.parameters ?? []).filter((p) => p.in === 'path')
      expect(pathParams.map((p) => p.name).sort()).toEqual([...templates].sort())
      for (const p of pathParams) expect(p.required).toBe(true)
      for (const s of o.security ?? []) for (const name of Object.keys(s)) expect(doc.components?.securitySchemes).toHaveProperty(name)
    }
  }
  expect(new Set(ids).size).toBe(ids.length)
  for (const s of doc.security ?? []) for (const name of Object.keys(s)) expect(doc.components?.securitySchemes).toHaveProperty(name)
}

describe('splitRequestUrl', () => {
  const vars = new Map([
    ['baseUrl', 'https://api.example.com/v1/'],
    ['host', 'staging.example.com'],
  ])

  it('takes the server from {{baseUrl}} and turns :p / {{p}} segments into path templates', () => {
    expect(splitRequestUrl('{{baseUrl}}/users/:id/posts/{{postId}}?x=1#top', vars)).toEqual({
      server: { url: 'https://api.example.com/v1' },
      path: '/users/{id}/posts/{postId}',
      pathParams: ['id', 'postId'],
    })
    expect(splitRequestUrl('{{baseUrl}}', vars).path).toBe('/')
  })

  it('uses the scheme and host of absolute URLs, with host variables as server variables', () => {
    expect(splitRequestUrl('https://api.example.com/users', vars)).toEqual({ server: { url: 'https://api.example.com' }, path: '/users', pathParams: [] })
    expect(splitRequestUrl('https://{{host}}:{{port}}/a/report.{{format}}', vars)).toEqual({
      server: { url: 'https://{host}:{port}', variables: { host: { default: 'staging.example.com' }, port: { default: '' } } },
      path: '/a/report.{format}',
      pathParams: ['format'],
    })
    expect(splitRequestUrl('{{host}}/ping', vars).server).toEqual({ url: '{host}', variables: { host: { default: 'staging.example.com' } } })
    expect(splitRequestUrl('localhost:3000/ping').server).toEqual({ url: 'http://localhost:3000' })
    expect(splitRequestUrl('/relative/only')).toEqual({ server: null, path: '/relative/only', pathParams: [] })
  })

  it('keeps baseUrl as a server variable when the collection has no value for it', () => {
    expect(splitRequestUrl('{{baseUrl}}/x').server).toMatchObject({ url: '{baseUrl}', variables: { baseUrl: { default: '' } } })
  })
})

describe('operationIdFromName', () => {
  it('camel-cases names and falls back to method + path', () => {
    expect(operationIdFromName('List all pets', 'GET', '/pets')).toBe('listAllPets')
    expect(operationIdFromName('GET user by ID', 'GET', '/u')).toBe('getUserById')
    expect(operationIdFromName('getUserByID', 'GET', '/u')).toBe('getUserByID')
    expect(operationIdFromName('ተጠቃሚዎች', 'GET', '/pets/{petId}')).toBe('getPetsPetId')
    expect(operationIdFromName('2fa check', 'POST', '/2fa')).toBe('op2faCheck')
  })
})

describe('exportOpenApi', () => {
  it('builds info, servers, tags and security from the collection', () => {
    const doc = exportOpenApi({ ...petstore(), latestVersion: '1.4.0' })
    expectOpenApiShape(doc)
    expect(doc.info).toEqual({ title: 'Petstore', version: '1.4.0', description: 'A sample API' })
    expect(doc.servers).toEqual([{ url: 'http://petstore.swagger.io/v1' }])
    expect(doc.tags).toEqual([{ name: 'pets', description: 'Everything about pets' }])
    // Every request has the same (inherited) API key: declared once for the whole document.
    expect(doc.security).toEqual([{ apiKeyAuth: [] }])
    expect(doc.components?.securitySchemes).toEqual({ apiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' } })
    expect(op(doc, '/pets', 'get').security).toBeUndefined()
    expect(exportOpenApi({ ...petstore(), latestVersion: null }).info.version).toBe('1.0.0')
  })

  it('round-trips an OpenAPI import: operations, parameters, bodies and response codes', () => {
    const doc = exportOpenApi(petstore())
    expect(Object.keys(doc.paths)).toEqual(['/pets', '/pets/{petId}'])
    expect(Object.keys(doc.paths['/pets']!)).toEqual(['get', 'post'])

    const list = op(doc, '/pets', 'get')
    expect(list).toMatchObject({ tags: ['pets'], summary: 'List all pets', operationId: 'listPets' })
    expect(list.parameters).toEqual([
      { name: 'limit', in: 'query', required: false, description: 'How many items to return at one time (max 100)', schema: { type: 'integer' }, example: 20 },
    ])
    expect(Object.keys(list.responses)).toEqual(['200', 'default'])
    expect(list.responses['200']).toEqual({
      description: 'A paged array of pets',
      content: {
        'application/json': {
          schema: {
            type: 'array',
            items: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, tag: { type: 'string' } }, required: ['id', 'name'] },
          },
          example: [{ id: 1, name: 'Rex', tag: 'dog' }, { id: 2, name: 'Tom' }],
        },
      },
    })
    expect(list.responses.default!.description).toBe('unexpected error')

    const create = op(doc, '/pets', 'post')
    expect(create.operationId).toBe('createPets')
    expect(create.parameters).toBeUndefined()
    expect(create.requestBody).toEqual({
      required: true,
      content: {
        'application/json': {
          schema: { type: 'object', properties: { name: { type: 'string' }, tag: { type: 'string' } }, required: ['name', 'tag'] },
          example: { name: 'Rex', tag: 'dog' },
        },
      },
    })
    expect(create.responses).toEqual({ '201': { description: 'Null response' } })

    const show = op(doc, '/pets/{petId}', 'get')
    expect(show.operationId).toBe('showPetById')
    expect(show.parameters).toEqual([
      { name: 'petId', in: 'path', required: true, description: 'The id of the pet to retrieve', schema: { type: 'integer' }, example: 1 },
      // Enabled by the import = required in the spec; the disabled one was optional.
      { name: 'X-Request-Id', in: 'header', required: true, description: 'Correlation id', schema: { type: 'string' }, example: 'abc' },
      { name: 'X-Debug', in: 'header', required: false, schema: { type: 'boolean' }, example: true },
    ])
    expect(Object.keys(show.responses)).toEqual(['200', 'default'])
  })

  it('writes YAML and JSON that parse back to the same OpenAPI 3.1 document', () => {
    const doc = exportOpenApi(petstore())
    const yaml = openApiToYaml(doc)
    expect(yaml.startsWith("openapi: 3.1.0\ninfo:\n  title: Petstore\n")).toBe(true)
    expect(yaml).not.toContain('&ref')
    const back = load(yaml) as OpenApiDocument
    expect(back).toEqual(doc)
    expectOpenApiShape(back)
    const text = openApiToJson(doc)
    expect(text).toContain('\n  "info": {\n    "title": "Petstore"')
    expect(JSON.parse(text)).toEqual(doc)
  })

  it('reads hand-made requests: query rows, cookies, form bodies and saved examples', () => {
    const users = folder('Users')
    const admin = folder('Admin', users.id)
    const doc = exportOpenApi({
      collection: { name: 'Hand made' },
      folders: [users, admin],
      requests: [
        request(
          'Search users',
          'GET',
          'https://api.example.com/users?q={{term}}&tag=a&tag=b&limit=10',
          {
            params: [{ key: 'debug', value: '1', disabled: true }],
            headers: [{ key: 'Cookie', value: 'session=abc; theme=dark' }, { key: 'Authorization', value: 'Bearer x' }, { key: 'X-Trace', value: '{{trace}}' }],
            responses: [
              example('Two users', 200, [{ id: '7a1f2c3e-1111-4222-8333-444455556666', email: 'a@b.co', created: '2024-01-01T00:00:00Z' }]),
              { name: 'Plain text', code: 503, header: [{ key: 'Content-Type', value: 'text/plain; charset=utf-8' }], body: 'Try later' },
              { name: 'Nothing', code: 204, header: [], body: '' },
            ],
          },
          admin.id,
        ),
        request('Upload avatar', 'POST', 'https://api.example.com/users/:id/avatar', {
          body: { mode: 'formdata', formdata: [{ key: 'file', type: 'file', src: '/tmp/a.png', description: 'PNG image' }, { key: 'caption', value: 'me', type: 'text' }] },
        }, users.id),
        request('Login', 'POST', 'https://api.example.com/login', {
          body: { mode: 'urlencoded', urlencoded: [{ key: 'user', value: 'bob' }, { key: 'password', value: '{{password}}' }] },
          auth: { type: 'noauth' },
        }),
        request('Raw text', 'PUT', 'https://api.example.com/notes/1', { body: { mode: 'raw', raw: 'hello', options: { raw: { language: 'text' } } } }),
      ],
    })
    expectOpenApiShape(doc)
    // Nested folders are tagged with their top-level folder.
    expect(doc.tags).toEqual([{ name: 'Users' }])
    expect(doc.security).toBeUndefined()
    expect(doc.components).toBeUndefined()

    const search = op(doc, '/users', 'get')
    expect(search.tags).toEqual(['Users'])
    expect(search.operationId).toBe('searchUsers')
    expect(search.parameters).toEqual([
      { name: 'q', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'tag', in: 'query', required: false, schema: { type: 'array', items: { type: 'string' } }, example: ['a', 'b'] },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer' }, example: 10 },
      { name: 'debug', in: 'query', required: false, schema: { type: 'integer' }, example: 1 },
      { name: 'session', in: 'cookie', required: false, schema: { type: 'string' }, example: 'abc' },
      { name: 'theme', in: 'cookie', required: false, schema: { type: 'string' }, example: 'dark' },
      { name: 'X-Trace', in: 'header', required: false, schema: { type: 'string' } },
    ])
    expect(search.requestBody).toBeUndefined()
    expect(search.responses['200']!.content!['application/json']!.schema).toEqual({
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string', format: 'uuid' }, email: { type: 'string', format: 'email' }, created: { type: 'string', format: 'date-time' } },
        required: ['id', 'email', 'created'],
      },
    })
    expect(search.responses['503']).toEqual({ description: 'Plain text', content: { 'text/plain': { schema: { type: 'string' }, example: 'Try later' } } })
    expect(search.responses['204']).toEqual({ description: 'Nothing' })

    expect(op(doc, '/users/{id}/avatar', 'post').requestBody).toEqual({
      required: true,
      content: {
        'multipart/form-data': {
          schema: { type: 'object', properties: { file: { type: 'string', format: 'binary', description: 'PNG image' }, caption: { type: 'string' } } },
          example: { caption: 'me' },
        },
      },
    })
    const login = op(doc, '/login', 'post')
    expect(login.tags).toBeUndefined()
    expect(login.requestBody!.content['application/x-www-form-urlencoded']).toEqual({
      schema: { type: 'object', properties: { user: { type: 'string' }, password: { type: 'string' } } },
      example: { user: 'bob' },
    })
    // No saved examples: a default response.
    expect(login.responses).toEqual({ default: { description: 'Response' } })
    expect(op(doc, '/notes/1', 'put').requestBody!.content).toEqual({ 'text/plain': { schema: { type: 'string' }, example: 'hello' } })
  })

  it('merges requests with the same method and path', () => {
    const doc = exportOpenApi({
      collection,
      folders: [],
      requests: [
        request('Get pet', 'GET', '{{baseUrl}}/pets/:id', { responses: [example('Found', 200, { id: 1, name: 'a' })] }),
        request('Get pet (missing)', 'GET', '{{baseUrl}}/pets/{{id}}?verbose=true', {
          responses: [example('Missing', 404, { error: 'nope' }), example('Found with tag', 200, { id: 2, tag: 'x' })],
        }),
      ],
      variables: [{ key: 'baseUrl', value: 'https://p.test', enabled: true }],
    })
    expectOpenApiShape(doc)
    expect(Object.keys(doc.paths)).toEqual(['/pets/{id}'])
    const get = op(doc, '/pets/{id}', 'get')
    expect(get.summary).toBe('Get pet')
    expect(get.description).toBe('Exported from 2 requests: Get pet, Get pet (missing).')
    expect(get.parameters!.map((p) => `${p.in}:${p.name}`)).toEqual(['path:id', 'query:verbose'])
    expect(Object.keys(get.responses)).toEqual(['200', '404'])
    expect(get.responses['200']!.content!['application/json']).toEqual({
      schema: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, tag: { type: 'string' } }, required: ['id'] },
      examples: { Found: { summary: 'Found', value: { id: 1, name: 'a' } }, Found_with_tag: { summary: 'Found with tag', value: { id: 2, tag: 'x' } } },
    })
  })

  it('makes operationIds unique and lets ids from an OpenAPI import win', () => {
    const doc = exportOpenApi({
      collection,
      folders: [],
      requests: [
        request('List pets', 'GET', '/a'),
        request('List pets', 'GET', '/b'),
        request('Anything', 'GET', '/c', { openapi: meta('GET /c', 'listPets') }),
        request('Old one (deprecated)', 'GET', '/d', { openapi: meta('GET /d', '') }),
      ],
    })
    expect(op(doc, '/c', 'get').operationId).toBe('listPets')
    expect(op(doc, '/a', 'get').operationId).toBe('listPets2')
    expect(op(doc, '/b', 'get').operationId).toBe('listPets3')
    expect(op(doc, '/d', 'get')).toMatchObject({ summary: 'Old one', operationId: 'oldOne', deprecated: true })
    // Relative URLs only: no servers.
    expect(doc.servers).toBeUndefined()
  })

  it('declares each auth as a security scheme and uses it per operation when they differ', () => {
    const doc = exportOpenApi({
      collection,
      folders: [],
      requests: [
        request('Me', 'GET', 'https://a.test/me', { auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}' }] } }),
        request('Basic', 'GET', 'https://a.test/basic', { auth: { type: 'basic', basic: [{ key: 'username', value: 'u' }] } }),
        request('Query key', 'GET', 'https://a.test/q', { auth: { type: 'apikey', apikey: [{ key: 'key', value: 'api_key' }, { key: 'in', value: 'query' }] } }),
        request('Header key', 'GET', 'https://a.test/h', { auth: { type: 'apikey', apikey: [{ key: 'key', value: 'X-Key' }] } }),
        request('OAuth', 'GET', 'https://a.test/o', {
          auth: {
            type: 'oauth2',
            oauth2: [
              { key: 'grant_type', value: 'authorization_code_with_pkce' },
              { key: 'authUrl', value: '{{authBase}}/authorize' },
              { key: 'accessTokenUrl', value: 'https://id.test/token' },
              { key: 'scope', value: 'read:pets write:pets' },
              { key: 'accessToken', value: 'must-not-leak' },
            ],
          },
        }),
        request('Client', 'GET', 'https://a.test/c', { auth: { type: 'oauth2', oauth2: [{ key: 'grant_type', value: 'client_credentials' }, { key: 'accessTokenUrl', value: 'https://id.test/token' }] } }),
        request('Open', 'GET', 'https://a.test/open'),
        request('Other server', 'GET', 'https://b.test/x'),
      ],
      variables: [{ key: 'authBase', value: 'https://id.test', enabled: true }],
    })
    expectOpenApiShape(doc)
    expect(doc.security).toBeUndefined()
    expect(doc.components!.securitySchemes).toEqual({
      bearerAuth: { type: 'http', scheme: 'bearer' },
      basicAuth: { type: 'http', scheme: 'basic' },
      apiKeyAuth: { type: 'apiKey', in: 'query', name: 'api_key' },
      apiKeyAuth_2: { type: 'apiKey', in: 'header', name: 'X-Key' },
      oauth2: {
        type: 'oauth2',
        flows: { authorizationCode: { authorizationUrl: 'https://id.test/authorize', tokenUrl: 'https://id.test/token', scopes: { 'read:pets': '', 'write:pets': '' } } },
      },
      oauth2_2: { type: 'oauth2', flows: { clientCredentials: { tokenUrl: 'https://id.test/token', scopes: {} } } },
    })
    expect(op(doc, '/me', 'get').security).toEqual([{ bearerAuth: [] }])
    expect(op(doc, '/o', 'get').security).toEqual([{ oauth2: ['read:pets', 'write:pets'] }])
    expect(op(doc, '/h', 'get').security).toEqual([{ apiKeyAuth_2: [] }])
    expect(op(doc, '/open', 'get').security).toBeUndefined()
    expect(openApiToYaml(doc)).not.toContain('must-not-leak')
    // The most used origin is the document's server; others are named on their operation.
    expect(doc.servers).toEqual([{ url: 'https://a.test' }])
    expect(op(doc, '/x', 'get').servers).toEqual([{ url: 'https://b.test' }])
    expect(op(doc, '/me', 'get').servers).toBeUndefined()
  })

  it('leaves out MCP requests and methods OpenAPI has no field for', () => {
    const result = buildOpenApiExport({
      collection,
      folders: [],
      requests: [
        request('Tools', 'MCP', 'https://mcp.test/mcp', { method: 'MCP', mcp: { transport: 'http', operation: 'tools/call' } }),
        request('Dav', 'PROPFIND', 'https://a.test/dav'),
        request('Ping', 'HEAD', 'https://a.test/ping'),
      ],
    })
    expect(result.skippedMcp).toBe(1)
    expect(result.skippedMethods).toBe(1)
    expect(Object.keys(result.document.paths)).toEqual(['/ping'])
    expect(Object.keys(result.document.paths['/ping']!)).toEqual(['head'])
  })

  it('infers a JSON body with unquoted {{variables}} without an example', () => {
    const doc = exportOpenApi({
      collection,
      folders: [],
      requests: [request('Update', 'PATCH', '/items/1', { body: { mode: 'raw', raw: '{"count": {{count}}, "name": "{{name}}"}', options: { raw: { language: 'json' } } } })],
    })
    expect(op(doc, '/items/1', 'patch').requestBody!.content['application/json']).toEqual({
      schema: { type: 'object', properties: { count: {}, name: { type: 'string' } }, required: ['count', 'name'] },
    })
  })
})
