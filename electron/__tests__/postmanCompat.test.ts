/**
 * "Importing a Slinger export into Postman must not break": every exported collection shape is checked
 *
 *   1. against the OFFICIAL Postman Collection v2.1.0 JSON schema (fixtures/, draft-04, validated with ajv), and
 *   2. by Postman's own SDK (`postman-collection`, the library the Postman app and Newman use to load collections):
 *      it must load, keep the name, every item and the version, and its re-export must still import into Slinger.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import Ajv from 'ajv'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PostmanCollectionV21, PostmanItem } from '../../src/lib/postman'
import { exportCollection, RICH_COLLECTION } from './exportFixtures'
import { makeEnv, SAMPLE_COLLECTION, type TestEnv } from './helpers'

const SCHEMA = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/postman-collection-v2.1.schema.json', import.meta.url)), 'utf8'))

/** Minimal typing of the parts of postman-collection used here (its package.json does not point at its .d.ts). */
interface SdkItem {
  name: string
  request: { method: string; url: { toString(): string } }
}
interface SdkCollection {
  name: string
  version?: { toString(): string }
  items: { count(): number }
  forEachItem(fn: (item: SdkItem) => void): void
  forEachItemGroup(fn: (group: { name: string }) => void): void
  events: { count(): number }
  toJSON(): Record<string, unknown>
}
const sdk = createRequire(import.meta.url)('postman-collection') as {
  Collection: new (definition: unknown) => SdkCollection
}

const ajv = new Ajv({ schemaId: 'id', meta: false, allErrors: true, unknownFormats: 'ignore' })
ajv.addMetaSchema(createRequire(import.meta.url)('ajv/lib/refs/json-schema-draft-04.json'))
const validateV21 = ajv.compile(SCHEMA)

function expectValidV21(json: unknown) {
  const ok = validateV21(json)
  expect(ok ? [] : validateV21.errors).toEqual([])
}

const flatten = (items: PostmanItem[], out: { requests: string[]; folders: string[] } = { requests: [], folders: [] }) => {
  for (const it of items) {
    if (it.item) {
      out.folders.push(it.name)
      flatten(it.item, out)
    } else out.requests.push(it.name)
  }
  return out
}

let env: TestEnv
let wsId: string
beforeEach(async () => {
  env = makeEnv()
  wsId = (await env.api.createWorkspace('WS')).id
})
afterEach(() => env.cleanup())

/** The collection shapes Slinger can export. */
async function exports(): Promise<Record<string, PostmanCollectionV21>> {
  const rich = (await env.api.importPostmanCollection(wsId, JSON.stringify(RICH_COLLECTION))).collection.id
  const noHistory = await exportCollection(env, rich)
  await env.api.createCollectionVersion({ collectionId: rich, version: '1.0.0', notes: 'First' })
  await env.api.createRequest({ workspaceId: wsId, collectionId: rich, name: 'Added later', method: 'DELETE', url: 'https://api.example.com/x', documentJson: '{}' })
  await env.api.createCollectionVersion({ collectionId: rich, version: '1.2.0', notes: 'Second\nline' })
  await env.api.createCollectionVersion({ collectionId: rich, version: '2.0.0-beta.1' })
  const sample = (await env.api.importPostmanCollection(wsId, readFileSync(SAMPLE_COLLECTION, 'utf8'))).collection.id
  await env.api.createCollectionVersion({ collectionId: sample, version: '0.1.0' })
  const empty = await env.api.createCollection(wsId, 'Brand new ✨ ኤፒአይ')
  return {
    'no versions (Postman-origin, scripts/examples/descriptions/folders/auth)': noHistory,
    'with history and snapshots': await exportCollection(env, rich),
    'with history, metadata only': await exportCollection(env, rich, { includeSnapshots: false }),
    'sample collection with examples, one version': await exportCollection(env, sample),
    'empty collection with a Unicode name': await exportCollection(env, empty.id),
  }
}

