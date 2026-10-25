import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadSpec } from '../../../shared/openapi/load'
import { jsonPath, pathCandidates } from '../../../shared/openapi/validate'
import type { OpenApiValidationInput } from '../../../shared/types'
import { responseValidator, validateResponse } from '../../openapi/validate'
import { makeEnv, type TestEnv } from '../helpers'

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8')
const SHOP_TEXT = fixture('shop-3.0.yaml')
const SHOP = loadSpec(SHOP_TEXT)
const TYPES = loadSpec(fixture('types-3.1.yaml'))
const VAL = loadSpec(fixture('validate-3.0.yaml'))
const SWAGGER = loadSpec(fixture('petstore-2.0.json'))

const ID = '00000000-0000-4000-8000-000000000000'
const input = (over: Partial<OpenApiValidationInput> & { json?: unknown }): OpenApiValidationInput => {
  const { json, ...rest } = over
  return {
    collectionId: ID,
    method: 'GET',
    url: '{{baseUrl}}/pets',
    status: 200,
    contentType: 'application/json',
    body: json !== undefined ? JSON.stringify(json) : '',
    bodyEncoding: null,
    ...rest,
  }
}
let hashN = 0
/** A fresh hash per call unless given, so cached validators of other tests do not interfere. */
const check = (spec = SHOP, over: Partial<OpenApiValidationInput> & { json?: unknown } = {}, key: string | null = null, hash = `h${++hashN}`) =>
  validateResponse(spec, hash, input(over), key)

const pet = { id: 7, name: 'Tom', kind: 'cat', tags: ['a', 'b'], createdAt: '2024-01-01T00:00:00Z' }
const item = { id: ID, price: 9.5, password: 'x' }

