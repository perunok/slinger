import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CollectionSnapshot } from '../../shared/types'
import { diffSnapshots } from '../../src/lib/versionDiff'
import { parseSlingerBlock, restoreVersionHistory } from '../services/versionHistory'
import { exportCollection, RICH_COLLECTION } from './exportFixtures'
import { makeEnv, type TestEnv } from './helpers'

let env: TestEnv
let wsId: string
beforeEach(async () => {
  env = makeEnv()
  wsId = (await env.api.createWorkspace('WS')).id
})
afterEach(() => env.cleanup())

/** Creates a version "at" a fixed time (versions are immutable, so the date is pinned via Date.now). */
async function versionAt(seconds: number, collectionId: string, version: string, notes: string | null) {
  const spy = vi.spyOn(Date, 'now').mockReturnValue(seconds * 1000)
  try {
    return await env.api.createCollectionVersion({ collectionId, version, notes })
  } finally {
    spy.mockRestore()
  }
}

/** A Postman-origin collection with three versions and a live state that differs from all of them. */
async function versionedCollection() {
  const imported = await env.api.importPostmanCollection(wsId, JSON.stringify(RICH_COLLECTION))
  const colId = imported.collection.id
  const v1 = await versionAt(1_700_000_000, colId, '1.0.0', 'First release')
  const extra = await env.api.createFolder({ workspaceId: wsId, collectionId: colId, name: 'Reports' })
  await env.api.createRequest({ workspaceId: wsId, collectionId: colId, folderId: extra.id, name: 'Daily', method: 'GET', url: '{{baseUrl}}/reports/daily', documentJson: '{}' })
  const v2 = await versionAt(1_710_000_000, colId, '1.2.0', 'Reports\n\nwith **markdown**')
  await env.api.setCollectionDescription(colId, 'Changed after 1.2.0')
  const v3 = await versionAt(1_720_000_000, colId, '2.0.0-beta.1', null)
  const env1 = await env.api.createEnvironment(wsId, 'Prod')
  await env.api.upsertEnvironmentVariable({ environmentId: env1.id, key: 'token', value: 'top-secret-token-value', isSecret: true })
  await env.api.upsertEnvironmentVariable({ environmentId: env1.id, key: 'baseUrl', value: 'https://plain-env-value.example', isSecret: false })
  return { colId, ids: [v1.id, v2.id, v3.id] }
}

async function historyOf(colId: string) {
  const list = await env.api.listCollectionVersions(colId)
  return Promise.all(list.map((v) => env.api.getCollectionVersion(v.id)))
}

describe('versioned export', () => {
  it('writes info.version (latest semver) and every version with its snapshot, and never environment values', async () => {
    const { colId } = await versionedCollection()
    const out = await exportCollection(env, colId, { appVersion: '0.3.2', now: new Date('2026-09-25T12:00:00Z') })
    expect(out.info.version).toBe('2.0.0-beta.1')
    const block = out.info._slinger!
    expect(block).toMatchObject({ formatVersion: 1, app: 'Slinger 0.3.2', exportedAt: '2026-09-25T12:00:00.000Z', collectionId: colId, includesSnapshots: true })
    expect(block.versions.map((v) => [v.version, v.notes, v.createdAt, v.folderCount, v.requestCount])).toEqual([
      ['1.0.0', 'First release', '2023-11-14T22:13:20.000Z', 2, 4],
      ['1.2.0', 'Reports\n\nwith **markdown**', '2024-03-09T16:00:00.000Z', 3, 5],
      ['2.0.0-beta.1', null, '2024-07-03T09:46:40.000Z', 3, 5],
    ])
    const text = JSON.stringify(out)
    expect(text).not.toContain('top-secret-token-value')
    expect(text).not.toContain('plain-env-value')
  })
})

