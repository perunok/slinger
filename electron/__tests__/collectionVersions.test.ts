import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CollectionVersion } from '../../shared/types'
import { DOC, makeEnv, scaffold, type TestEnv } from './helpers'

let env: TestEnv
let wsId: string
let colId: string
beforeEach(async () => {
  env = makeEnv()
  const s = await scaffold(env)
  wsId = s.workspace.id
  colId = s.collection.id
})
afterEach(() => env.cleanup())

/** Collection with root request + folder(a) > folder(b) > request, plus one environment secret. */
async function populate() {
  const a = await env.api.createFolder({ workspaceId: wsId, collectionId: colId, name: 'a' })
  const b = await env.api.createFolder({ workspaceId: wsId, collectionId: colId, parentFolderId: a.id, name: 'b' })
  const doc = JSON.stringify({ headers: [{ key: 'X', value: '1' }] })
  const r1 = await env.api.createRequest({ workspaceId: wsId, collectionId: colId, name: 'root', method: 'GET', url: 'http://root', documentJson: doc })
  const r2 = await env.api.createRequest({ workspaceId: wsId, collectionId: colId, folderId: b.id, name: 'deep', method: 'POST', url: 'http://deep', documentJson: DOC })
  const environment = await env.api.createEnvironment(wsId, 'E')
  await env.api.upsertEnvironmentVariable({ environmentId: environment.id, key: 'TOKEN', value: 'super-secret-value', isSecret: true })
  return { a, b, r1, r2, doc }
}

const create = (version: string, notes?: string | null) => env.api.createCollectionVersion({ collectionId: colId, version, notes })

