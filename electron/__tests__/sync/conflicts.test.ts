import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SyncConflict } from '../../../shared/types'
import { FakeCloud } from './fakeCloud'
import { DOC, converge, liveState, makePair, pendingCount, type Device, type Pair } from './harness'

let cloud: FakeCloud
let pairs: Pair[] = []
beforeEach(async () => {
  cloud = await new FakeCloud().start()
  pairs = []
})
afterEach(async () => {
  for (const p of pairs) {
    p.a.cleanup()
    p.b.cleanup()
  }
  await cloud.stop()
})

interface Seed {
  col: string
  folder: string
  req: string
  env: string
  varId: string
}
async function pair(): Promise<Pair & { s: Seed }> {
  const s = {} as Seed
  const p = await makePair(cloud, async (a, ws) => {
    const col = await a.api.createCollection(ws, 'Payments')
    const folder = await a.api.createFolder({ workspaceId: ws, collectionId: col.id, name: 'Auth' })
    const req = await a.api.createRequest({ workspaceId: ws, collectionId: col.id, folderId: folder.id, name: 'Login', method: 'POST', url: 'https://x/login', documentJson: DOC })
    const env = await a.api.createEnvironment(ws, 'Prod')
    const v = await a.api.upsertEnvironmentVariable({ environmentId: env.id, key: 'host', value: 'a.example.com', isSecret: false })
    Object.assign(s, { col: col.id, folder: folder.id, req: req.id, env: env.id, varId: v.id })
  })
  pairs.push(p)
  return Object.assign(p, { s })
}

const conflicts = (d: Device, ws: string): Promise<SyncConflict[]> => d.api.listSyncConflicts(ws)
const version = async (d: Device, colId: string, reqId: string) => (await d.api.listRequests(colId)).find((r) => r.id === reqId)!

describe('non-conflicting concurrent edits merge automatically', () => {
  it('different groups of one entity merge; different entities never conflict', async () => {
    const p = await pair()
    // A moves the request to the collection root; B edits its content.
    await p.a.api.moveRequest({ requestId: p.s.req, targetCollectionId: p.s.col, targetFolderId: null, targetIndex: 0 })
    const bReq = await version(p.b, p.s.col, p.s.req)
    await p.b.api.updateRequest({ requestId: p.s.req, name: 'Login v2', method: 'POST', url: 'https://x/v2', documentJson: DOC, expectedVersion: bReq.version })
    await converge(p)
    for (const d of [[p.a, p.wsA], [p.b, p.wsB]] as const) {
      const r = (await d[0].api.listRequests(p.s.col))[0]!
      expect(r).toMatchObject({ name: 'Login v2', url: 'https://x/v2', folderId: null })
      expect(await conflicts(d[0], d[1])).toEqual([])
    }
    expect(liveState(p.a, p.wsA)).toEqual(liveState(p.b, p.wsB))
  })
})