describe('import restores the version history', () => {
  it('round trip: same semver order, notes, dates, counts and snapshots', async () => {
    const { colId } = await versionedCollection()
    const before = await historyOf(colId)
    const file = JSON.stringify(await exportCollection(env, colId), null, 2)

    const ws2 = (await env.api.createWorkspace('Other')).id
    const imported = await env.api.importPostmanCollection(ws2, file)
    expect(imported.versionHistory).toEqual({ restored: 3, skipped: 0, notes: [] })
    const after = await historyOf(imported.collection.id)

    const strip = (v: (typeof before)[number]) => ({ version: v.version, notes: v.notes, createdAt: v.createdAt, folderCount: v.folderCount, requestCount: v.requestCount, snapshot: v.snapshot })
    expect(after.map(strip)).toEqual(before.map(strip))
    expect(after.map((v) => v.version)).toEqual(['2.0.0-beta.1', '1.2.0', '1.0.0'])
    for (const v of after) expect(v).toMatchObject({ workspaceId: ws2, collectionId: imported.collection.id })
  })

  it('a restored version can be compared and restored (replace and copy)', async () => {
    const { colId } = await versionedCollection()
    const ws2 = (await env.api.createWorkspace('Other')).id
    const imported = await env.api.importPostmanCollection(ws2, JSON.stringify(await exportCollection(env, colId)))
    const [beta, v12, v10] = await historyOf(imported.collection.id)

    const diff = diffSnapshots(v10!.snapshot, v12!.snapshot)
    expect(diff.summary).toMatchObject({ added: 1, removed: 0, changed: 0, unchanged: 4 })
    expect(diff.foldersAdded).toEqual(['Reports'])
    expect(diffSnapshots(v12!.snapshot, beta!.snapshot).requests).toEqual([])
    expect(beta!.snapshot.collectionDescription).toBe('Changed after 1.2.0')

    const copy = await env.api.restoreCollectionVersion(v10!.id, 'copy')
    expect(copy.name).toBe('Rich API (v1.0.0)')
    expect((await env.api.listRequests(copy.id)).map((r) => r.name).sort()).toEqual(['Create user', 'Form login', 'Get user', 'Upload'])

    await env.api.restoreCollectionVersion(v10!.id, 'replace')
    expect(await env.api.listRequests(imported.collection.id)).toHaveLength(4)
    expect((await env.api.listFolders(imported.collection.id)).map((f) => f.name).sort()).toEqual(['Admin', 'Users'])
  })

  it('a metadata-only export imports the collection but cannot restore versions (reported)', async () => {
    const { colId } = await versionedCollection()
    const out = await exportCollection(env, colId, { includeSnapshots: false })
    expect(out.info._slinger!.includesSnapshots).toBe(false)
    expect(out.info._slinger!.versions.every((v) => v.snapshot === undefined)).toBe(true)
    expect(out.info.version).toBe('2.0.0-beta.1')
    const imported = await env.api.importPostmanCollection(wsId, JSON.stringify(out))
    expect(imported.requests).toHaveLength(5)
    expect(imported.versionHistory!.restored).toBe(0)
    expect(imported.versionHistory!.skipped).toBe(3)
    expect(imported.versionHistory!.notes[0]).toMatch(/3 versions were exported without snapshots.*1\.0\.0, 1\.2\.0, 2\.0\.0-beta\.1/)
    expect(await env.api.listCollectionVersions(imported.collection.id)).toEqual([])
  })

  it('a Postman collection without the block imports as before (no versionHistory in the result)', async () => {
    const imported = await env.api.importPostmanCollection(wsId, JSON.stringify(RICH_COLLECTION))
    expect(imported.versionHistory).toBeUndefined()
    expect(await env.api.listCollectionVersions(imported.collection.id)).toEqual([])
  })

  it('a malformed block is ignored with a note; the collection is still imported', async () => {
    const { colId } = await versionedCollection()
    const good = await exportCollection(env, colId)
    const snapshot = good.info._slinger!.versions[0]!.snapshot!
    const cyclic: CollectionSnapshot = {
      ...snapshot,
      folders: [
        { id: 'a', parentFolderId: 'b', name: 'a', sortOrder: 0 },
        { id: 'b', parentFolderId: 'a', name: 'b', sortOrder: 0 },
      ],
      requests: [],
    }
    const orphan: CollectionSnapshot = { ...snapshot, requests: [{ ...snapshot.requests[0]!, folderId: 'nope' }] }
    const version = (patch: object) => ({ ...good.info._slinger!, versions: [{ ...good.info._slinger!.versions[0]!, ...patch }] })
    const cases: Array<[unknown, RegExp]> = [
      ['not an object', /malformed/],
      [{ formatVersion: 1 }, /malformed at versions/],
      [{ ...good.info._slinger!, formatVersion: 2 }, /format 2.*newer Slinger/],
      [version({ version: 'v1.0.0' }), /versions\.0\.version.*semantic version/],
      [version({ version: '1.0.0+build' }), /semantic version/],
      [version({ createdAt: 'yesterday' }), /createdAt.*ISO-8601/],
      [version({ notes: 'x'.repeat(10_001) }), /notes/],
      [version({ folderCount: -1 }), /folderCount/],
      [version({ snapshot: { collectionName: 'x' } }), /snapshot/],
      [version({ snapshot: cyclic }), /cycle/],
      [version({ snapshot: orphan }), /missing folder/],
      [{ ...good.info._slinger!, versions: Array.from({ length: 501 }, () => good.info._slinger!.versions[0]) }, /versions/],
    ]
    for (const [block, reason] of cases) {
      const file = JSON.stringify({ ...good, info: { ...good.info, _slinger: block } })
      const imported = await env.api.importPostmanCollection(wsId, file)
      expect(imported.requests.length, String(reason)).toBe(5)
      expect(imported.versionHistory!.restored).toBe(0)
      expect(imported.versionHistory!.notes.join(' '), String(reason)).toMatch(reason)
      expect(imported.versionHistory!.notes[0]).toMatch(/^Version history not restored: .*The collection itself was imported\.$/)
      expect(await env.api.listCollectionVersions(imported.collection.id)).toEqual([])
    }
  })

  it('a version listed twice in the file is restored once', async () => {
    const { colId } = await versionedCollection()
    const out = await exportCollection(env, colId)
    const block = out.info._slinger!
    out.info._slinger = { ...block, versions: [...block.versions, { ...block.versions[0]!, notes: 'impostor' }] }
    const imported = await env.api.importPostmanCollection(wsId, JSON.stringify(out))
    expect(imported.versionHistory).toMatchObject({ restored: 3, skipped: 1 })
    expect(imported.versionHistory!.notes).toEqual(['Version 1.0.0 appears more than once in the file; only the first was restored.'])
    expect((await historyOf(imported.collection.id)).find((v) => v.version === '1.0.0')!.notes).toBe('First release')
  })

  it('into a collection that already has versions: identical ones are skipped, different ones kept under a free label', async () => {
    const { colId } = await versionedCollection()
    const block = (await exportCollection(env, colId)).info._slinger!
    // Same collection again: every version already exists with the same content.
    expect(env.core.db.transaction(() => restoreVersionHistory(env.core.db, colId, block))()).toMatchObject({ restored: 0, skipped: 3 })

    const other = await env.api.createCollection(wsId, 'Other')
    await env.api.createCollectionVersion({ collectionId: other.id, version: '1.2.0', notes: 'mine' })
    await env.api.createCollectionVersion({ collectionId: other.id, version: '1.2.0-imported', notes: 'also mine' })
    const r = env.core.db.transaction(() => restoreVersionHistory(env.core.db, other.id, block))()!
    expect(r).toMatchObject({ restored: 3, skipped: 0 })
    expect(r.notes).toEqual(['Version 1.2.0 already exists with different content; the imported one was kept as 1.2.0-imported.2.'])
    expect((await env.api.listCollectionVersions(other.id)).map((v) => v.version)).toEqual([
      '2.0.0-beta.1', '1.2.0', '1.2.0-imported.2', '1.2.0-imported', '1.0.0',
    ])
  })

  it('an unexpected failure rolls back only the history, never the import', async () => {
    const { colId } = await versionedCollection()
    const block = (await exportCollection(env, colId)).info._slinger!
    const target = await env.api.createCollection(wsId, 'T')
    env.core.db.exec(`CREATE TEMP TRIGGER boom BEFORE INSERT ON collection_versions WHEN NEW.version = '1.2.0' BEGIN SELECT RAISE(ABORT, 'disk on fire'); END`)
    const r = env.core.db.transaction(() => restoreVersionHistory(env.core.db, target.id, block))()!
    expect(r).toMatchObject({ restored: 0, skipped: 3 })
    expect(r.notes).toEqual(['Version history not restored: disk on fire. The collection itself was imported.'])
    expect(await env.api.listCollectionVersions(target.id)).toEqual([])
  })
})

