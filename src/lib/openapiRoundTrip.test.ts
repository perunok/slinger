/** Import a document, export the collection as OpenAPI, read the export back: the API's shape survives. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadSpec } from '../../shared/openapi/load'
import { createMockBackend } from '../dev/mockBackend'
import { exportOpenApi, openApiToYaml } from './openapiExport'

const fixture = (name: string) => readFileSync(join(__dirname, '../../electron/__tests__/openapi/fixtures', name), 'utf8')

async function roundTrip(text: string) {
  const mock = createMockBackend({ latencyMs: 0, seed: false })
  const ws = (await mock.createWorkspace('W')).id
  const imported = await mock.importOpenApi({ workspaceId: ws, text, source: { kind: 'text', value: null }, folders: 'tags' })
  const id = imported.collection.id
  const doc = exportOpenApi({
    collection: imported.collection,
    folders: await mock.listFolders(id),
    requests: await mock.listRequests(id),
    variables: await mock.listCollectionVariables(id),
    latestVersion: null,
  })
  return { before: loadSpec(text), after: loadSpec(openApiToYaml(doc)) }
}

const shape = (spec: ReturnType<typeof loadSpec>) =>
  spec.operations
    .map((op) => ({
      key: op.key,
      params: op.parameters.map((p) => `${p.in}:${p.name}${p.required ? '!' : ''}`).sort(),
      body: op.requestBody?.content.map((c) => c.type.split(';')[0]) ?? [],
      responses: op.responses.map((r) => r.key).sort(),
      tag: op.tags[0] ?? null,
    }))
    .sort((a, b) => a.key.localeCompare(b.key))

describe('OpenAPI round trip (import, then export)', () => {
  it('OpenAPI 3.0: operations, parameters, bodies, responses and tags survive', async () => {
    const { before, after } = await roundTrip(fixture('shop-3.0.yaml'))
    const b = shape(before)
    const a = shape(after)
    expect(a.map((o) => o.key)).toEqual(b.map((o) => o.key))
    for (const [i, op] of a.entries()) {
      const orig = b[i]!
      expect(op.params, op.key).toEqual(orig.params)
      expect(op.tag, op.key).toBe(orig.tag)
      // 2XX / default come back under their keys (the example names keep them).
      expect(op.responses, op.key).toEqual(orig.responses)
      if (orig.body.length) expect(op.body[0], op.key).toBe(orig.body[0])
    }
    expect(after.doc.servers).toEqual([{ url: 'https://eu.shop.example.com/v1' }])
    expect(Object.keys((after.doc.components as { securitySchemes?: object }).securitySchemes ?? {})).toEqual(expect.arrayContaining(['bearerAuth', 'apiKeyAuth']))
  })

  it('Swagger 2.0 comes back as OpenAPI 3.1 with the same operations', async () => {
    const { before, after } = await roundTrip(fixture('petstore-2.0.json'))
    expect(after.version).toBe('3.1')
    expect(shape(after).map((o) => o.key)).toEqual(shape(before).map((o) => o.key))
    expect(after.operations.map((o) => o.operationId).sort()).toEqual(['addPet', 'findPets', 'upload'])
  })
})
