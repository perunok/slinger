import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeCloud } from './fakeCloud'
import { DOC, makeDevice, settle, type Device } from './harness'

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

async function synced() {
  const user = cloud.createUser(`u${Math.random().toString(36).slice(2)}@example.com`)
  const d = makeDevice(cloud, { userId: user.id })
  devices.push(d)
  const ws = d.workspace.id
  const col = await d.api.createCollection(ws, 'Shop')
  const folder = await d.api.createFolder({ workspaceId: ws, collectionId: col.id, name: 'Admin' })
  const reqs: string[] = []
  for (let i = 0; i < 4; i++) {
    reqs.push((await d.api.createRequest({ workspaceId: ws, collectionId: col.id, folderId: i < 2 ? folder.id : null, name: `Req ${i}`, method: 'GET', url: `https://x/${i}`, documentJson: DOC })).id)
  }
  await d.api.publishWorkspace(ws)
  await settle(d, ws)
  return { d, ws, col: col.id, folder: folder.id, reqs }
}
const pending = (d: Device, ws: string) => d.core.sync.engine.status(ws).pendingChanges
const allRequests = async (d: Device, ws: string) => (await Promise.all((await d.api.listCollections(ws)).map((c) => d.api.listRequests(c.id)))).flat()
const reqName = async (d: Device, ws: string, id: string) => (await allRequests(d, ws)).find((r) => r.id === id)?.name

describe('discarding chosen pending changes', () => {
  it('an edit goes back to the cloud copy and stops counting', async () => {
    const { d, ws, reqs } = await synced()
    await d.api.renameRequest(reqs[0]!, 'Changed')
    expect(pending(d, ws)).toBe(1)
    const status = await d.api.discardPendingItems(ws, [{ entityType: 'request', entityId: reqs[0]! }])
    expect(status.pendingChanges).toBe(0)
    expect(await reqName(d, ws, reqs[0]!)).toBe('Req 0')
  })

  it('a new collection is removed together with what was created in it', async () => {
    const { d, ws } = await synced()
    const col = await d.api.createCollection(ws, 'Draft')
    const folder = await d.api.createFolder({ workspaceId: ws, collectionId: col.id, name: 'f' })
    await d.api.createRequest({ workspaceId: ws, collectionId: col.id, folderId: folder.id, name: 'r', method: 'GET', url: 'https://x', documentJson: DOC })
    expect(pending(d, ws)).toBe(3)
    const status = await d.api.discardPendingItems(ws, [{ entityType: 'collection', entityId: col.id }])
    expect(status.pendingChanges).toBe(0)
    expect((await d.api.listCollections(ws)).map((c) => c.name)).toEqual(['Shop'])
    expect((await allRequests(d, ws)).map((r) => r.name).sort()).toEqual(['Req 0', 'Req 1', 'Req 2', 'Req 3'])
  })

  it('discarding the delete of a collection brings back everything inside it', async () => {
    const { d, ws, col } = await synced()
    await d.api.deleteCollection(col)
    expect(pending(d, ws)).toBe(1)
    const status = await d.api.discardPendingItems(ws, [{ entityType: 'collection', entityId: col }])
    expect(status.pendingChanges).toBe(0)
    expect((await d.api.listCollections(ws)).map((c) => c.name)).toEqual(['Shop'])
    expect((await allRequests(d, ws)).length).toBe(4)
    expect((await d.api.listFolders(col)).length).toBe(1)
  })

  it('discarding a deleted folder restores its requests; other waiting changes stay', async () => {
    const { d, ws, col, folder, reqs } = await synced()
    await d.api.renameRequest(reqs[3]!, 'Keep this edit')
    await d.api.deleteFolder(folder)
    expect(pending(d, ws)).toBe(2) // the folder (its two requests go with it) and the rename
    const status = await d.api.discardPendingItems(ws, [{ entityType: 'folder', entityId: folder }])
    expect(status.pendingChanges).toBe(1)
    expect(await d.api.listFolders(col)).toHaveLength(1)
    expect((await allRequests(d, ws)).map((r) => r.name).sort()).toEqual(['Keep this edit', 'Req 0', 'Req 1', 'Req 2'])
  })

  it('leaves everything else waiting and ignores items that are not pending', async () => {
    const { d, ws, reqs, col } = await synced()
    await d.api.renameRequest(reqs[0]!, 'A')
    await d.api.renameRequest(reqs[1]!, 'B')
    const status = await d.api.discardPendingItems(ws, [
      { entityType: 'request', entityId: reqs[0]! },
      { entityType: 'request', entityId: reqs[2]! }, // not pending
      { entityType: 'collection', entityId: col }, // not pending
    ])
    expect(status.pendingChanges).toBe(1)
    expect(await reqName(d, ws, reqs[1]!)).toBe('B')
    expect(await reqName(d, ws, reqs[0]!)).toBe('Req 0')
  })

  it('the discarded changes are not uploaded', async () => {
    const { d, ws, reqs } = await synced()
    await d.api.renameRequest(reqs[0]!, 'Nope')
    const extra = await d.api.createCollection(ws, 'Nope too')
    await d.api.discardPendingItems(ws, [
      { entityType: 'request', entityId: reqs[0]! },
      { entityType: 'collection', entityId: extra.id },
    ])
    await settle(d, ws)
    const remote = cloud.live((await d.api.getSyncStatus(ws)).remoteWorkspaceId!)
    expect(remote.filter((e) => e.type === 'collection').length).toBe(1)
    expect(JSON.stringify(remote)).not.toContain('Nope')
  })

  it('refuses a workspace that is not linked', async () => {
    const user = cloud.createUser('x@example.com')
    const d = makeDevice(cloud, { userId: user.id })
    devices.push(d)
    await expect(d.api.discardPendingItems(d.workspace.id, [])).rejects.toMatchObject({ code: 'sync_blocked' })
  })
})
