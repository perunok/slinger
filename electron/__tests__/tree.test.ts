import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IpcError } from '../../shared/types'
import { DOC, makeEnv, NIL_UUID, scaffold, type TestEnv } from './helpers'

let env: TestEnv
beforeEach(() => {
  env = makeEnv()
})
afterEach(() => env.cleanup())

const rejects = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(
    () => null,
    (e) => e,
  )
  expect(err, `expected ${code}`).toBeInstanceOf(IpcError)
  expect((err as IpcError).code).toBe(code)
  return err as IpcError
}

async function mkRequest(workspaceId: string, collectionId: string, name: string, folderId: string | null = null) {
  return env.api.createRequest({ workspaceId, collectionId, folderId, name, method: 'get', url: 'http://x', documentJson: DOC })
}

describe('first launch', () => {
  it('creates a default "Personal" workspace, and ensureDefaultEnvironment is stable', async () => {
    const list = await env.api.listWorkspaces()
    expect(list.map((w) => w.name)).toEqual(['Personal'])
    const e1 = await env.api.ensureDefaultEnvironment(list[0]!.id)
    const e2 = await env.api.ensureDefaultEnvironment(list[0]!.id)
    expect(e1.id).toBe(e2.id)
    expect((await env.api.listEnvironments(list[0]!.id)).length).toBe(1)
  })
})