describe('edit-edit conflicts', () => {
  async function conflicted() {
    const p = await pair()
    await p.a.api.renameRequest(p.s.req, 'From A')
    await p.b.api.renameRequest(p.s.req, 'From B')
    await p.a.core.sync.syncNow(p.wsA) // A wins the race
    await p.b.core.sync.syncNow(p.wsB) // B pulls, detects the clash
    const [c] = await conflicts(p.b, p.wsB)
    return { p, c: c! }
  }

  it('is detected on the second device, frozen (not pushed) and describes both sides', async () => {
    const { p, c } = await conflicted()
    expect(c).toMatchObject({ kind: 'edit_edit', entityType: 'request', label: 'From B', status: 'open' })
    expect(c.path).toEqual(['Payments', 'Auth', 'From B'])
    expect(c.allowedResolutions).toEqual(['keep_local', 'keep_remote', 'merge', 'duplicate'])
    const content = c.groups.find((g) => g.group === 'content')!
    expect(content.conflicting).toBe(true)
    expect(content.local).toContain('From B')
    expect(content.remote).toContain('From A')
    expect(c.groups.find((g) => g.group === 'location')!.conflicting).toBe(false)
    // B keeps its value locally; the server still has A's; the entity is not pushed while conflicted.
    expect((await version(p.b, p.s.col, p.s.req)).name).toBe('From B')
    expect(cloud.entity(p.s.req)!.data.name).toBe('From A')
    const status = await p.b.api.getSyncStatus(p.wsB)
    expect(status.openConflicts).toBe(1)
    await p.b.core.sync.syncNow(p.wsB)
    expect(cloud.entity(p.s.req)!.data.name).toBe('From A')
  })

  it('keep_local pushes B and A converges to it', async () => {
    const { p, c } = await conflicted()
    await p.b.api.resolveSyncConflict({ conflictId: c.id, resolution: 'keep_local' })
    await converge(p)
    expect(cloud.entity(p.s.req)!.data.name).toBe('From B')
    expect((await version(p.a, p.s.col, p.s.req)).name).toBe('From B')
    expect((await p.b.api.getSyncStatus(p.wsB)).openConflicts).toBe(0)
    expect(pendingCount(p.a, p.wsA) + pendingCount(p.b, p.wsB)).toBe(0)
  })

  it('keep_remote drops the local edit', async () => {
    const { p, c } = await conflicted()
    await p.b.api.resolveSyncConflict({ conflictId: c.id, resolution: 'keep_remote' })
    await converge(p)
    expect((await version(p.b, p.s.col, p.s.req)).name).toBe('From A')
    expect(cloud.entity(p.s.req)!.data.name).toBe('From A')
    expect(pendingCount(p.b, p.wsB)).toBe(0)
  })

  it('duplicate keeps both: the local version becomes a conflict copy', async () => {
    const { p, c } = await conflicted()
    await p.b.api.resolveSyncConflict({ conflictId: c.id, resolution: 'duplicate' })
    await converge(p)
    for (const d of [p.a, p.b]) {
      const names = (await d.api.listRequests(p.s.col)).map((r) => r.name).sort()
      expect(names).toEqual(['From A', 'From B (conflict copy)'])
    }
    expect(liveState(p.a, p.wsA)).toEqual(liveState(p.b, p.wsB))
  })

  it('merge takes per-group choices (name/content atomic; location merged automatically)', async () => {
    const p = await pair()
    const other = await p.a.api.createFolder({ workspaceId: p.wsA, collectionId: p.s.col, name: 'Other' })
    await p.a.core.sync.syncNow(p.wsA)
    await p.b.core.sync.syncNow(p.wsB)
    await p.a.api.renameRequest(p.s.req, 'A name')
    await p.b.api.renameRequest(p.s.req, 'B name')
    await p.b.api.moveRequest({ requestId: p.s.req, targetCollectionId: p.s.col, targetFolderId: other.id, targetIndex: 0 })
    await p.a.core.sync.syncNow(p.wsA)
    await p.b.core.sync.syncNow(p.wsB)
    const [c] = await conflicts(p.b, p.wsB)
    expect(c!.groups.filter((g) => g.conflicting).map((g) => g.group)).toEqual(['content'])
    await expect(p.b.api.resolveSyncConflict({ conflictId: c!.id, resolution: 'merge' })).rejects.toMatchObject({ code: 'invalid_input' })
    await p.b.api.resolveSyncConflict({ conflictId: c!.id, resolution: 'merge', fieldChoices: { content: 'remote' } })
    await converge(p)
    const r = (await p.a.api.listRequests(p.s.col))[0]!
    expect(r).toMatchObject({ name: 'A name', folderId: other.id }) // remote content + B's location
    expect(liveState(p.a, p.wsA)).toEqual(liveState(p.b, p.wsB))
  })

  it('refreshes an open conflict when the remote changes again, and auto-closes when both sides agree', async () => {
    const { p, c } = await conflicted()
    await p.a.api.renameRequest(p.s.req, 'A again')
    await p.a.core.sync.syncNow(p.wsA)
    await p.b.core.sync.syncNow(p.wsB)
    const [c2] = await conflicts(p.b, p.wsB)
    expect(c2!.id).toBe(c.id)
    expect(c2!.groups.find((g) => g.group === 'content')!.remote).toContain('A again')
    // B now types exactly what A has: the conflict stops being one and closes by itself.
    await p.b.api.renameRequest(p.s.req, 'A again')
    await converge(p)
    expect((await conflicts(p.b, p.wsB)).filter((x) => x.status === 'open')).toEqual([])
    expect((await version(p.b, p.s.col, p.s.req)).name).toBe('A again')
  })
})

describe('order conflicts resolve silently to the remote', () => {
  it('concurrent reorders never open a conflict', async () => {
    const p = await pair()
    const r2 = await p.a.api.createRequest({ workspaceId: p.wsA, collectionId: p.s.col, folderId: p.s.folder, name: 'Two', method: 'GET', url: 'u', documentJson: DOC })
    await converge(p)
    await p.a.api.moveRequest({ requestId: r2.id, targetCollectionId: p.s.col, targetFolderId: p.s.folder, targetIndex: 0 })
    await p.b.api.moveRequest({ requestId: p.s.req, targetCollectionId: p.s.col, targetFolderId: p.s.folder, targetIndex: 1 })
    await converge(p)
    expect(await conflicts(p.a, p.wsA)).toEqual([])
    expect(await conflicts(p.b, p.wsB)).toEqual([])
    expect(liveState(p.a, p.wsA)).toEqual(liveState(p.b, p.wsB))
  })
})