describe('exports validate against the official Postman v2.1.0 schema', () => {
  it('the vendored schema is the draft-04 v2.1.0 collection schema', () => {
    expect(SCHEMA.$schema).toBe('http://json-schema.org/draft-04/schema#')
    expect(SCHEMA.id).toBe('https://schema.getpostman.com/json/collection/v2.1.0/')
    // Sanity: the validator really rejects broken collections (so a pass means something).
    expect(validateV21({ info: { name: 'x' }, item: [] })).toBe(false) // schema is required
    expect(validateV21({ info: { name: 'x', schema: 's', version: 5 }, item: [] })).toBe(false) // version must be string or object
    expect(validateV21({ info: { name: 'x', schema: 's' }, item: [{ name: 'r', request: { method: 'GET', url: 1 } }] })).toBe(false)
  })

  it('every export shape is valid, with info.version in the schema-allowed string form', async () => {
    for (const [label, json] of Object.entries(await exports())) {
      // Validate the serialized file, exactly as Postman reads it.
      const file = JSON.parse(JSON.stringify(json))
      expect(() => expectValidV21(file), label).not.toThrow()
      if (file.info.version !== undefined) expect(typeof file.info.version, label).toBe('string')
      expect(file.info._slinger, label).toBeDefined()
    }
  })
})

describe("exports load in Postman's SDK (postman-collection)", () => {
  it('name, every folder and request, scripts and the version survive', async () => {
    for (const [label, json] of Object.entries(await exports())) {
      const file = JSON.parse(JSON.stringify(json)) as PostmanCollectionV21
      const c = new sdk.Collection(file)
      expect(c.name, label).toBe(file.info.name)
      const requests: string[] = []
      const folders: string[] = []
      c.forEachItem((i) => requests.push(i.name))
      c.forEachItemGroup((g) => folders.push(g.name))
      const expected = flatten(file.item)
      expect(requests.sort(), label).toEqual(expected.requests.sort())
      expect(folders.sort(), label).toEqual(expected.folders.sort())
      expect(c.events.count(), label).toBe(file.event?.length ?? 0)
      if (file.info.version) expect(c.version?.toString(), label).toBe(file.info.version)
      else expect(c.version, label).toBeUndefined()
    }
  })

  it('URLs, methods and the Slinger version come through the SDK intact', async () => {
    const file = JSON.parse(JSON.stringify((await exports())['with history and snapshots']!)) as PostmanCollectionV21
    const c = new sdk.Collection(file)
    const byName = new Map<string, SdkItem>()
    c.forEachItem((i) => byName.set(i.name, i))
    expect(byName.get('Get user')!.request.method).toBe('GET')
    // The SDK substitutes the `:id` path variable with its exported value, which proves the variable survived.
    expect(byName.get('Get user')!.request.url.toString()).toBe('{{baseUrl}}/users/42?expand=roles&debug=1')
    expect(byName.get('Create user')!.request.url.toString()).toBe('https://api.example.com:8443/admin/users')
    expect(c.version!.toString()).toBe('2.0.0-beta.1')
  })

  it("the SDK's re-export (toJSON) still imports into Slinger, without the history", async () => {
    const all = await exports()
    for (const label of ['with history and snapshots', 'sample collection with examples, one version']) {
      const original = all[label]!
      const reexported = new sdk.Collection(JSON.parse(JSON.stringify(original))).toJSON()
      // The SDK drops `url.raw`; Slinger rebuilds the URL from protocol/host/port/path/query (shared/postmanUrl.ts).
      // Postman does not keep unknown `info` fields: the SDK moves `_`-prefixed ones out of `info` (to a top-level
      // `_` meta object) and the Postman app drops them on export. Either way the history is not in `info._slinger`
      // any more, so Slinger imports the content only, exactly like any Postman collection.
      expect((reexported.info as Record<string, unknown>)._slinger).toBeUndefined()
      const imported = await env.api.importPostmanCollection(wsId, JSON.stringify(reexported))
      expect(imported.versionHistory, label).toBeUndefined()
      expect(imported.collection.name).toBe(original.info.name)
      const expected = flatten(original.item)
      expect(imported.requests.map((r) => r.name).sort(), label).toEqual(expected.requests.sort())
      expect(imported.folders.map((f) => f.name).sort(), label).toEqual(expected.folders.sort())
      const originalUrls = new Map<string, string>()
      const walk = (items: PostmanItem[]) => items.forEach((i) => (i.item ? walk(i.item) : originalUrls.set(i.name, i.request!.url.raw)))
      walk(original.item)
      for (const r of imported.requests) expect(r.url, `${label}: ${r.name}`).toBe(originalUrls.get(r.name))
      expect(await env.api.listCollectionVersions(imported.collection.id)).toEqual([])
    }
  })
})