describe('validating responses', () => {
  it('accepts a body that matches (allOf, nullable 3.0, refs through cycles)', () => {
    const r = check(SHOP, { json: { items: [{ ...pet, owner: { name: 'Ann', pets: [pet] } }], next: null } })
    expect(r).toEqual({ status: 'valid', operation: 'GET /pets', responseKey: '200', errors: [] })
  })

  it('reports wrong types and missing required properties with paths', () => {
    const r = check(SHOP, { json: { items: [{ ...pet, id: 'seven' }, { name: 'Rex' }], next: 5 } })
    expect(r.status).toBe('invalid')
    expect(r.errors).toEqual(
      expect.arrayContaining([
        { path: '$.items[0].id', message: 'expected integer, got string' },
        { path: '$.items[1]', message: "missing required property 'id'" },
        { path: '$.next', message: 'expected string or null, got integer' },
      ]),
    )
  })

  it('3.0: nullable on enums and on refs, boolean exclusiveMinimum, OpenAPI keywords that are property names', () => {
    const ok = check(VAL, { url: 'https://api.example.com/v2/items/1', json: { ...item, kind: null, note: null, xml: 'a' } })
    expect(ok.status).toBe('valid')
    const bad = check(VAL, { url: 'https://api.example.com/v2/items/1', json: { ...item, price: 0, kind: 'c', xml: 1 } })
    expect(bad.errors).toEqual(
      expect.arrayContaining([
        { path: '$.price', message: 'expected a number > 0, got 0' },
        { path: '$.kind', message: 'expected one of "a", "b", null, got "c"' },
        { path: '$.xml', message: 'expected string, got integer' },
      ]),
    )
    const tree = check(VAL, { url: '{{baseUrl}}/tree', json: { name: 'root', parent: null, children: [{ name: 'leaf', parent: { name: 'root' }, children: [] }] } })
    expect(tree.status).toBe('valid')
    const badTree = check(VAL, { url: '{{baseUrl}}/tree', json: { name: 'root', children: [{ children: [{ name: 3 }] }] } })
    expect(badTree.errors).toEqual([
      { path: '$.children[0]', message: "missing required property 'name'" },
      { path: '$.children[0].children[0].name', message: 'expected string, got integer' },
    ])
  })

  it('writeOnly properties are not required in responses; readOnly ones are fine; unknown properties are reported', () => {
    expect(check(VAL, { url: '/v2/items/1', json: { id: ID, price: 1, secret: 's' } }).status).toBe('valid')
    expect(check(VAL, { url: '/v2/items/1', json: { ...item, extra: true } }).errors).toEqual([{ path: '$', message: "unexpected property 'extra'" }])
  })

  it('3.1: type arrays with null, $ref siblings, remote refs accept anything', () => {
    const url = 'http://localhost:4010/things/1'
    expect(check(TYPES, { url, json: { id: 'a', size: null, meta: { created: '2024-02-29' }, ref: 42 } }).status).toBe('valid')
    const r = check(TYPES, { url, json: { id: 'a', size: 'big', meta: { created: '2023-02-29' } } })
    expect(r.errors).toEqual([
      { path: '$.size', message: 'expected integer or null, got string' },
      { path: '$.meta.created', message: 'expected a date value, got "2023-02-29"' },
    ])
  })

  it('checks formats with its own rules', () => {
    const good = { ...item, created: '2024-01-01T10:20:30.5+02:00', day: '2024-12-31', at: '23:59:59Z', email: 'a@b.co', site: 'https://x.y/z', ip4: '10.0.0.1', ip6: '::1', data: 'ZXhhbXBsZQ==', count: 2147483647, big: 2 ** 40 }
    expect(check(VAL, { url: '/v2/items/1', json: good })).toMatchObject({ status: 'valid', errors: [] })
    const bad = { ...item, id: 'nope', created: '2024-01-01', day: '2024-13-01', at: '25:00:00', email: 'a@b', site: 'not a uri', ip4: '256.0.0.1', ip6: '1:::2', data: 'abc', count: 2147483648, big: 1.5 }
    const r = check(VAL, { url: '/v2/items/1', json: bad })
    expect(r.errors.map((e) => e.path).sort()).toEqual(['$.at', '$.big', '$.count', '$.created', '$.data', '$.day', '$.email', '$.id', '$.ip4', '$.ip6', '$.site'].sort())
    expect(r.errors.find((e) => e.path === '$.id')!.message).toBe('expected a uuid value, got "nope"')
  })

  it('undocumented status and content type are errors naming what is documented', () => {
    const r = check(SHOP, { url: '{{baseUrl}}/pets/1', status: 418, json: {} })
    expect(r).toEqual({ status: 'invalid', operation: 'GET /pets/{petId}', responseKey: null, errors: [{ path: '$', message: 'Status 418 is not documented for GET /pets/{petId} (documented: 200, 404)' }] })
    const ct = check(SHOP, { url: '{{baseUrl}}/pets/1', contentType: 'text/html', body: '<p>' })
    expect(ct.errors).toEqual([{ path: '$', message: 'Content type text/html is not documented for GET /pets/{petId} 200 (documented: application/json)' }])
  })

  it('falls back to 2XX / 4XX and default; matches media types with parameters, +json, type/* and */*', () => {
    expect(check(SHOP, { method: 'POST', url: '{{baseUrl}}/orders', status: 201, json: { id: ID, status: null } })).toMatchObject({ status: 'valid', responseKey: '2XX' })
    expect(check(SHOP, { url: '{{baseUrl}}/pets', status: 503, json: { code: 1 } })).toMatchObject({ status: 'invalid', responseKey: 'default', errors: [{ path: '$', message: "missing required property 'message'" }] })
    expect(check(VAL, { url: '/v2/items/1', status: 404, contentType: 'application/problem+json; charset=utf-8', json: { title: 'x' } })).toMatchObject({ status: 'valid', responseKey: '4XX' })
    expect(check(VAL, { url: '/v2/anything', status: 200, contentType: 'application/vnd.x+json', json: { ok: 1 } }).errors).toEqual([{ path: '$.ok', message: 'expected boolean, got integer' }])
    expect(check(VAL, { url: '/v2/anything', status: 200, contentType: null, json: { ok: true } }).status).toBe('valid')
  })

  it('finds the operation by key, else by path: {{baseUrl}}, the real server host, another host, literal before template', () => {
    expect(check(SHOP, { url: 'whatever', json: pet }, 'GET /pets/{petId}')).toMatchObject({ status: 'valid', operation: 'GET /pets/{petId}' })
    // A key the document no longer has: matched by the URL instead.
    expect(check(SHOP, { url: '{{baseUrl}}/pets/3', json: pet }, 'GET /gone')).toMatchObject({ operation: 'GET /pets/{petId}' })
    expect(check(SHOP, { url: 'https://us.shop.example.com/v1/pets/7?x=1', json: pet }).operation).toBe('GET /pets/{petId}')
    expect(check(SHOP, { url: 'http://localhost:4010/v1/pets/:petId', json: pet }).operation).toBe('GET /pets/{petId}')
    expect(check(SWAGGER, { url: 'https://petstore.example.com/api/pets', json: [] }).operation).toBe('GET /pets')
    expect(check(VAL, { url: 'https://api.example.com/v2/items/mine', json: [] }).operation).toBe('GET /items/mine')
    expect(check(VAL, { url: 'https://api.example.com/v2/items/other', json: item }).operation).toBe('GET /items/{id}')
    expect(check(SHOP, { method: 'PATCH', url: '{{baseUrl}}/pets' })).toEqual({ status: 'no-operation', operation: null, responseKey: null, errors: [] })
    expect(check(SHOP, { url: '{{baseUrl}}/nothing/here' }).status).toBe('no-operation')
    expect(pathCandidates(SHOP.doc, 'https://eu.shop.example.com/v1/pets')).toEqual(['/pets', '/v1/pets'])
    expect(check(VAL, { url: 'localhost:8080/v2/items/mine', json: [] }).operation).toBe('GET /items/mine')
  })

  it('no schema, not JSON, string schemas and binary bodies', () => {
    expect(check(SHOP, { method: 'DELETE', url: '{{baseUrl}}/pets/1', status: 204, contentType: null })).toMatchObject({ status: 'no-schema', responseKey: '204' })
    expect(check(SHOP, { url: '{{baseUrl}}/health', contentType: 'text/plain', body: 'ok' })).toMatchObject({ status: 'no-schema', responseKey: '200' })
    expect(check(SHOP, { url: '{{baseUrl}}/pets/1', body: '<html>' })).toMatchObject({ status: 'not-json', errors: [{ path: '$', message: expect.stringMatching(/^Expected a JSON body: the body is not valid JSON/) }] })
    expect(check(SHOP, { url: '{{baseUrl}}/pets/1', body: '' }).errors[0]!.message).toBe('Expected a JSON body: the body is empty')
    expect(check(VAL, { url: '/v2/text', contentType: 'text/plain', body: '42' }).status).toBe('valid')
    expect(check(VAL, { url: '/v2/text', contentType: 'application/xml', body: '<a/>' }).status).toBe('not-json')
    expect(check(SHOP, { method: 'PUT', url: '{{baseUrl}}/pets/1/photo', contentType: 'image/png', body: 'iVBORw0KGgo=', bodyEncoding: 'base64' }).status).toBe('valid')
    // A JSON body sent base64-encoded (not valid UTF-8 elsewhere) is decoded first.
    expect(check(SHOP, { url: '{{baseUrl}}/pets/1', body: Buffer.from(JSON.stringify(pet)).toString('base64'), bodyEncoding: 'base64' }).status).toBe('valid')
  })

  it('does not parse bodies over 5 MB', () => {
    const big = JSON.stringify({ items: Array.from({ length: 120_000 }, () => pet) })
    expect(big.length).toBeGreaterThan(5 * 1024 * 1024)
    expect(check(SHOP, { body: big })).toEqual({ status: 'not-json', operation: 'GET /pets', responseKey: '200', errors: [{ path: '$', message: 'Too large to check (over 5 MB)' }] })
  })

  it('compiles a validator once per document, operation, response and media type', () => {
    const before = responseValidator().stats().compiled
    for (let i = 0; i < 5; i++) check(SHOP, { url: '{{baseUrl}}/pets/1', json: pet }, null, 'same-hash')
    check(SHOP, { url: '{{baseUrl}}/pets/1', status: 404, json: { code: 1, message: 'x' } }, null, 'same-hash')
    expect(responseValidator().stats().compiled - before).toBe(2)
    check(SHOP, { url: '{{baseUrl}}/pets/1', json: pet }, null, 'other-hash')
    expect(responseValidator().stats().compiled - before).toBe(3)
  })

  it('caps errors at 50 and formats paths', () => {
    const r = check(SHOP, { json: { items: Array.from({ length: 80 }, () => ({ name: 1 })) } })
    expect(r.errors).toHaveLength(50)
    expect(jsonPath('/a~1b/0/c d')).toBe('$["a/b"][0]["c d"]')
  })
})