describe('delete versus edit', () => {
  it('remote delete + local edit: remote_deleted conflict; keep_local restores it remotely', async () => {
    const p = await pair()
    await p.a.api.deleteRequest(p.s.req)
    await p.a.core.sync.syncNow(p.wsA)
    await p.b.api.renameRequest(p.s.req, 'Edited on B')
    await p.b.core.sync.syncNow(p.wsB)
    const [c] = await conflicts(p.b, p.wsB)
    expect(c).toMatchObject({ kind: 'remote_deleted', entityType: 'request', allowedResolutions: ['keep_local', 'keep_remote'] })
    expect((await p.b.api.listRequests(p.s.col)).map((r) => r.name)).toEqual(['Edited on B']) // survives locally
    await p.b.api.resolveSyncConflict({ conflictId: c!.id, resolution: 'keep_local' })
    await converge(p)
    expect(cloud.entity(p.s.req)!.data.name).toBe('Edited on B')
    expect((await p.a.api.listRequests(p.s.col)).map((r) => r.name)).toEqual(['Edited on B'])
    expect(liveState(p.a, p.wsA)).toEqual(liveState(p.b, p.wsB))
  })

  it('remote delete + local edit: keep_remote deletes the local copy', async () => {
    const p = await pair()
    await p.a.api.deleteRequest(p.s.req)
    await p.a.core.sync.syncNow(p.wsA)
    await p.b.api.renameRequest(p.s.req, 'Edited on B')
    await p.b.core.sync.syncNow(p.wsB)
    const [c] = await conflicts(p.b, p.wsB)
    await p.b.api.resolveSyncConflict({ conflictId: c!.id, resolution: 'keep_remote' })
    await converge(p)
    expect(await p.b.api.listRequests(p.s.col)).toEqual([])
    expect(cloud.entity(p.s.req)).toBeUndefined()
    expect(pendingCount(p.b, p.wsB)).toBe(0)
  })

  it('a remote folder delete keeps locally edited descendants and their ancestors, deletes the rest', async () => {
    const p = await pair()
    const sibling = await p.a.api.createRequest({ workspaceId: p.wsA, collectionId: p.s.col, folderId: p.s.folder, name: 'Clean', method: 'GET', url: 'u', documentJson: DOC })
    await converge(p)
    await p.a.api.deleteFolder(p.s.folder)
    await p.a.core.sync.syncNow(p.wsA)
    await p.b.api.renameRequest(p.s.req, 'Edited on B')
    await p.b.core.sync.syncNow(p.wsB)
    const open = await conflicts(p.b, p.wsB)
    expect(open.map((c) => `${c.entityType}:${c.kind}`).sort()).toEqual(['folder:remote_deleted', 'request:remote_deleted'])
    const reqs = await p.b.api.listRequests(p.s.col)
    expect(reqs.map((r) => r.id)).toEqual([p.s.req]) // the untouched sibling is gone, the edited one survives
    void sibling
    // keep_local on the container restores it (and the surviving request) remotely
    const folderConflict = open.find((c) => c.entityType === 'folder')!
    await p.b.api.resolveSyncConflict({ conflictId: folderConflict.id, resolution: 'keep_local' })
    await converge(p)
    expect(cloud.entity(p.s.folder)).toBeDefined()
    expect(cloud.entity(p.s.req)!.data.name).toBe('Edited on B')
    expect((await p.b.api.getSyncStatus(p.wsB)).openConflicts).toBe(0)
    expect(liveState(p.a, p.wsA)).toEqual(liveState(p.b, p.wsB))
  })

  it('local delete + remote edit: local_deleted conflict keeps the delete unpushed; keep_remote restores', async () => {
    const p = await pair()
    await p.a.api.renameRequest(p.s.req, 'Edited on A')
    await p.a.core.sync.syncNow(p.wsA)
    await p.b.api.deleteRequest(p.s.req)
    await p.b.core.sync.syncNow(p.wsB)
    const [c] = await conflicts(p.b, p.wsB)
    expect(c).toMatchObject({ kind: 'local_deleted', entityType: 'request' })
    expect(cloud.entity(p.s.req)).toBeDefined() // the delete was NOT pushed
    await p.b.api.resolveSyncConflict({ conflictId: c!.id, resolution: 'keep_remote' })
    await converge(p)
    expect((await p.b.api.listRequests(p.s.col)).map((r) => r.name)).toEqual(['Edited on A'])
    expect(liveState(p.a, p.wsA)).toEqual(liveState(p.b, p.wsB))
  })

  it('local delete + remote edit: keep_local pushes the delete', async () => {
    const p = await pair()
    await p.a.api.renameRequest(p.s.req, 'Edited on A')
    await p.a.core.sync.syncNow(p.wsA)
    await p.b.api.deleteRequest(p.s.req)
    await p.b.core.sync.syncNow(p.wsB)
    const [c] = await conflicts(p.b, p.wsB)
    await p.b.api.resolveSyncConflict({ conflictId: c!.id, resolution: 'keep_local' })
    await converge(p)
    expect(cloud.entity(p.s.req)).toBeUndefined()
    expect(await p.a.api.listRequests(p.s.col)).toEqual([])
  })

  it('a folder deleted locally while another device adds a request inside: no data loss without a choice', async () => {
    const p = await pair()
    const added = await p.a.api.createRequest({ workspaceId: p.wsA, collectionId: p.s.col, folderId: p.s.folder, name: 'Added on A', method: 'GET', url: 'u', documentJson: DOC })
    await p.a.core.sync.syncNow(p.wsA)
    await p.b.api.deleteFolder(p.s.folder)
    await p.b.core.sync.syncNow(p.wsB)
    expect(cloud.entity(added.id)).toBeDefined()
    expect(cloud.entity(p.s.folder)).toBeDefined() // frozen: not deleted on the server
    const open = await conflicts(p.b, p.wsB)
    expect(open.length).toBeGreaterThan(0)
    expect(open.every((c) => c.kind === 'local_deleted')).toBe(true)
  })

  it('both sides delete the same entity: silent reconcile', async () => {
    const p = await pair()
    await p.a.api.deleteRequest(p.s.req)
    await p.b.api.deleteRequest(p.s.req)
    await converge(p)
    expect(await conflicts(p.a, p.wsA)).toEqual([])
    expect(await conflicts(p.b, p.wsB)).toEqual([])
    expect(pendingCount(p.b, p.wsB)).toBe(0)
  })
})

