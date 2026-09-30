import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeCloud } from './fakeCloud'
import { converge, DOC, liveState, makeDevice, makePair, pendingCount, settle, type Device } from './harness'

let cloud: FakeCloud
let devices: Device[] = []
beforeEach(async () => {
  cloud = await new FakeCloud().start()
  devices = []
})
afterEach(async () => {
  devices.forEach((d) => d.cleanup())
  await cloud.stop()
})
const mk = (userId: string) => {
  const d = makeDevice(cloud, { userId })
  devices.push(d)
  return d
}

describe('publish and pull', () => {
  it('uploads a workspace and a second device links and downloads it', async () => {
    const user = cloud.createUser('ana@example.com')
    const a = mk(user.id)
    const col = await a.api.createCollection(a.workspace.id, 'Payments')
    const folder = await a.api.createFolder({ workspaceId: a.workspace.id, collectionId: col.id, name: 'Auth' })
    const req = await a.api.createRequest({ workspaceId: a.workspace.id, collectionId: col.id, folderId: folder.id, name: 'Login', method: 'POST', url: 'https://x/login', documentJson: DOC })
    const env = await a.api.createEnvironment(a.workspace.id, 'Prod')
    await a.api.upsertEnvironmentVariable({ environmentId: env.id, key: 'host', value: 'api.example.com', isSecret: false })
    await a.api.upsertEnvironmentVariable({ environmentId: env.id, key: 'token', value: 'hunter2-secret', isSecret: true })

    const status = await a.api.publishWorkspace(a.workspace.id)
    expect(status.linked).toBe(true)
    const done = await settle(a, a.workspace.id)
    expect(done.state).toBe('idle')
    expect(done.pendingChanges).toBe(0)
    expect(done.initialSyncPending).toBe(false)

    const remote = cloud.live(done.remoteWorkspaceId!)
    expect(remote.map((e) => e.type).sort()).toEqual(['collection', 'environment', 'environment_variable', 'environment_variable', 'folder', 'request'])
    // The secret value never reaches the server (bodies included).
    expect(JSON.stringify(cloud.requests)).not.toContain('hunter2-secret')

    const b = mk(user.id)
    const link = await b.api.linkRemoteWorkspace({ remoteWorkspaceId: done.remoteWorkspaceId!, localWorkspaceId: null })
    await settle(b, link.workspace.id)
    const bState = liveState(b, link.workspace.id)
    expect(bState.filter((s) => s.type === 'request').map((s) => s.id)).toEqual([req.id])
    const vars = bState.filter((s) => s.type === 'environment_variable')
    expect(vars).toHaveLength(2)
    const tokenVar = (await b.api.listEnvironmentVariables(env.id)).find((v) => v.key === 'token')!
    expect(tokenVar.secretMissing).toBe(true)
    expect(liveState(a, a.workspace.id)).toEqual(liveState(b, link.workspace.id))
  })
})

describe('extract a folder to a new collection', () => {
  it('syncs as new folders plus request moves and folder deletes; the other device converges without rejections', async () => {
    const ids: Record<string, string> = {}
    const p = await makePair(cloud, async (a, ws) => {
      const col = await a.api.createCollection(ws, 'Big')
      const drive = await a.api.createFolder({ workspaceId: ws, collectionId: col.id, name: 'Drive' })
      const sub = await a.api.createFolder({ workspaceId: ws, collectionId: col.id, parentFolderId: drive.id, name: 'Sub' })
      ids.drive = drive.id
      ids.create = (await a.api.createRequest({ workspaceId: ws, collectionId: col.id, folderId: drive.id, name: 'Create', method: 'POST', url: 'https://x/c', documentJson: DOC })).id
      ids.get = (await a.api.createRequest({ workspaceId: ws, collectionId: col.id, folderId: sub.id, name: 'Get', method: 'GET', url: 'https://x/g', documentJson: DOC })).id
      ids.other = (await a.api.createRequest({ workspaceId: ws, collectionId: col.id, folderId: null, name: 'Other', method: 'GET', url: 'https://x/o', documentJson: DOC })).id
    })
    devices.push(p.a, p.b)
    const r = await p.a.api.extractFolderToCollection({ folderId: ids.drive!, name: 'Drive', copyCollectionVariables: false })
    await converge(p)

    const a = await settle(p.a, p.wsA)
    expect(a.pendingChanges).toBe(0)
    expect(a.openConflicts).toBe(0)
    expect(a.lastError).toBeNull()
    expect(liveState(p.a, p.wsA)).toEqual(liveState(p.b, p.wsB))
    // On B: the moved requests (same ids) are in the new collection, the old folder tree is gone, the rest stays.
    const bRequests = await p.b.api.listRequests(r.collection.id)
    expect(bRequests.map((q) => q.id).sort()).toEqual([ids.create, ids.get].sort())
    const bFolders = await p.b.api.listFolders(r.collection.id)
    expect(bFolders.map((f) => f.name)).toEqual(['Sub'])
    expect(bRequests.find((q) => q.id === ids.get)!.folderId).toBe(bFolders[0]!.id)
    expect((await p.b.api.listFolders(r.sourceCollectionId)).map((f) => f.name)).toEqual([])
    expect((await p.b.api.listRequests(r.sourceCollectionId)).map((q) => q.id)).toEqual([ids.other])
  })
})