describe('parseSlingerBlock', () => {
  it('accepts the minimal valid block', () => {
    expect(parseSlingerBlock({ formatVersion: 1, versions: [] })).toEqual({ ok: true, versions: [] })
  })
  it('drops unknown keys from snapshots (only the known snapshot shape is stored)', () => {
    const r = parseSlingerBlock({
      formatVersion: 1,
      versions: [{ version: '1.0.0', notes: null, createdAt: '2026-01-01T00:00:00Z', folderCount: 0, requestCount: 0, snapshot: { collectionName: 'c', folders: [], requests: [], evil: 'x' } }],
    })
    expect(r.ok && r.versions[0]!.snapshot).toEqual({ collectionName: 'c', folders: [], requests: [] })
    expect(r.ok && r.versions[0]!.createdAt).toBe(1_767_225_600)
  })
})

describe('replace from a file restores its version history', () => {
  const exportText = async (colId: string, opts?: { includeSnapshots?: boolean }) => JSON.stringify(await exportCollection(env, colId, opts))

  it('adds the file versions next to the existing ones and the safety snapshot; clashes are kept as -imported', async () => {
    const { colId } = await versionedCollection()
    const before = await historyOf(colId)
    const file = await exportText(colId)

    // Another copy of the collection with its own, different 1.0.0.
    const ws2 = (await env.api.createWorkspace('Other')).id
    const target = (await env.api.importPostmanCollection(ws2, JSON.stringify(RICH_COLLECTION))).collection.id
    await env.api.createRequest({ workspaceId: ws2, collectionId: target, name: 'Local only', method: 'GET', url: 'https://local', documentJson: '{}' })
    await versionAt(1_600_000_000, target, '1.0.0', 'local release')

    const r = await env.api.replaceCollectionFromPostman(target, file, 'Rich API v2.0.0-beta.1.slinger_collection.json')
    expect(r.safetyVersion.version).toBe('1.0.1')
    expect(r.requests).toHaveLength(5)
    expect(r.versionHistory).toEqual({
      restored: 3,
      skipped: 0,
      notes: ['Version 1.0.0 already exists with different content; the imported one was kept as 1.0.0-imported.'],
    })
    const after = await historyOf(target)
    expect(after.map((v) => [v.version, v.notes])).toEqual([
      ['2.0.0-beta.1', null],
      ['1.2.0', 'Reports\n\nwith **markdown**'],
      ['1.0.1', 'Automatic snapshot before re-import from Rich API v2.0.0-beta.1.slinger_collection.json'],
      ['1.0.0', 'local release'],
      ['1.0.0-imported', 'First release'],
    ])
    // Imported versions are exact copies of the originals (dates and snapshots included).
    const byVersion = new Map(after.map((v) => [v.version, v]))
    for (const [label, original] of [['1.0.0-imported', before[2]!], ['1.2.0', before[1]!], ['2.0.0-beta.1', before[0]!]] as const) {
      expect(byVersion.get(label)!.snapshot).toEqual(original.snapshot)
      expect(byVersion.get(label)!.createdAt).toBe(original.createdAt)
    }
    // The safety snapshot holds the replaced content, so the replace can still be undone.
    expect(byVersion.get('1.0.1')!.snapshot.requests.map((r) => r.name)).toContain('Local only')
  })

  it('replacing a collection with its own export skips every version (identical) and only adds the safety snapshot', async () => {
    const { colId } = await versionedCollection()
    const r = await env.api.replaceCollectionFromPostman(colId, await exportText(colId), 'self.json')
    expect(r.safetyVersion.version).toBe('1.2.1')
    expect(r.versionHistory).toMatchObject({ restored: 0, skipped: 3 })
    expect(r.versionHistory!.notes).toEqual([
      'Version 1.0.0 is already in this collection; skipped.',
      'Version 1.2.0 is already in this collection; skipped.',
      'Version 2.0.0-beta.1 is already in this collection; skipped.',
    ])
    expect((await env.api.listCollectionVersions(colId)).map((v) => v.version)).toEqual(['2.0.0-beta.1', '1.2.1', '1.2.0', '1.0.0'])
  })

  it('a malformed or metadata-only history never blocks the replace', async () => {
    const { colId } = await versionedCollection()
    const broken = await exportCollection(env, colId)
    ;(broken.info as Record<string, unknown>)._slinger = { formatVersion: 1, versions: [{ version: 'nope' }] }
    const target = (await env.api.importPostmanCollection(wsId, JSON.stringify(RICH_COLLECTION))).collection.id
    const r = await env.api.replaceCollectionFromPostman(target, JSON.stringify(broken))
    expect(r.requests).toHaveLength(5)
    expect(r.versionHistory!.restored).toBe(0)
    expect(r.versionHistory!.notes[0]).toMatch(/^Version history not restored: .*malformed/)
    expect((await env.api.listCollectionVersions(target)).map((v) => v.version)).toEqual(['0.0.1'])

    const meta = await env.api.replaceCollectionFromPostman(target, await exportText(colId, { includeSnapshots: false }))
    expect(meta.versionHistory).toMatchObject({ restored: 0, skipped: 3 })
    expect((await env.api.listCollectionVersions(target)).map((v) => v.version)).toEqual(['0.0.2', '0.0.1'])
  })

  it('a plain Postman file (no block) replaces as before, without versionHistory', async () => {
    const target = (await env.api.importPostmanCollection(wsId, JSON.stringify(RICH_COLLECTION))).collection.id
    const r = await env.api.replaceCollectionFromPostman(target, JSON.stringify(RICH_COLLECTION))
    expect(r.versionHistory).toBeUndefined()
  })
})
