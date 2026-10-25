import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../../db/database'
import { heldKeys } from '../../sync/kept'
import { buildOps } from '../../sync/outbox'
import { pendingCount, pendingOps } from '../../sync/pending'
import { FakeCloud } from './fakeCloud'
import { mulberry32, randomOp } from './fuzzKit'
import { DOC, makeDevice, makePair, settle, type Device, type Pair } from './harness'

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

async function synced() {
  const user = cloud.createUser(`u${Math.random().toString(36).slice(2)}@example.com`)
  const d = makeDevice(cloud, { userId: user.id })
  devices.push(d)
  const ws = d.workspace.id
  const col = await d.api.createCollection(ws, 'Shop')
  const folder = await d.api.createFolder({ workspaceId: ws, collectionId: col.id, name: 'Admin' })
  const reqs: string[] = []
  for (let i = 0; i < 3; i++) {
    reqs.push((await d.api.createRequest({ workspaceId: ws, collectionId: col.id, folderId: i < 2 ? folder.id : null, name: `Req ${i}`, method: 'GET', url: `https://x/${i}`, documentJson: DOC })).id)
  }
  await d.api.publishWorkspace(ws)
  const st = await settle(d, ws)
  return { d, ws, col: col.id, folder: folder.id, reqs, remote: st.remoteWorkspaceId! }
}
const remoteNames = (remote: string, type: 'collection' | 'request' | 'folder') =>
  cloud
    .live(remote, type)
    .map((e) => String(e.data.name))
    .sort()
const kept = async (d: Device, ws: string) => (await d.api.listSyncKept(ws)).map((i) => `${i.change} ${i.entityType} ${i.path.join(' / ')}`)

