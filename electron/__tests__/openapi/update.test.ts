import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiRequest, OpenApiUpdatePlan } from '../../../shared/types'
import { fingerprintDocument } from '../../../shared/openapi/fingerprint'
import { isObj, type Json } from '../../../shared/openapi/load'
import { pathTemplate } from '../../../shared/openapi/update'
import { clearPlans, PLAN_TTL_MS } from '../../openapi/update'
import { makeEnv, type TestEnv } from '../helpers'

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8')
const V1 = fixture('shop-3.0.yaml')
const V2 = fixture('shop-3.0-v2.yaml')
const TEXT = { kind: 'text', value: null } as const

const doc = (r: ApiRequest) => JSON.parse(r.documentJson) as Json
const byName = (list: ApiRequest[], name: string) => list.find((r) => r.name === name)!
const change = (plan: OpenApiUpdatePlan, key: string) => plan.changes.find((c) => c.key === key)!

describe('updating a collection from its OpenAPI document', () => {
  let env: TestEnv
  let ws: string
  beforeEach(async () => {
    env = makeEnv()
    clearPlans()
    ws = (await env.api.listWorkspaces())[0]!.id
  })
  afterEach(() => {
    vi.restoreAllMocks()
    env.cleanup()
  })

  async function imported() {
    const r = await env.api.importOpenApi({ workspaceId: ws, text: V1, source: TEXT, folders: 'tags' })
    return { id: r.collection.id, requests: r.requests }
  }
  /** Saves a request the way the editor does (new document, version bump). */
  async function edit(r: ApiRequest, change: (d: Json) => void, name = r.name) {
    const d = doc(r)
    change(d)
    return env.api.updateRequest({ requestId: r.id, expectedVersion: r.version, name, method: String(d.method ?? r.method), url: String(d.url ?? r.url), documentJson: JSON.stringify(d) })
  }

  it('plans added, removed, changed (URL, examples only) and unchanged operations, with collection notes', async () => {
    const c = await imported()
    const plan = await env.api.planOpenApiUpdate({ collectionId: c.id, text: V2, source: TEXT })
    expect(plan).toMatchObject({ collectionId: c.id, title: 'Shop API', specVersion: '1.5.0', previousSpecVersion: '1.4.0', text: V2 })
    const kinds = Object.fromEntries(plan.changes.map((ch) => [ch.key, [ch.kind, ch.editedHere, ch.defaultChoice]]))
    expect(kinds).toEqual({
      'GET /pets': ['changed', false, 'apply'],
      'POST /pets': ['unchanged', false, 'keep'],
      'GET /pets/{petId}': ['unchanged', false, 'keep'],
      'PUT /pets/{petId}/photo': ['unchanged', false, 'keep'],
      'POST /orders': ['unchanged', false, 'keep'],
      'GET /health': ['changed', false, 'apply'],
      'PATCH /stock': ['added', false, 'apply'],
      'DELETE /pets/{petId}': ['removed', false, 'keep'],
    })
    expect(change(plan, 'GET /pets').summary).toBe('URL')
    expect(change(plan, 'GET /health').summary).toBe('Examples')
    expect(change(plan, 'PATCH /stock')).toMatchObject({ name: 'Adjust stock', folder: 'stock', requestId: null })
    expect(change(plan, 'DELETE /pets/{petId}').requestId).toBe(byName(c.requests, 'deletePet (deprecated)').id)
    expect(plan.notes).toEqual([
      'Server URL: https://eu.shop.example.com/v1 -> https://eu.shop.example.com/v2',
      'New folder: stock',
      'New variables: username, password',
    ])
  })

  it('applies the defaults after a safety version: adds into a new folder, updates clean requests in place, keeps removed ones', async () => {
    const c = await imported()
    const before = await env.api.listRequests(c.id)
    const plan = await env.api.planOpenApiUpdate({ collectionId: c.id, text: V2, source: TEXT })
    const result = await env.api.applyOpenApiUpdate({ collectionId: c.id, planId: plan.planId, choices: {} })
    expect(result).toMatchObject({ added: 1, updated: 2, deleted: 0, kept: 1, link: { specVersion: '1.5.0', operationCount: 7 } })
    expect(result.safetyVersion).toMatchObject({ version: '0.0.1', notes: 'Automatic snapshot before updating from the OpenAPI document', requestCount: 7 })

    const folders = await env.api.listFolders(c.id)
    expect(folders.map((f) => f.name)).toEqual(['pets', 'orders', 'stock'])
    const after = await env.api.listRequests(c.id)
    expect(after).toHaveLength(8)
    const stock = byName(after, 'Adjust stock')
    expect(stock.folderId).toBe(folders[2]!.id)
    expect(doc(stock).openapi).toMatchObject({ key: 'PATCH /stock' })
    expect(doc(stock).auth).toMatchObject({ type: 'basic' })

    const list = byName(after, 'List pets')
    const old = byName(before, 'List pets')
    expect(list.id).toBe(old.id)
    expect(list.version).toBe(old.version + 1)
    expect(list.url).toBe('{{baseUrl}}/pets?status=available&page=1')
    // An updated clean request fingerprints to its new hash: unchanged since this update.
    expect(fingerprintDocument(doc(list), list.method, list.url)).toBe((doc(list).openapi as Json).itemHash)
    const health = byName(after, 'Health check')
    expect((doc(health).responses as Json[])[0]).toMatchObject({ body: 'healthy', _slinger_openapi: true })
    expect(byName(after, 'deletePet (deprecated)')).toBeTruthy()

    const vars = await env.api.listCollectionVariables(c.id)
    expect(vars.find((v) => v.key === 'baseUrl')?.value).toBe('https://eu.shop.example.com/v2')
    expect(vars.filter((v) => ['username', 'password'].includes(v.key))).toHaveLength(2)
    expect(await env.api.getOpenApiLink(c.id)).toEqual(result.link)

    // The same document again: nothing left to do (the removed operation stays listed).
    const again = await env.api.planOpenApiUpdate({ collectionId: c.id, text: V2, source: TEXT })
    expect(again.changes.filter((ch) => ch.kind !== 'unchanged').map((ch) => ch.key)).toEqual(['DELETE /pets/{petId}'])
    expect(again.notes).toEqual([])

    // The safety version restores the collection as it was.
    await env.api.restoreCollectionVersion(result.safetyVersion!.id, 'replace')
    const restored = await env.api.listRequests(c.id)
    expect(restored.map((r) => r.name).sort()).toEqual(before.map((r) => r.name).sort())
    expect(byName(restored, 'List pets').url).toBe('{{baseUrl}}/pets?status=available')
  })

  it('a request edited here is "changed here and in the spec": kept by default; taking the spec keeps the user\'s additions', async () => {
    const c = await imported()
    const list = byName(c.requests, 'List pets')
    await edit(list, (d) => {
      ;(d.headers as Json[]).push({ key: 'X-Mine', value: '1', type: 'text' })
      ;(d.responses as Json[]).push({ name: 'My example', code: 200, body: '{"mine":true}' })
      d.scripts = [{ listen: 'test', script: { exec: ['pm.test("ok", () => {})'] } }]
      d.params = [{ key: 'status', value: 'available', type: 'text' }, { key: 'mine', value: 'x', type: 'text', disabled: true }]
    }, 'My pets')
    const plan = await env.api.planOpenApiUpdate({ collectionId: c.id, text: V2, source: TEXT })
    expect(change(plan, 'GET /pets')).toMatchObject({ kind: 'changed', editedHere: true, defaultChoice: 'keep', name: 'My pets' })

    // Default: kept, nothing written to it.
    const kept = await env.api.applyOpenApiUpdate({ collectionId: c.id, planId: plan.planId, choices: {} })
    expect(kept.kept).toBe(2)
    const unchanged = byName(await env.api.listRequests(c.id), 'My pets')
    expect(unchanged.url).toBe('{{baseUrl}}/pets?status=available')

    const plan2 = await env.api.planOpenApiUpdate({ collectionId: c.id, text: V2, source: TEXT })
    expect(change(plan2, 'GET /pets').editedHere).toBe(true)
    const r = await env.api.applyOpenApiUpdate({ collectionId: c.id, planId: plan2.planId, choices: { 'GET /pets': 'apply' } })
    expect(r.updated).toBe(1)
    const taken = (await env.api.listRequests(c.id)).find((x) => x.id === list.id)!
    const d = doc(taken)
    expect(taken.name).toBe('My pets') // renamed here: the user's name stays
    expect(taken.url).toBe('{{baseUrl}}/pets?status=available&page=1')
    expect((d.headers as Json[]).map((h) => h.key)).toEqual(['Accept', 'X-Request-Id', 'X-Mine'])
    expect((d.params as Json[]).map((p) => [p.key, p.disabled === true])).toEqual([['limit', true], ['status', false], ['page', false], ['mine', true]])
    expect(d.scripts).toEqual([{ listen: 'test', script: { exec: ['pm.test("ok", () => {})'] } }])
    const names = (d.responses as Json[]).map((e) => e.name)
    expect(names).toContain('My example')
    expect(names.filter((n) => n !== 'My example').length).toBeGreaterThan(0)
    expect((d.openapi as Json).itemHash).not.toBe((doc(list).openapi as Json).itemHash)
  })

  it('takes the new name when the request kept the generated one, and keeps auth the user changed', async () => {
    const c = await imported()
    const health = byName(c.requests, 'Health check')
    await edit(health, (d) => {
      d.auth = { type: 'bearer', bearer: [{ key: 'token', value: '{{myToken}}', type: 'string' }] }
    })
    const plan = await env.api.planOpenApiUpdate({ collectionId: c.id, text: V2, source: TEXT })
    expect(change(plan, 'GET /health')).toMatchObject({ kind: 'changed', editedHere: true, summary: 'Examples' })
    await env.api.applyOpenApiUpdate({ collectionId: c.id, planId: plan.planId, choices: { 'GET /health': 'apply' } })
    const d = doc((await env.api.listRequests(c.id)).find((x) => x.id === health.id)!)
    expect(d.auth).toMatchObject({ type: 'bearer', bearer: [{ key: 'token', value: '{{myToken}}' }] })
    expect((d.responses as Json[])[0]).toMatchObject({ body: 'healthy' })
  })

  it('a clean request with an example and a script added by the user is still updated, keeping both', async () => {
    const c = await imported()
    const health = byName(c.requests, 'Health check')
    await edit(health, (d) => {
      ;(d.responses as Json[]).push({ name: 'Down', code: 503, body: 'down' })
      d.scripts = [{ listen: 'prerequest', script: { exec: ['1'] } }]
    })
    const plan = await env.api.planOpenApiUpdate({ collectionId: c.id, text: V2, source: TEXT })
    expect(change(plan, 'GET /health')).toMatchObject({ kind: 'changed', editedHere: false, defaultChoice: 'apply' })
    await env.api.applyOpenApiUpdate({ collectionId: c.id, planId: plan.planId, choices: {} })
    const d = doc((await env.api.listRequests(c.id)).find((x) => x.id === health.id)!)
    expect((d.responses as Json[]).map((e) => [e.name, e.body])).toEqual([['200 OK', 'healthy'], ['Down', 'down']])
    expect(d.scripts).toEqual([{ listen: 'prerequest', script: { exec: ['1'] } }])
  })

  it('deletes a removed operation\'s request when asked', async () => {
    const c = await imported()
    const del = byName(c.requests, 'deletePet (deprecated)')
    const plan = await env.api.planOpenApiUpdate({ collectionId: c.id, text: V2, source: TEXT })
    const r = await env.api.applyOpenApiUpdate({ collectionId: c.id, planId: plan.planId, choices: { 'DELETE /pets/{petId}': 'delete', 'PATCH /stock': 'skip' } })
    expect(r).toMatchObject({ added: 0, deleted: 1, updated: 2, kept: 1 })
    const after = await env.api.listRequests(c.id)
    expect(after.some((x) => x.id === del.id)).toBe(false)
    expect((await env.api.listFolders(c.id)).map((f) => f.name)).toEqual(['pets', 'orders'])
  })

  it('refuses stale, expired, unknown and impossible plans; nothing is written', async () => {
    const c = await imported()
    const plan = await env.api.planOpenApiUpdate({ collectionId: c.id, text: V2, source: TEXT })
    await env.api.renameRequest(byName(c.requests, 'Get a pet').id, 'Renamed')
    await expect(env.api.applyOpenApiUpdate({ collectionId: c.id, planId: plan.planId, choices: {} }))
      .rejects.toMatchObject({ code: 'invalid_input', message: 'The collection changed; review the update again' })
    expect(await env.api.listCollectionVersions(c.id)).toEqual([])

    const bad = await env.api.planOpenApiUpdate({ collectionId: c.id, text: V2, source: TEXT })
    await expect(env.api.applyOpenApiUpdate({ collectionId: c.id, planId: bad.planId, choices: { 'PATCH /stock': 'delete' } }))
      .rejects.toMatchObject({ code: 'invalid_input', message: expect.stringContaining('PATCH /stock') })

    const fresh = await env.api.planOpenApiUpdate({ collectionId: c.id, text: V2, source: TEXT })
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + PLAN_TTL_MS + 1)
    await expect(env.api.applyOpenApiUpdate({ collectionId: c.id, planId: fresh.planId, choices: {} }))
      .rejects.toMatchObject({ code: 'invalid_input', message: expect.stringContaining('review the update again') })
    vi.restoreAllMocks()
    await expect(env.api.applyOpenApiUpdate({ collectionId: c.id, planId: '00000000-0000-4000-8000-000000000000', choices: {} }))
      .rejects.toMatchObject({ code: 'invalid_input' })
    expect((await env.api.listRequests(c.id)).some((r) => r.name === 'Adjust stock')).toBe(false)
    expect(await env.api.getOpenApiLink(c.id)).toMatchObject({ specVersion: '1.4.0' })
  })

  it('links a hand-made collection, matches its requests by method + path and records the operation on apply', async () => {
    const col = await env.api.createCollection(ws, 'Hand made')
    const mk = (name: string, method: string, url: string) =>
      env.api.createRequest({ workspaceId: ws, collectionId: col.id, name, method, url, documentJson: JSON.stringify({ url, method, headers: [] }) })
    const getPet = await mk('Pet by id', 'GET', '{{baseUrl}}/pets/:id')
    const create = await mk('New pet', 'POST', 'https://eu.shop.example.com/v1/pets')
    const other = await mk('Elsewhere', 'GET', '{{baseUrl}}/unknown')

    const link = await env.api.linkOpenApi({ collectionId: col.id, text: V1, source: { kind: 'file', value: 'shop.yaml' }, folders: 'tags' })
    expect(link).toMatchObject({ collectionId: col.id, sourceKind: 'file', source: 'shop.yaml', specVersion: '1.4.0', operationCount: 7 })
    expect(await env.api.listRequests(col.id)).toHaveLength(3) // linking changes no request

    const plan = await env.api.planOpenApiUpdate({ collectionId: col.id, text: V1, source: TEXT })
    expect(change(plan, 'GET /pets/{petId}')).toMatchObject({ kind: 'changed', editedHere: true, defaultChoice: 'keep', requestId: getPet.id, name: 'Pet by id' })
    expect(change(plan, 'GET /pets/{petId}').summary).toMatch(/^Matched by method and path/)
    expect(change(plan, 'POST /pets')).toMatchObject({ requestId: create.id })
    expect(plan.changes.filter((ch) => ch.kind === 'added').map((ch) => ch.key)).toEqual(['GET /pets', 'DELETE /pets/{petId}', 'PUT /pets/{petId}/photo', 'POST /orders', 'GET /health'])
    expect(plan.changes.some((ch) => ch.requestId === other.id)).toBe(false)

    const r = await env.api.applyOpenApiUpdate({ collectionId: col.id, planId: plan.planId, choices: { 'GET /pets/{petId}': 'apply' } })
    expect(r).toMatchObject({ added: 5, updated: 1, kept: 1 })
    const after = await env.api.listRequests(col.id)
    const updated = after.find((x) => x.id === getPet.id)!
    expect(updated.name).toBe('Pet by id')
    expect(updated.url).toBe('{{baseUrl}}/pets/:petId')
    expect(doc(updated).openapi).toMatchObject({ key: 'GET /pets/{petId}' })
    expect(doc(after.find((x) => x.id === create.id)!).openapi).toBeUndefined() // kept: not linked yet
    expect(doc(after.find((x) => x.id === other.id)!).openapi).toBeUndefined()

    // Now matched by key: no longer offered as an addition.
    const next = await env.api.planOpenApiUpdate({ collectionId: col.id, text: V1, source: TEXT })
    expect(change(next, 'GET /pets/{petId}')).toMatchObject({ kind: 'unchanged', requestId: getPet.id })
    expect(next.changes.filter((ch) => ch.kind === 'added')).toEqual([])
  })

  it('re-fetches a linked URL when no document is given, and asks for pasted/file documents', async () => {
    const c = await imported()
    await expect(env.api.planOpenApiUpdate({ collectionId: c.id })).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringMatching(/Choose the file again/) })
    const fetchSpy = vi.spyOn(env.core.openapi, 'fetchSpec').mockResolvedValue(V2)
    const plan = await env.api.planOpenApiUpdate({ collectionId: c.id, url: 'https://shop.example.com/openapi.yaml' })
    expect(plan.source).toEqual({ kind: 'url', value: 'https://shop.example.com/openapi.yaml' })
    const result = await env.api.applyOpenApiUpdate({ collectionId: c.id, planId: plan.planId, choices: {} })
    expect(result.link).toMatchObject({ sourceKind: 'url', source: 'https://shop.example.com/openapi.yaml' })
    const again = await env.api.planOpenApiUpdate({ collectionId: c.id })
    expect(fetchSpy).toHaveBeenLastCalledWith('https://shop.example.com/openapi.yaml')
    expect(again.specVersion).toBe('1.5.0')
  })

  it('path templates for matching', () => {
    expect(pathTemplate('{{baseUrl}}/pets/:id?x=1')).toBe('/pets/{}')
    expect(pathTemplate('/pets/{petId}')).toBe('/pets/{}')
    expect(pathTemplate('https://eu.shop.example.com/v1/pets/{{id}}', ['/v1'])).toBe('/pets/{}')
    expect(pathTemplate('localhost:3000/v1/orders#x', ['/v1'])).toBe('/orders')
    expect(pathTemplate('{{baseUrl}}')).toBe('/')
  })

  it('validates its input', async () => {
    const c = await imported()
    const call = (m: string, ...a: unknown[]) => (env.api as unknown as Record<string, (...x: unknown[]) => Promise<unknown>>)[m]!(...a)
    await expect(call('planOpenApiUpdate', { collectionId: 'nope' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(call('applyOpenApiUpdate', { collectionId: c.id, planId: c.id, choices: { x: 'maybe' } })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(call('linkOpenApi', { collectionId: c.id, text: 'nope: 1', source: TEXT, folders: 'tags' })).rejects.toMatchObject({ code: 'invalid_input' })
    expect(isObj(await env.api.getOpenApiLink(c.id))).toBe(true)
  })
})