describe('soft delete', () => {
  it('hides deleted rows from every read but keeps them in the database', async () => {
    const { workspace, collection } = await scaffold(env)
    const folder = await env.api.createFolder({ workspaceId: workspace.id, collectionId: collection.id, name: 'F' })
    const req = await mkRequest(workspace.id, collection.id, 'R')
    const environment = await env.api.createEnvironment(workspace.id, 'Env')

    await env.api.deleteRequest(req.id)
    expect(await env.api.listRequests(collection.id)).toEqual([])
    await env.api.deleteFolder(folder.id)
    expect(await env.api.listFolders(collection.id)).toEqual([])
    await env.api.deleteEnvironment(environment.id)
    expect((await env.api.listEnvironments(workspace.id)).map((e) => e.id)).not.toContain(environment.id)
    await env.api.deleteCollection(collection.id)
    expect(await env.api.listCollections(workspace.id)).toEqual([])

    const row = env.core.db.prepare('SELECT deleted, version FROM requests WHERE id = ?').get(req.id) as { deleted: number; version: number }
    expect(row.deleted).toBe(1)
    expect(row.version).toBeGreaterThan(1) // soft delete bumps the version
    expect(env.core.db.prepare('SELECT COUNT(*) n FROM collections WHERE id = ?').get(collection.id)).toEqual({ n: 1 })
  })

  it('operations on deleted entities report not_found', async () => {
    const { workspace, collection } = await scaffold(env)
    const req = await mkRequest(workspace.id, collection.id, 'R')
    await env.api.deleteRequest(req.id)
    await rejects(env.api.renameRequest(req.id, 'x'), 'not_found')
    await rejects(env.api.deleteRequest(req.id), 'not_found')
    await rejects(
      env.api.updateRequest({ requestId: req.id, name: 'x', method: 'GET', url: '', documentJson: DOC, expectedVersion: req.version }),
      'not_found',
    )
    await env.api.deleteCollection(collection.id)
    await rejects(env.api.listRequests(collection.id), 'not_found')
    await rejects(mkRequest(workspace.id, collection.id, 'again'), 'not_found')
  })

  it('cascades workspace -> collections, folders, requests, environments, variables (one transaction)', async () => {
    const { workspace, collection } = await scaffold(env)
    const folder = await env.api.createFolder({ workspaceId: workspace.id, collectionId: collection.id, name: 'F' })
    const req = await mkRequest(workspace.id, collection.id, 'R', folder.id)
    const environment = await env.api.createEnvironment(workspace.id, 'Env')
    const v = await env.api.upsertEnvironmentVariable({ environmentId: environment.id, key: 'k', value: 'v', isSecret: false })
    const s = await env.api.upsertEnvironmentVariable({ environmentId: environment.id, key: 's', value: 'shh', isSecret: true })
    expect(env.secrets.entries.size).toBe(1)

    await env.api.deleteWorkspace(workspace.id)

    expect((await env.api.listWorkspaces()).map((w) => w.id)).not.toContain(workspace.id)
    const deletedOf = (table: string, id: string) =>
      (env.core.db.prepare(`SELECT deleted FROM ${table} WHERE id = ?`).get(id) as { deleted: number }).deleted
    expect(deletedOf('collections', collection.id)).toBe(1)
    expect(deletedOf('folders', folder.id)).toBe(1)
    expect(deletedOf('requests', req.id)).toBe(1)
    expect(deletedOf('environments', environment.id)).toBe(1)
    expect(deletedOf('environment_variables', v.id)).toBe(1)
    expect(deletedOf('environment_variables', s.id)).toBe(1)
    expect(env.secrets.entries.size).toBe(0) // keychain entries are purged too
    await rejects(env.api.listCollections(workspace.id), 'not_found')
  })

  it('cascades collection -> folders and requests, leaving siblings untouched', async () => {
    const { workspace, collection } = await scaffold(env)
    const other = await env.api.createCollection(workspace.id, 'Other')
    const folder = await env.api.createFolder({ workspaceId: workspace.id, collectionId: collection.id, name: 'F' })
    await mkRequest(workspace.id, collection.id, 'R', folder.id)
    const keep = await mkRequest(workspace.id, other.id, 'Keep')

    await env.api.deleteCollection(collection.id)

    expect(env.core.db.prepare('SELECT COUNT(*) n FROM requests WHERE collection_id = ? AND deleted = 0').get(collection.id)).toEqual({ n: 0 })
    expect(env.core.db.prepare('SELECT COUNT(*) n FROM folders WHERE collection_id = ? AND deleted = 0').get(collection.id)).toEqual({ n: 0 })
    expect((await env.api.listRequests(other.id)).map((r) => r.id)).toEqual([keep.id])
  })

  it('deleteFolder soft-deletes nested folders and their requests recursively', async () => {
    const { workspace, collection } = await scaffold(env)
    const a = await env.api.createFolder({ workspaceId: workspace.id, collectionId: collection.id, name: 'A' })
    const b = await env.api.createFolder({ workspaceId: workspace.id, collectionId: collection.id, parentFolderId: a.id, name: 'B' })
    const sibling = await env.api.createFolder({ workspaceId: workspace.id, collectionId: collection.id, name: 'Sibling' })
    await mkRequest(workspace.id, collection.id, 'in-a', a.id)
    await mkRequest(workspace.id, collection.id, 'in-b', b.id)
    const outside = await mkRequest(workspace.id, collection.id, 'in-sibling', sibling.id)

    await env.api.deleteFolder(a.id)

    expect((await env.api.listFolders(collection.id)).map((f) => f.id)).toEqual([sibling.id])
    expect((await env.api.listRequests(collection.id)).map((r) => r.id)).toEqual([outside.id])
  })
})

