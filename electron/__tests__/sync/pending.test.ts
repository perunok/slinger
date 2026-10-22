import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../../db/database'
import { buildOps } from '../../sync/outbox'
import { pendingCount, pendingOps } from '../../sync/pending'
import { FakeCloud } from './fakeCloud'
import { mulberry32, randomOp } from './fuzzKit'
import { DOC, makePair, makeDevice, settle, type Device, type Pair } from './harness'

let cloud: FakeCloud
let devices: Device[] = []
let pair: Pair | null = null
beforeEach(async () => {
  cloud = await new FakeCloud().start()
  devices = []
  pair = null
})
afterEach(async () => {
  devices.forEach((d) => d.cleanup())
  pair?.a.cleanup()
  pair?.b.cleanup()
  await cloud.stop()
})

/** A linked, fully synced workspace with a collection holding folders and requests, on one device. */
async function synced(): Promise<{ d: Device; ws: string; col: string; folder: string; reqs: string[] }> {
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
const kinds = (d: Device, ws: string) => pendingOps(d.db, ws).map((o) => `${o.kind} ${o.type}`).sort()

describe('pending changes (the sync chip badge)', () => {
  it('a synced workspace has none; adding a collection counts, deleting it again brings the count back down', async () => {
    const { d, ws } = await synced()
    expect(pending(d, ws)).toBe(0)
    const col = await d.api.createCollection(ws, 'Draft')
    expect(pending(d, ws)).toBe(1)
    const req = await d.api.createRequest({ workspaceId: ws, collectionId: col.id, name: 'r', method: 'GET', url: 'https://x', documentJson: DOC })
    expect(pending(d, ws)).toBe(2)
    await d.api.deleteCollection(col.id)
    // Created and deleted before it ever reached the cloud: nothing to upload.
    expect(pending(d, ws)).toBe(0)
    expect(await d.api.listSyncPending(ws)).toEqual([])
    expect(req.id).toBeTruthy()
  })

  it('deleting a collection the cloud has is ONE change, not one per request', async () => {
    const { d, ws, col } = await synced()
    await d.api.deleteCollection(col)
    expect(pending(d, ws)).toBe(1)
    expect(kinds(d, ws)).toEqual(['deleted collection'])
    expect((await d.api.listSyncPending(ws)).map((i) => [i.change, i.entityType, i.path.join(' / ')])).toEqual([['deleted', 'collection', 'Shop']])
  })

  it('deleting a folder counts the folder only; a request deleted inside a live folder counts itself', async () => {
    const { d, ws, reqs, folder } = await synced()
    await d.api.deleteRequest(reqs[2]!) // not in the folder
    expect(pending(d, ws)).toBe(1)
    await d.api.deleteFolder(folder) // takes its two requests with it
    expect(kinds(d, ws)).toEqual(['deleted folder', 'deleted request'])
    expect(pending(d, ws)).toBe(2)
  })

  it('a request created and deleted again does not count; editing back to the original does not count', async () => {
    const { d, ws, col, reqs } = await synced()
    const r = await d.api.createRequest({ workspaceId: ws, collectionId: col, name: 'tmp', method: 'GET', url: 'https://t', documentJson: DOC })
    expect(pending(d, ws)).toBe(1)
    await d.api.deleteRequest(r.id)
    expect(pending(d, ws)).toBe(0)

    await d.api.renameRequest(reqs[0]!, 'Changed')
    expect(pending(d, ws)).toBe(1)
    expect(kinds(d, ws)).toEqual(['updated request'])
    await d.api.renameRequest(reqs[0]!, 'Req 0')
    expect(pending(d, ws)).toBe(0)
  })

  it('moving a request out of a collection and then deleting that collection still uploads the request (judged by the cloud)', async () => {
    const { d, ws, col, reqs } = await synced()
    const other = await d.api.createCollection(ws, 'Other')
    await settle(d, ws)
    await d.api.moveRequest({ requestId: reqs[3]!, targetCollectionId: other.id, targetFolderId: null, targetIndex: 0 })
    await d.api.deleteCollection(col)
    // The collection delete removes the other requests on the cloud; the moved request needs its own upload (it lives in Other).
    expect(kinds(d, ws)).toEqual(['deleted collection', 'updated request'])
  })

  it('the count goes to zero after the sync, and the activity list shows exactly what is counted', async () => {
    const { d, ws, col, reqs } = await synced()
    await d.api.renameRequest(reqs[0]!, 'A')
    await d.api.deleteRequest(reqs[1]!)
    const made = await d.api.createCollection(ws, 'New')
    await d.api.deleteCollection(col)
    expect(pending(d, ws)).toBe(2) // the new collection, and the deleted old one (its renamed/deleted requests are inside it)
    const list = await d.api.listSyncPending(ws)
    expect(list.map((i) => `${i.change} ${i.entityType}`).sort()).toEqual(['created collection', 'deleted collection'])
    expect(made.id).toBeTruthy()
    await settle(d, ws)
    expect(pending(d, ws)).toBe(0)
    expect(cloud.live((await d.api.getSyncStatus(ws)).remoteWorkspaceId!).map((e) => e.type)).toEqual(['collection'])
  })

  it('environments: variables of a deleted environment are covered; a deleted variable of a live one counts', async () => {
    const { d, ws } = await synced()
    const env = await d.api.createEnvironment(ws, 'Prod')
    const v1 = await d.api.upsertEnvironmentVariable({ environmentId: env.id, key: 'a', value: '1', isSecret: false })
    await d.api.upsertEnvironmentVariable({ environmentId: env.id, key: 'b', value: '2', isSecret: false })
    await settle(d, ws)
    expect(pending(d, ws)).toBe(0)
    await d.api.deleteEnvironmentVariable(v1.id)
    expect(kinds(d, ws)).toEqual(['deleted environment_variable'])
    await d.api.deleteEnvironment(env.id)
    expect(kinds(d, ws)).toEqual(['deleted environment'])
  })

  it('is the same on a second device and does not change anything (read only)', async () => {
    pair = await makePair(cloud, async (a, ws) => {
      await a.api.createCollection(ws, 'Shop')
    })
    const { b, wsB } = pair
    const before = b.db.prepare('SELECT COUNT(*) AS n FROM sync_dirty').get() as { n: number }
    await b.api.deleteCollection((await b.api.listCollections(wsB))[0]!.id)
    const dirtyBefore = (b.db.prepare('SELECT COUNT(*) AS n FROM sync_dirty').get() as { n: number }).n
    expect(pending(b, wsB)).toBe(1)
    pendingOps(b.db, wsB)
    expect((b.db.prepare('SELECT COUNT(*) AS n FROM sync_dirty').get() as { n: number }).n).toBe(dirtyBefore)
    expect(before.n).toBe(0)
  })
})

describe('the count equals what the push would send', () => {
  // buildOps on a throwaway copy of the database: the number of operations it builds is exactly what a sync would upload.
  const sendable = (d: Device, ws: string): number => {
    const copy = new Database(d.db.serialize()) as unknown as Db
    try {
      return buildOps(copy, ws, Date.now()).ops.length
    } finally {
      copy.close()
    }
  }

  it.each(Array.from({ length: 24 }, (_, i) => i + 1))('random edits, seed %i', async (seed) => {
    const { d, ws } = await synced()
    const rnd = mulberry32(seed * 7919)
    for (let round = 0; round < 6; round++) {
      for (let i = 0; i < 6; i++) await randomOp(d, ws, rnd, round * 10 + i)
      expect(pendingCount(d.db, ws), `seed ${seed} round ${round}`).toBe(sendable(d, ws))
      if (round === 2) await settle(d, ws) // some work reaches the cloud, the rest stays local
    }
  })
})