describe('unique keys and structure', () => {
  it('two devices add the same variable key: the local one is renamed to <key>_conflict', async () => {
    const p = await pair()
    await p.a.api.upsertEnvironmentVariable({ environmentId: p.s.env, key: 'token_url', value: 'from-a', isSecret: false })
    await p.b.api.upsertEnvironmentVariable({ environmentId: p.s.env, key: 'token_url', value: 'from-b', isSecret: false })
    await p.a.core.sync.syncNow(p.wsA)
    await p.b.core.sync.syncNow(p.wsB)
    await converge(p)
    const keys = (await p.b.api.listEnvironmentVariables(p.s.env)).map((v) => `${v.key}=${v.value}`).sort()
    expect(keys).toEqual(['host=a.example.com', 'token_url=from-a', 'token_url_conflict=from-b'])
    const info = (await p.b.api.listSyncConflicts(p.wsB, true)).find((c) => c.kind === 'duplicate_key')
    expect(info).toMatchObject({ status: 'auto_resolved', allowedResolutions: [] })
    expect(liveState(p.a, p.wsA)).toEqual(liveState(p.b, p.wsB))
  })

  it('folder moves that would form a cycle across devices are undone locally (structure wins)', async () => {
    const p = await pair()
    const g = await p.a.api.createFolder({ workspaceId: p.wsA, collectionId: p.s.col, name: 'G' })
    await converge(p)
    await p.a.api.moveFolder({ folderId: p.s.folder, targetParentFolderId: g.id, targetIndex: 0 }) // F into G
    await p.b.api.moveFolder({ folderId: g.id, targetParentFolderId: p.s.folder, targetIndex: 0 }) // G into F
    await converge(p)
    const foldersA = await p.a.api.listFolders(p.s.col)
    const foldersB = await p.b.api.listFolders(p.s.col)
    expect(foldersA.map((f) => [f.id, f.parentFolderId])).toEqual(foldersB.map((f) => [f.id, f.parentFolderId]))
    // no cycle: at least one of them has no parent
    expect(foldersA.some((f) => f.parentFolderId === null)).toBe(true)
    expect(liveState(p.a, p.wsA)).toEqual(liveState(p.b, p.wsB))
  })
})
