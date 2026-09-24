import { beforeEach, describe, expect, it } from 'vitest'
import { IpcError } from '../../shared/types'
import type { HttpRequestInput } from '../../shared/types'
import { createMockBackend } from './mockBackend'

let api: ReturnType<typeof createMockBackend>

beforeEach(() => {
  api = createMockBackend({ latencyMs: 0, seed: false })
})

async function setup() {
  const ws = await api.createWorkspace('W')
  const col = await api.createCollection(ws.id, 'C')
  return { ws, col }
}

const doc = (extra: object = {}) => JSON.stringify({ headers: [], ...extra })

async function mkRequest(wsId: string, colId: string, name: string, folderId: string | null = null) {
  return api.createRequest({ workspaceId: wsId, collectionId: colId, folderId, name, method: 'get', url: '', documentJson: doc() })
}

const run = (overrides: Partial<HttpRequestInput> = {}): HttpRequestInput => ({
  method: 'GET',
  url: 'https://mock.slinger.local/json',
  headers: [],
  auth: { kind: 'none' },
  body: { mode: 'none' },
  workspaceId: 'w',
  ...overrides,
})

const rejects = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(IpcError)
    return e as IpcError
  }
  throw new Error('expected rejection')
}

describe('CRUD and cascade', () => {
  it('creates, renames and cascades deletes', async () => {
    const { ws, col } = await setup()
    const f1 = await api.createFolder({ workspaceId: ws.id, collectionId: col.id, name: 'A' })
    const f2 = await api.createFolder({ workspaceId: ws.id, collectionId: col.id, parentFolderId: f1.id, name: 'B' })
    await mkRequest(ws.id, col.id, 'r1', f2.id)
    await mkRequest(ws.id, col.id, 'r2')
    expect((await api.renameFolder(f1.id, 'A2')).name).toBe('A2')
    await api.deleteFolder(f1.id)
    expect(await api.listFolders(col.id)).toEqual([])
    expect((await api.listRequests(col.id)).map((r) => r.name)).toEqual(['r2'])

    const env = await api.ensureDefaultEnvironment(ws.id)
    await api.upsertEnvironmentVariable({ environmentId: env.id, key: 'a', value: '1', isSecret: false })
    await api.createCollectionVersion({ collectionId: col.id, version: '1.0.0' })
    await api.deleteWorkspace(ws.id)
    expect(await api.listWorkspaces()).toEqual([])
    expect((await rejects(api.listCollections(ws.id))).code).toBe('not_found')
    expect((await rejects(api.listEnvironmentVariables(env.id))).code).toBe('not_found')
  })

  it('does not leak mutable state', async () => {
    const { ws } = await setup()
    const list = await api.listCollections(ws.id)
    list[0].name = 'hacked'
    expect((await api.listCollections(ws.id))[0].name).toBe('C')
  })

  it('uses unix seconds and uuid-like ids', async () => {
    const { ws } = await setup()
    expect(ws.createdAt).toBeLessThan(1e11)
    expect(ws.id).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('ordering and moves', () => {
  it('appends with increasing sortOrder and reorders within a container', async () => {
    const { ws, col } = await setup()
    const [a, b, c] = [await mkRequest(ws.id, col.id, 'a'), await mkRequest(ws.id, col.id, 'b'), await mkRequest(ws.id, col.id, 'c')]
    expect([a, b, c].map((r) => r.sortOrder)).toEqual([0, 1, 2])
    await api.moveRequest({ requestId: c.id, targetCollectionId: col.id, targetFolderId: null, targetIndex: 0 })
    expect((await api.listRequests(col.id)).map((r) => [r.name, r.sortOrder])).toEqual([['c', 0], ['a', 1], ['b', 2]])
    // index counts after removal: moving 'c' to index 2 puts it last
    await api.moveRequest({ requestId: c.id, targetCollectionId: col.id, targetFolderId: null, targetIndex: 2 })
    expect((await api.listRequests(col.id)).map((r) => r.name)).toEqual(['a', 'b', 'c'])
  })

  it('reparents requests and renumbers the old container', async () => {
    const { ws, col } = await setup()
    const f = await api.createFolder({ workspaceId: ws.id, collectionId: col.id, name: 'F' })
    const a = await mkRequest(ws.id, col.id, 'a')
    await mkRequest(ws.id, col.id, 'b')
    const moved = await api.moveRequest({ requestId: a.id, targetCollectionId: col.id, targetFolderId: f.id, targetIndex: 5 })
    expect(moved.folderId).toBe(f.id)
    expect(moved.sortOrder).toBe(0)
    const root = (await api.listRequests(col.id)).filter((r) => r.folderId === null)
    expect(root.map((r) => [r.name, r.sortOrder])).toEqual([['b', 0]])
  })

  it('moves folders and rejects cycles', async () => {
    const { ws, col } = await setup()
    const a = await api.createFolder({ workspaceId: ws.id, collectionId: col.id, name: 'a' })
    const b = await api.createFolder({ workspaceId: ws.id, collectionId: col.id, parentFolderId: a.id, name: 'b' })
    const c = await api.createFolder({ workspaceId: ws.id, collectionId: col.id, name: 'c' })
    expect((await rejects(api.moveFolder({ folderId: a.id, targetParentFolderId: b.id, targetIndex: 0 }))).code).toBe('invalid_input')
    expect((await rejects(api.moveFolder({ folderId: a.id, targetParentFolderId: a.id, targetIndex: 0 }))).code).toBe('invalid_input')
    const moved = await api.moveFolder({ folderId: c.id, targetParentFolderId: a.id, targetIndex: 0 })
    expect(moved.parentFolderId).toBe(a.id)
    const inA = (await api.listFolders(col.id)).filter((f) => f.parentFolderId === a.id)
    expect(inA.map((f) => [f.name, f.sortOrder])).toEqual([['c', 0], ['b', 1]])
  })
})

describe('versions and conflicts', () => {
  it('rejects stale updates with version_conflict', async () => {
    const { ws, col } = await setup()
    const r = await mkRequest(ws.id, col.id, 'r')
    const u = await api.updateRequest({ requestId: r.id, name: 'r', method: 'POST', url: 'x', documentJson: doc(), expectedVersion: 1 })
    expect(u.version).toBe(2)
    const err = await rejects(api.updateRequest({ requestId: r.id, name: 'r', method: 'GET', url: '', documentJson: doc(), expectedVersion: 1 }))
    expect(err.code).toBe('version_conflict')
    expect(err.details).toEqual({ currentVersion: 2 })
  })
})

describe('secrets', () => {
  it('masks, reveals and keeps the secret on edit', async () => {
    const { ws } = await setup()
    const env = await api.createEnvironment(ws.id, 'E')
    const v = await api.upsertEnvironmentVariable({ environmentId: env.id, key: 'tok', value: 's3cret', isSecret: true })
    expect(v).toMatchObject({ value: null, maskedValue: '••••••••', isSecret: true })
    expect(JSON.stringify(await api.listEnvironmentVariables(env.id))).not.toContain('s3cret')
    expect(await api.revealEnvironmentVariable(v.id)).toBe('s3cret')

    await api.upsertEnvironmentVariable({ environmentId: env.id, key: 'tok2', value: '', isSecret: true, variableId: v.id })
    await api.upsertEnvironmentVariable({ environmentId: env.id, key: 'tok2', value: '••••••••', isSecret: true, variableId: v.id })
    expect(await api.revealEnvironmentVariable(v.id)).toBe('s3cret')

    expect((await rejects(api.upsertEnvironmentVariable({ environmentId: env.id, key: 'tok2', value: '', isSecret: false, variableId: v.id }))).code).toBe('invalid_input')
    const plain = await api.upsertEnvironmentVariable({ environmentId: env.id, key: 'tok2', value: 'open', isSecret: false, variableId: v.id })
    expect(plain).toMatchObject({ value: 'open', maskedValue: null })
  })

  it('lists variables ordered by key', async () => {
    const { ws } = await setup()
    const env = await api.createEnvironment(ws.id, 'E')
    for (const key of ['b', 'c', 'a']) await api.upsertEnvironmentVariable({ environmentId: env.id, key, value: '', isSecret: false })
    expect((await api.listEnvironmentVariables(env.id)).map((v) => v.key)).toEqual(['a', 'b', 'c'])
  })
})

describe('http and history', () => {
  it('serves canned routes and records history', async () => {
    const res = await api.executeHttpRequest(run({ requestName: 'Sample', workspaceId: 'w1' }))
    expect(res.status).toBe(200)
    expect(JSON.parse(res.bodyText ?? '')).toHaveProperty('data.user.id', 42)
    await api.executeHttpRequest(run({ url: 'https://mock.slinger.local/404', workspaceId: 'w1' }))
    const hist = await api.listHistory('w1')
    expect(hist).toHaveLength(2)
    expect(hist[0]).toMatchObject({ statusCode: 404, ok: false })
    expect(hist[1]).toMatchObject({ requestName: 'Sample', ok: true })
    expect(await api.listHistory('w1', 1)).toHaveLength(1)
    await api.deleteHistoryEntry(hist[0].id)
    expect(await api.listHistory('w1')).toHaveLength(1)
    await api.clearHistory('w1')
    expect(await api.listHistory('w1')).toEqual([])
  })

  it('echoes request details, adding auth and content type', async () => {
    const res = await api.executeHttpRequest(
      run({
        method: 'POST',
        url: 'https://mock.slinger.local/echo',
        auth: { kind: 'bearer', bearer: { token: 'abc' } },
        body: { mode: 'raw', raw: { content: '{"a":1}', contentType: 'application/json' } },
      }),
    )
    const echoed = JSON.parse(res.bodyText ?? '') as { body: string; headers: Record<string, string> }
    expect(echoed.body).toBe('{"a":1}')
    expect(echoed.headers.Authorization).toBe('Bearer abc')
    expect(echoed.headers['Content-Type']).toBe('application/json')
  })

  it('returns binary routes as base64 and cookies as separate headers', async () => {
    const png = await api.executeHttpRequest(run({ url: 'https://mock.slinger.local/png' }))
    expect(png.bodyText).toBeNull()
    expect(png.bodyBase64).toBeTruthy()
    const cookies = await api.executeHttpRequest(run({ url: 'https://mock.slinger.local/cookies' }))
    expect(cookies.headers.filter((h) => h.key === 'Set-Cookie')).toHaveLength(2)
  })

  it('cancels /slow with network_error', async () => {
    const pending = api.executeHttpRequest(run({ url: 'https://mock.slinger.local/slow', requestRunId: 'r1', workspaceId: 'w2' }))
    const assertion = rejects(pending)
    await api.cancelHttpRequest('r1')
    const err = await assertion
    expect(err).toMatchObject({ code: 'network_error', message: 'Request cancelled' })
    expect((await api.listHistory('w2'))[0]).toMatchObject({ ok: false, statusCode: null, errorMessage: 'Request cancelled' })
  })

  it('honours timeoutMs', async () => {
    const err = await rejects(api.executeHttpRequest(run({ url: 'https://mock.slinger.local/slow', timeoutMs: 20 })))
    expect(err.code).toBe('network_error')
    expect(err.message).toMatch(/timed out/)
  })
})

describe('collection versions', () => {
  it('creates, sorts, and rejects invalid or duplicate versions', async () => {
    const { col } = await setup()
    await api.createCollectionVersion({ collectionId: col.id, version: '1.0.0', notes: 'first' })
    await api.createCollectionVersion({ collectionId: col.id, version: '1.10.0' })
    await api.createCollectionVersion({ collectionId: col.id, version: '1.10.0-beta.1' })
    expect((await rejects(api.createCollectionVersion({ collectionId: col.id, version: '1.0.0' }))).code).toBe('invalid_input')
    expect((await rejects(api.createCollectionVersion({ collectionId: col.id, version: 'v1' }))).code).toBe('invalid_input')
    expect((await api.listCollectionVersions(col.id)).map((v) => v.version)).toEqual(['1.10.0', '1.10.0-beta.1', '1.0.0'])
  })

  it('restores with replace (same ids) and copy (fresh ids)', async () => {
    const { ws, col } = await setup()
    const f = await api.createFolder({ workspaceId: ws.id, collectionId: col.id, name: 'F' })
    const r = await mkRequest(ws.id, col.id, 'orig', f.id)
    const v = await api.createCollectionVersion({ collectionId: col.id, version: '1.0.0' })
    expect(v).toMatchObject({ folderCount: 1, requestCount: 1 })
    await api.renameRequest(r.id, 'changed')
    await mkRequest(ws.id, col.id, 'extra')

    const copy = await api.restoreCollectionVersion(v.id, 'copy')
    expect(copy.name).toBe('C (v1.0.0)')
    expect(copy.id).not.toBe(col.id)
    const copied = await api.listRequests(copy.id)
    expect(copied.map((x) => x.name)).toEqual(['orig'])
    expect(copied[0].id).not.toBe(r.id)
    expect((await api.listRequests(col.id)).map((x) => x.name).sort()).toEqual(['changed', 'extra'])

    await api.restoreCollectionVersion(v.id, 'replace')
    const live = await api.listRequests(col.id)
    expect(live.map((x) => [x.id, x.name])).toEqual([[r.id, 'orig']])
    expect(live[0].version).toBeGreaterThan(r.version)
    expect((await api.listFolders(col.id))[0].id).toBe(f.id)

    const detail = await api.getCollectionVersion(v.id)
    expect(detail.snapshot.requests).toHaveLength(1)
    await api.deleteCollectionVersion(v.id)
    expect(await api.listCollectionVersions(col.id)).toEqual([])
  })
})

describe('postman import', () => {
  const sample = {
    info: { name: ' Sample ' },
    item: [
      { name: 'Root req', request: { method: 'post', url: { host: ['api', 'example', 'com'], path: ['v1', 'x'] }, header: [{ key: 'A', value: 'b' }] } },
      { name: 'Folder', item: [{ name: 'Nested', request: { method: 'GET', url: { raw: 'https://x.test/n' }, description: 'hi' } }, { name: 'Sub', item: [{ request: { url: 'u' } }] }] },
    ],
  }

  it('builds collection, folders and documents like the Rust importer', async () => {
    const { ws } = await setup()
    const res = await api.importPostmanCollection(ws.id, JSON.stringify(sample))
    expect(res.collection.name).toBe('Sample')
    expect(res.folders.map((f) => [f.name, f.parentFolderId === null])).toEqual([['Folder', true], ['Sub', false]])
    const [root, nested, unnamed] = res.requests
    expect(root).toMatchObject({ method: 'POST', url: 'api.example.com/v1/x', folderId: null, sortOrder: 0 })
    expect(nested).toMatchObject({ folderId: res.folders[0].id, url: 'https://x.test/n' })
    expect(unnamed).toMatchObject({ name: 'Untitled Request', folderId: res.folders[1].id })
    const parsed = JSON.parse(root.documentJson)
    expect(parsed.headers).toEqual([{ key: 'A', value: 'b' }])
    expect(parsed).toHaveProperty('source.name', 'Root req')
    expect(parsed.scripts).toEqual([])
    expect(await api.listRequests(res.collection.id)).toHaveLength(3)
  })

  it('rejects invalid input', async () => {
    const { ws } = await setup()
    expect((await rejects(api.importPostmanCollection(ws.id, '{nope'))).code).toBe('invalid_input')
    expect((await rejects(api.importPostmanCollection(ws.id, '{"item":[]}'))).code).toBe('invalid_input')
    expect(await api.listCollections(ws.id)).toHaveLength(1)
  })
})

describe('test hooks and seed', () => {
  it('failNext rejects once, failAlways until cleared, and calls are logged', async () => {
    api.failNext('listWorkspaces', { code: 'io_error', message: 'boom' })
    expect(await rejects(api.listWorkspaces())).toMatchObject({ code: 'io_error', message: 'boom' })
    await expect(api.listWorkspaces()).resolves.toEqual([])
    api.failAlways('getAppVersion')
    await rejects(api.getAppVersion())
    await rejects(api.getAppVersion())
    api.failAlways(null)
    expect(await api.getAppVersion()).toBe('0.0.0-dev')
    expect(api.calls.filter((c) => c.method === 'getAppVersion')).toHaveLength(3)
  })

  it('seeds demo data and reset() restores it', async () => {
    const seeded = createMockBackend({ latencyMs: 0 })
    const [personal, team] = await seeded.listWorkspaces()
    expect([personal.name, team.name]).toEqual(['Personal', 'Team Sandbox'])
    const cols = await seeded.listCollections(personal.id)
    expect(cols.map((c) => c.name)).toEqual(['Demo API', 'Petstore (imported)'])
    expect(await seeded.listCollectionVersions(cols[0].id)).toHaveLength(1)
    const envs = await seeded.listEnvironments(personal.id)
    expect(envs.map((e) => e.name)).toEqual(['Local', 'Staging'])
    expect((await seeded.listHistory(personal.id)).length).toBeGreaterThan(0)
    await seeded.deleteWorkspace(personal.id)
    seeded.reset()
    expect(await seeded.listWorkspaces()).toHaveLength(2)
  })
})