describe('optimistic concurrency', () => {
  it('updateRequest succeeds on the current version and bumps it', async () => {
    const { workspace, collection } = await scaffold(env)
    const req = await mkRequest(workspace.id, collection.id, 'R')
    expect(req.version).toBe(1)
    const updated = await env.api.updateRequest({ requestId: req.id, name: 'R2', method: 'post', url: 'http://y', documentJson: DOC, expectedVersion: 1 })
    expect(updated.version).toBe(2)
    expect(updated.method).toBe('POST')
    expect(updated.name).toBe('R2')
  })

  it('throws version_conflict with details on a stale version and leaves the row unchanged', async () => {
    const { workspace, collection } = await scaffold(env)
    const req = await mkRequest(workspace.id, collection.id, 'R')
    await env.api.updateRequest({ requestId: req.id, name: 'first', method: 'GET', url: 'u', documentJson: DOC, expectedVersion: 1 })
    const err = await rejects(
      env.api.updateRequest({ requestId: req.id, name: 'stale', method: 'GET', url: 'u', documentJson: DOC, expectedVersion: 1 }),
      'version_conflict',
    )
    expect(err.details).toMatchObject({ expectedVersion: 1, currentVersion: 2 })
    expect((await env.api.listRequests(collection.id))[0]!.name).toBe('first')
  })

  it('rename bumps the version, so a stale update after a rename conflicts', async () => {
    const { workspace, collection } = await scaffold(env)
    const req = await mkRequest(workspace.id, collection.id, 'R')
    const renamed = await env.api.renameRequest(req.id, 'Renamed')
    expect(renamed.version).toBe(2)
    await rejects(
      env.api.updateRequest({ requestId: req.id, name: 'x', method: 'GET', url: 'u', documentJson: DOC, expectedVersion: 1 }),
      'version_conflict',
    )
  })

  it('rejects invalid documentJson and bad expectedVersion', async () => {
    const { workspace, collection } = await scaffold(env)
    const req = await mkRequest(workspace.id, collection.id, 'R')
    await rejects(env.api.updateRequest({ requestId: req.id, name: 'x', method: 'GET', url: 'u', documentJson: '{oops', expectedVersion: 1 }), 'invalid_input')
    await rejects(env.api.updateRequest({ requestId: req.id, name: 'x', method: 'GET', url: 'u', documentJson: DOC, expectedVersion: 0 }), 'invalid_input')
  })

  it('bumps versions on collection/folder/workspace/environment renames', async () => {
    const { workspace, collection } = await scaffold(env)
    const folder = await env.api.createFolder({ workspaceId: workspace.id, collectionId: collection.id, name: 'F' })
    const environment = await env.api.createEnvironment(workspace.id, 'E')
    expect((await env.api.renameWorkspace(workspace.id, 'W2')).version).toBe(2)
    expect((await env.api.renameCollection(collection.id, 'C2')).version).toBe(2)
    expect((await env.api.renameFolder(folder.id, 'F2')).version).toBe(2)
    expect((await env.api.renameEnvironment(environment.id, 'E2')).version).toBe(2)
  })
})

