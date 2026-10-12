import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SYNC_ACTIVITY_RUNS, type SyncEvent, type SyncRun } from '../../../shared/types'
import { FakeCloud } from './fakeCloud'
import { converge, DOC, makePair, settle, type Device, type Pair } from './harness'

let cloud: FakeCloud
let pair: Pair | null = null
beforeEach(async () => {
  cloud = await new FakeCloud().start()
})
afterEach(async () => {
  pair?.a.cleanup()
  pair?.b.cleanup()
  pair = null
  await cloud.stop()
})

const activityEvents = (d: Device) => d.events.filter((e): e is Extract<SyncEvent, { type: 'activity' }> => e.type === 'activity').map((e) => e.run)
const paths = (items: SyncRun['uploaded']) => items.map((i) => [i.change, i.entityType, i.path.join(' / ')])

describe('sync activity', () => {
  it('lists local changes waiting to upload: new, edited and deleted, with their place', async () => {
    const ids: Record<string, string> = {}
    pair = await makePair(cloud, async (a, ws) => {
      const col = await a.api.createCollection(ws, 'Shop')
      ids.col = col.id
      ids.old = (await a.api.createRequest({ workspaceId: ws, collectionId: col.id, name: 'Old', method: 'GET', url: 'https://x/old', documentJson: DOC })).id
      ids.edit = (await a.api.createRequest({ workspaceId: ws, collectionId: col.id, name: 'List orders', method: 'GET', url: 'https://x/o', documentJson: DOC })).id
    })
    const { a, wsA } = pair
    expect(await a.api.listSyncPending(wsA)).toEqual([])
    const folder = await a.api.createFolder({ workspaceId: wsA, collectionId: ids.col!, name: 'Admin' })
    await a.api.createRequest({ workspaceId: wsA, collectionId: ids.col!, folderId: folder.id, name: 'Create user', method: 'POST', url: 'https://x/u', documentJson: DOC })
    await a.api.renameRequest(ids.edit!, 'List all orders')
    await a.api.deleteRequest(ids.old!)
    expect(paths(await a.api.listSyncPending(wsA))).toEqual([
      ['created', 'folder', 'Shop / Admin'],
      ['created', 'request', 'Shop / Admin / Create user'],
      ['updated', 'request', 'Shop / List all orders'],
      ['deleted', 'request', 'Shop / Old'],
    ])
  })

  it('records each run: what was uploaded here and downloaded there, by name', async () => {
    const ids: Record<string, string> = {}
    pair = await makePair(cloud, async (a, ws) => {
      ids.col = (await a.api.createCollection(ws, 'Shop')).id
    })
    const { a, b, wsA, wsB } = pair
    await a.api.createRequest({ workspaceId: wsA, collectionId: ids.col!, name: 'Pay', method: 'POST', url: 'https://x/pay', documentJson: DOC })
    await a.api.renameCollection(ids.col!, 'Shop API')
    await a.core.sync.syncNow(wsA)

    const [runA] = await a.api.listSyncActivity(wsA)
    expect(runA).toMatchObject({ trigger: 'manual', result: 'ok', error: null, uploadedCount: 2, conflicts: 0 })
    expect(runA!.finishedAt).toBeGreaterThanOrEqual(runA!.startedAt)
    expect(paths(runA!.uploaded).sort()).toEqual([
      ['created', 'request', 'Shop API / Pay'],
      ['updated', 'collection', 'Shop API'],
    ])
    // Pushed live: a running record first, then the finished one.
    const events = activityEvents(a).filter((r) => r.id === runA!.id)
    expect(events[0]!.result).toBe('running')
    expect(events.at(-1)!.result).toBe('ok')

    await b.core.sync.syncNow(wsB)
    const [runB] = await b.api.listSyncActivity(wsB)
    expect(runB).toMatchObject({ result: 'ok', uploadedCount: 0, downloadedCount: 2 })
    expect(paths(runB!.downloaded).sort()).toEqual([
      ['created', 'request', 'Shop API / Pay'],
      ['updated', 'collection', 'Shop API'],
    ])
    // A cycle with nothing to do is still listed, empty.
    await b.core.sync.syncNow(wsB)
    expect((await b.api.listSyncActivity(wsB))[0]).toMatchObject({ uploadedCount: 0, downloadedCount: 0, result: 'ok' })
  })

  it('a failed run says why; the initial download is marked', async () => {
    pair = await makePair(cloud, async (a, ws) => void (await a.api.createCollection(ws, 'Shop')))
    const { b, wsB, a, wsA } = pair
    const first = (await b.api.listSyncActivity(wsB)).at(-1)!
    expect(first).toMatchObject({ initial: true, result: 'ok' })
    expect(first.downloaded.every((i) => i.change === 'created')).toBe(true)

    await a.api.createCollection(wsA, 'Later')
    await cloud.stop()
    await a.core.sync.syncNow(wsA)
    const [failed] = await a.api.listSyncActivity(wsA)
    expect(failed).toMatchObject({ result: 'error', uploadedCount: 0 })
    expect(failed!.error).toBeTruthy()
    await cloud.start()
  })

  it(`keeps the latest ${SYNC_ACTIVITY_RUNS} runs, newest first`, async () => {
    pair = await makePair(cloud, async (a, ws) => void (await a.api.createCollection(ws, 'Shop')))
    const { a, wsA } = pair
    for (let i = 0; i < SYNC_ACTIVITY_RUNS + 3; i++) await a.core.sync.syncNow(wsA)
    const runs = await a.api.listSyncActivity(wsA)
    expect(runs).toHaveLength(SYNC_ACTIVITY_RUNS)
    expect(runs[0]!.id).toBeGreaterThan(runs[1]!.id)
    await settle(a, wsA)
    await converge(pair)
  })
})