describe('validation through IPC', () => {
  let env: TestEnv
  beforeEach(() => {
    env = makeEnv()
  })
  afterEach(() => env.cleanup())

  it('checks against the linked document, using the request operation key; no-spec without a link', async () => {
    const ws = (await env.api.listWorkspaces())[0]!.id
    const r = await env.api.importOpenApi({ workspaceId: ws, text: SHOP_TEXT, source: { kind: 'text', value: null }, folders: 'tags' })
    const getPet = r.requests.find((x) => x.name === 'Get a pet')!
    const base = { collectionId: r.collection.id, method: 'GET', status: 200, contentType: 'application/json', bodyEncoding: null }
    // The URL alone would not match: the request's stored key decides.
    const ok = await env.api.validateOpenApiResponse({ ...base, requestId: getPet.id, url: 'http://127.0.0.1:9/x', body: JSON.stringify(pet) })
    expect(ok).toEqual({ status: 'valid', operation: 'GET /pets/{petId}', responseKey: '200', errors: [] })
    const bad = await env.api.validateOpenApiResponse({ ...base, url: '{{baseUrl}}/pets/7', body: JSON.stringify({ name: 2 }) })
    expect(bad.status).toBe('invalid')
    expect(bad.errors).toContainEqual({ path: '$', message: "missing required property 'id'" })
    await env.api.unlinkOpenApi(r.collection.id)
    expect(await env.api.validateOpenApiResponse({ ...base, url: '{{baseUrl}}/pets/7', body: '{}' })).toMatchObject({ status: 'no-spec' })
    const call = (m: string, ...a: unknown[]) => (env.api as unknown as Record<string, (...x: unknown[]) => Promise<unknown>>)[m]!(...a)
    await expect(call('validateOpenApiResponse', { ...base, url: 'x', body: '', extra: 1 })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(call('validateOpenApiResponse', { ...base, collectionId: 'nope', url: 'x', body: '' })).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('answers "too large" for bodies over 5 MB and rejects bodies over 20 MB', async () => {
    const ws = (await env.api.listWorkspaces())[0]!.id
    const r = await env.api.importOpenApi({ workspaceId: ws, text: SHOP_TEXT, source: { kind: 'text', value: null }, folders: 'tags' })
    const base = { collectionId: r.collection.id, method: 'GET', url: '{{baseUrl}}/pets', status: 200, contentType: 'application/json', bodyEncoding: null }
    const big = await env.api.validateOpenApiResponse({ ...base, body: ' '.repeat(6 * 1024 * 1024) })
    expect(big).toMatchObject({ status: 'not-json', errors: [{ message: 'Too large to check (over 5 MB)' }] })
    await expect(env.api.validateOpenApiResponse({ ...base, body: ' '.repeat(21 * 1024 * 1024) })).rejects.toMatchObject({ code: 'invalid_input' })
  })
})
