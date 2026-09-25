import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildPostmanCollection } from '../../src/lib/postman'
import { nextPatchVersion } from '../services/postmanImport'
import { makeEnv, type TestEnv } from './helpers'

let env: TestEnv
let wsId: string
beforeEach(async () => {
  env = makeEnv()
  wsId = (await env.api.createWorkspace('Re-import WS')).id
})
afterEach(() => env.cleanup())

const PM_ID = '6F1A2B3C-0000-4000-8000-00000000ABCD'
const script = (code: string) => [{ listen: 'prerequest', script: { type: 'text/javascript', exec: [code] } }]

const v1 = {
  info: { _postman_id: PM_ID, name: 'Shop API', description: 'old docs', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  event: script('// old collection script'),
  item: [
    { name: 'Orders', description: 'old folder docs', event: script('// old folder'), item: [{ name: 'List orders', request: { method: 'GET', url: 'https://x/orders' } }] },
    { name: 'Health', request: { method: 'GET', url: 'https://x/health' } },
  ],
}
const v2 = {
  info: { _postman_id: PM_ID, name: 'Shop API', description: { content: 'new docs', type: 'text/plain' }, schema: v1.info.schema },
  event: script('// new collection script'),
  item: [
    {
      name: 'Customers',
      description: 'new folder docs',
      event: script('// new folder'),
      item: [
        { name: 'Get customer', request: { method: 'GET', url: 'https://x/customers/1' }, response: [{ name: 'OK', code: 200, body: '{"id":1}' }] },
        { name: 'Nested', item: [{ name: 'Deep', request: { method: 'DELETE', url: 'https://x/deep' } }] },
      ],
    },
    { name: 'Create customer', request: { method: 'POST', url: 'https://x/customers' } },
    { name: 'Ping', request: { method: 'GET', url: 'https://x/ping' } },
  ],
}

const live = (table: 'folders' | 'requests', collectionId: string) =>
  env.core.db.prepare(`SELECT id, deleted FROM ${table} WHERE collection_id = ?`).all(collectionId) as Array<{ id: string; deleted: number }>

describe('importPostmanCollection: source id and copy name', () => {
  it('records the file _postman_id (lower-cased) for later matching', async () => {
    const { collection } = await env.api.importPostmanCollection(wsId, JSON.stringify(v1))
    expect(collection.sourcePostmanId).toBe(PM_ID.toLowerCase())
    expect((await env.api.listCollections(wsId))[0]!.sourcePostmanId).toBe(PM_ID.toLowerCase())
  })

  it('imports as a copy under the given name without linking it to the file', async () => {
    await env.api.importPostmanCollection(wsId, JSON.stringify(v1))
    const { collection } = await env.api.importPostmanCollection(wsId, JSON.stringify(v1), { name: 'Shop API (2)' })
    expect(collection).toMatchObject({ name: 'Shop API (2)', sourcePostmanId: null })
    expect((await env.api.listCollections(wsId)).map((c) => c.name).sort()).toEqual(['Shop API', 'Shop API (2)'])
  })

  it('files without _postman_id record nothing', async () => {
    const { collection } = await env.api.importPostmanCollection(wsId, JSON.stringify({ ...v1, info: { name: 'No id' } }))
    expect(collection.sourcePostmanId).toBeNull()
  })

  it('validates options at the IPC boundary', async () => {
    await expect(env.api.importPostmanCollection(wsId, JSON.stringify(v1), { name: '' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(env.api.importPostmanCollection(wsId, JSON.stringify(v1), { name: 'x', extra: 1 } as never)).rejects.toMatchObject({ code: 'invalid_input' })
  })
})

describe('replaceCollectionFromPostman', () => {
  it('replaces folders, requests, examples, scripts and descriptions; keeps id, name and versions; soft-deletes old rows', async () => {
    const imported = await env.api.importPostmanCollection(wsId, JSON.stringify(v1))
    const id = imported.collection.id
    await env.api.renameCollection(id, 'Shop API (mine)')
    const existing = await env.api.createCollectionVersion({ collectionId: id, version: '1.2.0', notes: 'release' })

    const res = await env.api.replaceCollectionFromPostman(id, JSON.stringify(v2), 'shop.postman_collection.json')

    expect(res.collection.id).toBe(id)
    expect(res.collection.name).toBe('Shop API (mine)')
    expect(res.collection).toMatchObject({ description: 'new docs', descriptionType: 'text/plain', sourcePostmanId: PM_ID.toLowerCase() })
    expect(JSON.parse(res.collection.scriptsJson!)[0].script.exec).toEqual(['// new collection script'])
    expect(res.scriptCount).toBe(2)
    expect((await env.api.listCollections(wsId)).map((c) => c.id)).toEqual([id])

    // Safety version: next patch after the latest release, holding the OLD content.
    expect(res.safetyVersion).toMatchObject({ collectionId: id, version: '1.2.1', notes: 'Automatic snapshot before re-import from shop.postman_collection.json', folderCount: 1, requestCount: 2 })
    const versions = await env.api.listCollectionVersions(id)
    expect(versions.map((v) => v.version)).toEqual(['1.2.1', '1.2.0'])
    expect(versions[1]!.id).toBe(existing.id)
    const snap = (await env.api.getCollectionVersion(res.safetyVersion.id)).snapshot
    expect(snap.requests.map((r) => r.name).sort()).toEqual(['Health', 'List orders'])
    expect(snap.collectionDescription).toBe('old docs')

    // New content, in file order.
    const folders = await env.api.listFolders(id)
    const requests = await env.api.listRequests(id)
    expect(folders.map((f) => [f.name, f.sortOrder]).sort()).toEqual([['Customers', 0], ['Nested', 0]])
    const customers = folders.find((f) => f.name === 'Customers')!
    expect(customers).toMatchObject({ description: 'new folder docs', parentFolderId: null })
    expect(JSON.parse(customers.scriptsJson!)[0].script.exec).toEqual(['// new folder'])
    expect(folders.find((f) => f.name === 'Nested')!.parentFolderId).toBe(customers.id)
    expect(requests.map((r) => [r.name, r.sortOrder]).sort()).toEqual([['Create customer', 0], ['Deep', 0], ['Get customer', 0], ['Ping', 1]])
    const get = requests.find((r) => r.name === 'Get customer')!
    expect(JSON.parse(get.documentJson).responses).toEqual([{ name: 'OK', code: 200, body: '{"id":1}' }])

    // Old rows are soft-deleted (not removed), so sync sees the deletions.
    const oldIds = new Set([...imported.folders.map((f) => f.id), ...imported.requests.map((r) => r.id)])
    const rows = [...live('folders', id), ...live('requests', id)]
    expect(rows.filter((r) => oldIds.has(r.id)).every((r) => r.deleted === 1)).toBe(true)
    expect(rows.filter((r) => !oldIds.has(r.id)).every((r) => r.deleted === 0)).toBe(true)
    expect(rows.filter((r) => oldIds.has(r.id))).toHaveLength(3)

    // The export of the replaced collection round-trips the new tree.
    const exported = buildPostmanCollection({ collection: res.collection, folders, requests })
    expect(exported.item.map((i) => i.name)).toEqual(['Customers', 'Create customer', 'Ping'])
  })

  it('restoring the safety version brings the previous content back', async () => {
    const { collection } = await env.api.importPostmanCollection(wsId, JSON.stringify(v1))
    const res = await env.api.replaceCollectionFromPostman(collection.id, JSON.stringify(v2), null)
    expect(res.safetyVersion.version).toBe('0.0.1')
    expect(res.safetyVersion.notes).toBe('Automatic snapshot before re-import from a Postman file')
    await env.api.restoreCollectionVersion(res.safetyVersion.id, 'replace')
    expect((await env.api.listRequests(collection.id)).map((r) => r.name).sort()).toEqual(['Health', 'List orders'])
  })

  it('rolls back completely on a bad file: no snapshot, no deletions', async () => {
    const { collection, requests } = await env.api.importPostmanCollection(wsId, JSON.stringify(v1))
    const before = JSON.stringify([...live('folders', collection.id), ...live('requests', collection.id)])
    for (const bad of ['not json', '{"info":{}}', JSON.stringify({ info: { name: 'x' }, item: [{ name: 'empty', item: [] }] })]) {
      await expect(env.api.replaceCollectionFromPostman(collection.id, bad)).rejects.toMatchObject({ code: 'invalid_input' })
    }
    expect(JSON.stringify([...live('folders', collection.id), ...live('requests', collection.id)])).toBe(before)
    expect(await env.api.listCollectionVersions(collection.id)).toEqual([])
    expect((await env.api.listRequests(collection.id)).map((r) => r.id).sort()).toEqual(requests.map((r) => r.id).sort())
  })

  it('rolls back the snapshot and deletions when an insert fails midway', async () => {
    const { collection } = await env.api.importPostmanCollection(wsId, JSON.stringify(v1))
    env.core.db.exec(`CREATE TRIGGER boom BEFORE INSERT ON requests WHEN NEW.name = 'Ping' BEGIN SELECT RAISE(ABORT, 'boom'); END`)
    await expect(env.api.replaceCollectionFromPostman(collection.id, JSON.stringify(v2))).rejects.toBeTruthy()
    expect(await env.api.listCollectionVersions(collection.id)).toEqual([])
    expect((await env.api.listRequests(collection.id)).map((r) => r.name).sort()).toEqual(['Health', 'List orders'])
    expect((await env.api.listCollections(wsId))[0]!.description).toBe('old docs')
  })

  it('rejects unknown collections and bad arguments', async () => {
    await expect(env.api.replaceCollectionFromPostman('00000000-0000-4000-8000-00000000abcd', JSON.stringify(v2))).rejects.toMatchObject({ code: 'not_found' })
    await expect(env.api.replaceCollectionFromPostman('nope', JSON.stringify(v2))).rejects.toMatchObject({ code: 'invalid_input' })
    await expect((env.api.replaceCollectionFromPostman as (...a: unknown[]) => Promise<unknown>)(wsId, 42)).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('keeps the recorded source id when the new file has none', async () => {
    const { collection } = await env.api.importPostmanCollection(wsId, JSON.stringify(v1))
    const res = await env.api.replaceCollectionFromPostman(collection.id, JSON.stringify({ ...v2, info: { name: 'Shop API' } }))
    expect(res.collection.sourcePostmanId).toBe(PM_ID.toLowerCase())
  })
})

describe('nextPatchVersion', () => {
  it('bumps the latest release, ignores pre-releases and skips taken versions', () => {
    expect(nextPatchVersion([])).toBe('0.0.1')
    expect(nextPatchVersion(['1.0.0', '0.9.3'])).toBe('1.0.1')
    expect(nextPatchVersion(['1.0.0', '2.0.0-beta.1'])).toBe('1.0.1')
    expect(nextPatchVersion(['1.0.0', '1.0.1', '1.0.2-rc.1'])).toBe('1.0.2')
    expect(nextPatchVersion(['0.0.1-alpha'])).toBe('0.0.1')
  })
})