describe('createCollectionVersion', () => {
  it('snapshots live folders and requests with counts, without environments or secrets', async () => {
    const { a, b, r1, r2, doc } = await populate()
    const v = await create('1.0.0', '  first release  ')
    expect(v).toMatchObject({ workspaceId: wsId, collectionId: colId, version: '1.0.0', notes: 'first release', folderCount: 2, requestCount: 2 })

    const detail = await env.api.getCollectionVersion(v.id)
    expect(detail.snapshot.collectionName).toBe('Col')
    expect(detail.snapshot.folders).toEqual([
      { id: a.id, parentFolderId: null, name: 'a', sortOrder: 0 },
      { id: b.id, parentFolderId: a.id, name: 'b', sortOrder: 0 },
    ])
    expect(detail.snapshot.requests.map((r) => [r.id, r.folderId, r.name, r.method, r.url])).toEqual([
      [r1.id, null, 'root', 'GET', 'http://root'],
      [r2.id, b.id, 'deep', 'POST', 'http://deep'],
    ])
    expect(detail.snapshot.requests[0]!.documentJson).toBe(doc)

    const raw = (env.core.db.prepare('SELECT snapshot_json FROM collection_versions WHERE id = ?').get(v.id) as { snapshot_json: string }).snapshot_json
    expect(raw).not.toContain('super-secret-value')
    expect(raw).not.toContain('TOKEN')
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['collectionName', 'folders', 'requests'])
  })

  it('excludes soft-deleted folders and requests', async () => {
    const { r1, a } = await populate()
    await env.api.deleteRequest(r1.id)
    await env.api.deleteFolder(a.id) // cascades to b and deep
    const v = await create('0.1.0')
    expect(v).toMatchObject({ folderCount: 0, requestCount: 0 })
  })

  it('accepts an empty collection and null/empty notes', async () => {
    expect(await create('1.0.0', '   ')).toMatchObject({ notes: null, folderCount: 0, requestCount: 0 })
    expect(await create('1.0.1', null)).toMatchObject({ notes: null })
  })

  it('rejects invalid semver strings without writing anything', async () => {
    for (const bad of ['1.0', 'v1.0.0', '01.0.0', '1.0.0+build', '', 'latest', '1.0.0-', ' 1.0.0']) {
      await expect(create(bad), bad).rejects.toMatchObject({ code: 'invalid_input' })
    }
    expect(await env.api.listCollectionVersions(colId)).toEqual([])
  })

  it('rejects duplicate versions per collection but allows the same version in another collection', async () => {
    await create('1.0.0')
    const err = await create('1.0.0').catch((e) => e)
    expect(err).toMatchObject({ code: 'invalid_input', details: { reason: 'duplicate_version' } })
    const other = await env.api.createCollection(wsId, 'Other')
    await expect(env.api.createCollectionVersion({ collectionId: other.id, version: '1.0.0' })).resolves.toMatchObject({ collectionId: other.id })
  })

  it('a deleted version frees its label for reuse', async () => {
    const v = await create('1.0.0')
    await env.api.deleteCollectionVersion(v.id)
    await expect(create('1.0.0')).resolves.toMatchObject({ version: '1.0.0' })
  })

  it('rejects oversized notes and unknown collections', async () => {
    await expect(create('1.0.0', 'x'.repeat(10_001))).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(env.api.createCollectionVersion({ collectionId: '11111111-1111-4111-8111-111111111111', version: '1.0.0' })).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('immutability', () => {
  it('a version does not change when the collection changes afterwards', async () => {
    const { r1 } = await populate()
    const v = await create('1.0.0')
    const before = (env.core.db.prepare('SELECT snapshot_json FROM collection_versions WHERE id = ?').get(v.id) as { snapshot_json: string }).snapshot_json
    await env.api.renameRequest(r1.id, 'renamed')
    await env.api.deleteRequest(r1.id)
    await env.api.renameCollection(colId, 'Renamed collection')
    const after = (env.core.db.prepare('SELECT snapshot_json FROM collection_versions WHERE id = ?').get(v.id) as { snapshot_json: string }).snapshot_json
    expect(after).toBe(before)
    expect((await env.api.getCollectionVersion(v.id)).snapshot.collectionName).toBe('Col')
  })

  it('the database itself refuses to modify a version (trigger), including via raw SQL', async () => {
    const v = await create('1.0.0')
    const db = env.core.db
    for (const sql of [
      "UPDATE collection_versions SET snapshot_json = '{}' WHERE id = ?",
      "UPDATE collection_versions SET version = '9.9.9' WHERE id = ?",
      "UPDATE collection_versions SET notes = 'edited' WHERE id = ?",
      "UPDATE collection_versions SET request_count = 99 WHERE id = ?",
    ]) {
      expect(() => db.prepare(sql).run(v.id), sql).toThrow(/immutable/)
    }
    // soft delete is the only allowed change
    expect(() => db.prepare('UPDATE collection_versions SET deleted = 1 WHERE id = ?').run(v.id)).not.toThrow()
  })

  it('the API exposes no update path', () => {
    expect(Object.keys(env.api).filter((k) => /CollectionVersion/.test(k)).sort()).toEqual([
      'createCollectionVersion',
      'deleteCollectionVersion',
      'getCollectionVersion',
      'listCollectionVersions',
      'restoreCollectionVersion',
    ])
  })
})

describe('listCollectionVersions ordering', () => {
  it('sorts by semver precedence descending, not by creation time or string order', async () => {
    const created = ['1.0.0', '1.10.0', '1.2.0', '2.0.0-beta.2', '2.0.0-beta.11', '2.0.0-alpha', '2.0.0', '0.9.9', '1.0.0-rc.1']
    for (const v of created) await create(v)
    const listed: CollectionVersion[] = await env.api.listCollectionVersions(colId)
    expect(listed.map((v) => v.version)).toEqual(['2.0.0', '2.0.0-beta.11', '2.0.0-beta.2', '2.0.0-alpha', '1.10.0', '1.2.0', '1.0.0', '1.0.0-rc.1', '0.9.9'])
  })

  it('hides deleted versions and versions of deleted collections', async () => {
    const v1 = await create('1.0.0')
    await create('1.1.0')
    await env.api.deleteCollectionVersion(v1.id)
    expect((await env.api.listCollectionVersions(colId)).map((v) => v.version)).toEqual(['1.1.0'])
    await expect(env.api.getCollectionVersion(v1.id)).rejects.toMatchObject({ code: 'not_found' })
    await env.api.deleteCollection(colId)
    await expect(env.api.listCollectionVersions(colId)).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('restoreCollectionVersion', () => {
  it("'replace' swaps the live content for the snapshot, with new ids, in one go", async () => {
    const { a, b, r1, r2 } = await populate()
    const v = await create('1.0.0')

    // diverge: change, add and remove things
    await env.api.renameRequest(r1.id, 'changed')
    await env.api.deleteFolder(a.id)
    const extra = await env.api.createRequest({ workspaceId: wsId, collectionId: colId, name: 'extra', method: 'GET', url: 'http://extra', documentJson: DOC })
    const colBefore = (await env.api.listCollections(wsId)).find((c) => c.id === colId)!

    const restored = await env.api.restoreCollectionVersion(v.id, 'replace')
    expect(restored.id).toBe(colId)
    expect(restored.version).toBe(colBefore.version + 1)

    const folders = await env.api.listFolders(colId)
    const requests = await env.api.listRequests(colId)
    expect(folders.map((f) => f.name).sort()).toEqual(['a', 'b'])
    expect(requests.map((r) => r.name).sort()).toEqual(['deep', 'root'])
    const fa = folders.find((f) => f.name === 'a')!
    const fb = folders.find((f) => f.name === 'b')!
    expect(fa.parentFolderId).toBeNull()
    expect(fb.parentFolderId).toBe(fa.id)
    expect(requests.find((r) => r.name === 'deep')).toMatchObject({ folderId: fb.id, method: 'POST', url: 'http://deep' })
    expect(requests.find((r) => r.name === 'root')).toMatchObject({ folderId: null, method: 'GET' })

    // brand-new ids and fresh version counters; nothing from before survives
    const oldIds = new Set([a.id, b.id, r1.id, r2.id, extra.id])
    for (const row of [...folders, ...requests]) {
      expect(oldIds.has(row.id)).toBe(false)
      expect(row.version).toBe(1)
    }
    // the old rows are soft-deleted (and their versions bumped), not gone
    const old = env.core.db.prepare('SELECT deleted, version FROM requests WHERE id = ?').get(extra.id) as { deleted: number; version: number }
    expect(old).toEqual({ deleted: 1, version: 2 })
  })

  it("'replace' is atomic: a corrupt snapshot leaves the collection untouched", async () => {
    await populate()
    const v = await create('1.0.0')
    // Sabotage the stored snapshot (bypassing the trigger) so restoring fails mid-way.
    env.core.db.exec('DROP TRIGGER collection_versions_immutable')
    env.core.db
      .prepare('UPDATE collection_versions SET snapshot_json = ? WHERE id = ?')
      .run(JSON.stringify({ collectionName: 'x', folders: [{ id: 'f1', parentFolderId: 'ghost', name: 'orphan', sortOrder: 0 }], requests: [] }), v.id)
    const before = await env.api.listRequests(colId)
    await expect(env.api.restoreCollectionVersion(v.id, 'replace')).rejects.toMatchObject({ code: 'internal_error' })
    expect((await env.api.listRequests(colId)).map((r) => r.id)).toEqual(before.map((r) => r.id))
    expect((await env.api.listFolders(colId)).length).toBe(2)
  })

  it("'copy' creates \"<name> (v<version>)\" and leaves the live collection untouched", async () => {
    await populate()
    const v = await create('1.2.3-beta.1')
    await env.api.renameCollection(colId, 'Renamed later')
    const liveBefore = { folders: await env.api.listFolders(colId), requests: await env.api.listRequests(colId) }

    const copy = await env.api.restoreCollectionVersion(v.id, 'copy')
    expect(copy.name).toBe('Col (v1.2.3-beta.1)')
    expect(copy.id).not.toBe(colId)
    expect(copy.workspaceId).toBe(wsId)
    expect((await env.api.listCollections(wsId)).map((c) => c.id)).toContain(copy.id)

    expect(await env.api.listFolders(colId)).toEqual(liveBefore.folders)
    expect(await env.api.listRequests(colId)).toEqual(liveBefore.requests)

    const folders = await env.api.listFolders(copy.id)
    const requests = await env.api.listRequests(copy.id)
    expect(folders.map((f) => f.name).sort()).toEqual(['a', 'b'])
    expect(requests.map((r) => r.name).sort()).toEqual(['deep', 'root'])
    expect(folders.find((f) => f.name === 'b')!.parentFolderId).toBe(folders.find((f) => f.name === 'a')!.id)
    expect(new Set([...folders, ...requests].map((x) => x.collectionId))).toEqual(new Set([copy.id]))
    // the copy can be versioned/restored again independently
    expect((await env.api.listCollectionVersions(copy.id)).length).toBe(0)
  })

  it('rejects unknown modes and deleted versions', async () => {
    const v = await create('1.0.0')
    await expect((env.api.restoreCollectionVersion as (...a: unknown[]) => Promise<unknown>)(v.id, 'merge')).rejects.toMatchObject({ code: 'invalid_input' })
    await env.api.deleteCollectionVersion(v.id)
    await expect(env.api.restoreCollectionVersion(v.id, 'copy')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('a soft-deleted workspace/collection cascades to its versions', async () => {
    const v = await create('1.0.0')
    await env.api.deleteWorkspace(wsId)
    expect(env.core.db.prepare('SELECT deleted FROM collection_versions WHERE id = ?').get(v.id)).toEqual({ deleted: 1 })
  })
})