describe('folders and ordering', () => {
  it('appends new siblings in order and returns them by sortOrder', async () => {
    const { workspace, collection } = await scaffold(env)
    const f1 = await env.api.createFolder({ workspaceId: workspace.id, collectionId: collection.id, name: '1' })
    const f2 = await env.api.createFolder({ workspaceId: workspace.id, collectionId: collection.id, name: '2' })
    const f3 = await env.api.createFolder({ workspaceId: workspace.id, collectionId: collection.id, name: '3' })
    expect([f1.sortOrder, f2.sortOrder, f3.sortOrder]).toEqual([0, 1, 2])
    expect((await env.api.listFolders(collection.id)).map((f) => f.name)).toEqual(['1', '2', '3'])
  })

  it('moveFolder reorders among siblings and only bumps the moved folder', async () => {
    const { workspace, collection } = await scaffold(env)
    const [a, b, c] = [
      await env.api.createFolder({ workspaceId: workspace.id, collectionId: collection.id, name: 'a' }),
      await env.api.createFolder({ workspaceId: workspace.id, collectionId: collection.id, name: 'b' }),
      await env.api.createFolder({ workspaceId: workspace.id, collectionId: collection.id, name: 'c' }),
    ] as const
    const moved = await env.api.moveFolder({ folderId: c.id, targetParentFolderId: null, targetIndex: 0 })
    expect(moved.version).toBe(2)
    const list = await env.api.listFolders(collection.id)
    expect(list.map((f) => f.name)).toEqual(['c', 'a', 'b'])
    expect(list.map((f) => f.sortOrder)).toEqual([0, 1, 2])
    expect(list.find((f) => f.id === a.id)!.version).toBe(1)
    expect(list.find((f) => f.id === b.id)!.version).toBe(1)
    // out-of-range index clamps to the end
    await env.api.moveFolder({ folderId: c.id, targetParentFolderId: null, targetIndex: 99 })
    expect((await env.api.listFolders(collection.id)).map((f) => f.name)).toEqual(['a', 'b', 'c'])
  })

  it('moveFolder nests into another folder', async () => {
    const { workspace, collection } = await scaffold(env)
    const a = await env.api.createFolder({ workspaceId: workspace.id, collectionId: collection.id, name: 'a' })
    const b = await env.api.createFolder({ workspaceId: workspace.id, collectionId: collection.id, name: 'b' })
    const moved = await env.api.moveFolder({ folderId: b.id, targetParentFolderId: a.id, targetIndex: 0 })
    expect(moved.parentFolderId).toBe(a.id)
  })

  it('rejects folder cycles: into itself, a child, and a deep descendant', async () => {
    const { workspace, collection } = await scaffold(env)
    const mk = (name: string, parentFolderId: string | null = null) =>
      env.api.createFolder({ workspaceId: workspace.id, collectionId: collection.id, parentFolderId, name })
    const a = await mk('a')
    const b = await mk('b', a.id)
    const c = await mk('c', b.id)
    const move = (folderId: string, target: string | null) =>
      env.api.moveFolder({ folderId, targetParentFolderId: target, targetIndex: 0 })

    await rejects(move(a.id, a.id), 'invalid_input')
    await rejects(move(a.id, b.id), 'invalid_input')
    const err = await rejects(move(a.id, c.id), 'invalid_input')
    expect(err.message).toMatch(/descendant/)
    // nothing changed
    const list = await env.api.listFolders(collection.id)
    expect(list.find((f) => f.id === a.id)).toMatchObject({ parentFolderId: null, version: 1 })
    // but moving a leaf up is fine
    expect((await move(c.id, null)).parentFolderId).toBeNull()
  })

  it('rejects cross-collection folder parents and unknown ids', async () => {
    const { workspace, collection } = await scaffold(env)
    const other = await env.api.createCollection(workspace.id, 'Other')
    const a = await env.api.createFolder({ workspaceId: workspace.id, collectionId: collection.id, name: 'a' })
    const x = await env.api.createFolder({ workspaceId: workspace.id, collectionId: other.id, name: 'x' })
    await rejects(env.api.createFolder({ workspaceId: workspace.id, collectionId: collection.id, parentFolderId: x.id, name: 'bad' }), 'invalid_input')
    await rejects(env.api.moveFolder({ folderId: a.id, targetParentFolderId: x.id, targetIndex: 0 }), 'invalid_input')
    await rejects(env.api.moveFolder({ folderId: NIL_UUID.replace('0000', '1111'), targetParentFolderId: null, targetIndex: 0 }), 'not_found')
  })

  it('moveRequest reorders within a container, into folders, and across collections', async () => {
    const { workspace, collection } = await scaffold(env)
    const other = await env.api.createCollection(workspace.id, 'Other')
    const folder = await env.api.createFolder({ workspaceId: workspace.id, collectionId: collection.id, name: 'F' })
    const r1 = await mkRequest(workspace.id, collection.id, 'r1')
    const r2 = await mkRequest(workspace.id, collection.id, 'r2')
    const r3 = await mkRequest(workspace.id, collection.id, 'r3')

    await env.api.moveRequest({ requestId: r3.id, targetCollectionId: collection.id, targetFolderId: null, targetIndex: 0 })
    expect((await env.api.listRequests(collection.id)).map((r) => r.name)).toEqual(['r3', 'r1', 'r2'])

    const inFolder = await env.api.moveRequest({ requestId: r1.id, targetCollectionId: collection.id, targetFolderId: folder.id, targetIndex: 0 })
    expect(inFolder.folderId).toBe(folder.id)

    const across = await env.api.moveRequest({ requestId: r2.id, targetCollectionId: other.id, targetFolderId: null, targetIndex: 0 })
    expect(across.collectionId).toBe(other.id)
    expect((await env.api.listRequests(other.id)).map((r) => r.id)).toEqual([r2.id])

    // folder must belong to the target collection
    await rejects(env.api.moveRequest({ requestId: r3.id, targetCollectionId: other.id, targetFolderId: folder.id, targetIndex: 0 }), 'invalid_input')
  })

  it('refuses to move requests between workspaces', async () => {
    const { collection, workspace } = await scaffold(env)
    const ws2 = await env.api.createWorkspace('Second')
    const col2 = await env.api.createCollection(ws2.id, 'C2')
    const r = await mkRequest(workspace.id, collection.id, 'r')
    await rejects(env.api.moveRequest({ requestId: r.id, targetCollectionId: col2.id, targetFolderId: null, targetIndex: 0 }), 'invalid_input')
  })
})