describe('keep on this device', () => {
  it('a kept edit stays local, does not count, and uploads once released', async () => {
    const { d, ws, reqs, remote } = await synced()
    await d.api.renameRequest(reqs[0]!, 'Local only name')
    expect((await d.api.setSyncKept(ws, [{ entityType: 'request', entityId: reqs[0]! }], true)).pendingChanges).toBe(0)
    expect(await d.api.listSyncPending(ws)).toEqual([])
    expect(await kept(d, ws)).toEqual(['updated request Shop / Admin / Local only name'])
    await settle(d, ws)
    expect(remoteNames(remote, 'request')).toEqual(['Req 0', 'Req 1', 'Req 2'])
    // Still kept after the sync, and still editable.
    await d.api.renameRequest(reqs[0]!, 'Local only name 2')
    await settle(d, ws)
    expect(remoteNames(remote, 'request')).toEqual(['Req 0', 'Req 1', 'Req 2'])
    expect(await kept(d, ws)).toEqual(['updated request Shop / Admin / Local only name 2'])

    expect((await d.api.setSyncKept(ws, [{ entityType: 'request', entityId: reqs[0]! }], false)).pendingChanges).toBe(1)
    await settle(d, ws)
    expect(remoteNames(remote, 'request')).toEqual(['Local only name 2', 'Req 1', 'Req 2'])
    expect(await kept(d, ws)).toEqual([])
  })

  it('a kept new collection holds back everything inside it, also what is added later', async () => {
    const { d, ws, reqs, remote } = await synced()
    const col = await d.api.createCollection(ws, 'Scratch')
    const f = await d.api.createFolder({ workspaceId: ws, collectionId: col.id, name: 'Notes' })
    await d.api.setSyncKept(ws, [{ entityType: 'collection', entityId: col.id }], true)
    await d.api.createRequest({ workspaceId: ws, collectionId: col.id, folderId: f.id, name: 'Later', method: 'GET', url: 'https://x', documentJson: DOC })
    // A synced request moved into it would point at a collection the cloud does not have: held too.
    await d.api.moveRequest({ requestId: reqs[2]!, targetCollectionId: col.id, targetFolderId: null, targetIndex: 0 })
    expect(pendingCount(d.db, ws)).toBe(0)
    expect((await kept(d, ws)).sort()).toEqual(['created collection Scratch', 'created folder Scratch / Notes', 'created request Scratch / Notes / Later', 'updated request Scratch / Req 2'])
    await settle(d, ws)
    expect(remoteNames(remote, 'collection')).toEqual(['Shop'])
    expect(remoteNames(remote, 'request')).toEqual(['Req 0', 'Req 1', 'Req 2'])
  })

  it('keeping a deleted collection keeps the cloud copy, children included', async () => {
    const { d, ws, col, remote } = await synced()
    await d.api.deleteCollection(col)
    await d.api.setSyncKept(ws, [{ entityType: 'collection', entityId: col }], true)
    expect(pendingCount(d.db, ws)).toBe(0)
    expect(await kept(d, ws)).toEqual(['deleted collection Shop'])
    await settle(d, ws)
    expect(remoteNames(remote, 'request')).toEqual(['Req 0', 'Req 1', 'Req 2'])
    expect(remoteNames(remote, 'folder')).toEqual(['Admin'])
  })

  it('only waiting changes can be kept; reverting a kept edit drops it', async () => {
    const { d, ws, reqs } = await synced()
    await d.api.setSyncKept(ws, [{ entityType: 'request', entityId: reqs[1]! }], true)
    expect(d.db.prepare('SELECT COUNT(*) AS n FROM sync_kept').get()).toEqual({ n: 0 })
    await d.api.renameRequest(reqs[1]!, 'Temp')
    await d.api.setSyncKept(ws, [{ entityType: 'request', entityId: reqs[1]! }], true)
    await d.api.renameRequest(reqs[1]!, 'Req 1')
    expect(await kept(d, ws)).toEqual([])
    await settle(d, ws)
    expect(d.db.prepare('SELECT COUNT(*) AS n FROM sync_kept').get()).toEqual({ n: 0 })
  })

  it('a kept edit the cloud changes too becomes a normal conflict', async () => {
    pair = await makePair(cloud, async (a, ws) => {
      const c = await a.api.createCollection(ws, 'Shop')
      await a.api.createRequest({ workspaceId: ws, collectionId: c.id, name: 'Shared', method: 'GET', url: 'https://x', documentJson: DOC })
    })
    const { a, b, wsA, wsB } = pair
    const reqA = (await a.api.listRequests((await a.api.listCollections(wsA))[0]!.id))[0]!
    await a.api.renameRequest(reqA.id, 'Kept on A')
    await a.api.setSyncKept(wsA, [{ entityType: 'request', entityId: reqA.id }], true)
    await b.api.renameRequest(reqA.id, 'From B')
    await settle(b, wsB)
    await settle(a, wsA)
    const conflicts = await a.api.listSyncConflicts(wsA)
    expect(conflicts.map((c) => `${c.kind} ${c.entityType}`)).toEqual(['edit_edit request'])
  })

  it('unlinking forgets what was kept', async () => {
    const { d, ws, reqs } = await synced()
    await d.api.renameRequest(reqs[0]!, 'x')
    await d.api.setSyncKept(ws, [{ entityType: 'request', entityId: reqs[0]! }], true)
    await d.api.unlinkWorkspace(ws)
    expect(d.db.prepare('SELECT COUNT(*) AS n FROM sync_kept').get()).toEqual({ n: 0 })
    await expect(d.api.setSyncKept(ws, [], true)).rejects.toMatchObject({ code: 'sync_blocked' })
  })
})

describe('kept changes and the push agree', () => {
  const sendable = (d: Device, ws: string) => {
    const copy = new Database(d.db.serialize()) as unknown as Db
    try {
      return buildOps(copy, ws, Date.now()).ops.map((o) => `${o.type}:${o.id}`)
    } finally {
      copy.close()
    }
  }

  it.each(Array.from({ length: 16 }, (_, i) => i + 1))('random edits and keeps, seed %i', async (seed) => {
    const { d, ws } = await synced()
    const rnd = mulberry32(seed * 104729)
    for (let round = 0; round < 6; round++) {
      for (let i = 0; i < 6; i++) await randomOp(d, ws, rnd, round * 10 + i)
      // Keep or release a few of the waiting changes.
      const waiting = pendingOps(d.db, ws)
      const keep = waiting.filter(() => rnd() < 0.3).map((o) => ({ entityType: o.type, entityId: o.id }))
      await d.api.setSyncKept(ws, keep, true)
      if (rnd() < 0.3) {
        const release = (await d.api.listSyncKept(ws)).filter(() => rnd() < 0.5)
        await d.api.setSyncKept(ws, release, false)
      }
      const ops = sendable(d, ws)
      const held = heldKeys(d.db, ws)
      expect(pendingCount(d.db, ws), `seed ${seed} round ${round}`).toBe(ops.length)
      expect(ops.filter((k) => held.has(k)), `seed ${seed} round ${round}: held but sent`).toEqual([])
      if (round === 2) await settle(d, ws)
    }
  })
})
