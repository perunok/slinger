import { render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../app/state.svelte'
import SyncChip from './SyncChip.svelte'
import { sync } from './syncStore.svelte'
import { flush, setupSync, signInMock, teardownSync, type Backend } from './testUtils'

let b: Backend
beforeEach(async () => {
  b = await setupSync()
})
afterEach(() => teardownSync())

async function publishPersonal() {
  const id = app.workspaceId!
  await signInMock(b)
  await sync.publish(id)
  await b.cloud.runCycle(id)
  await flush()
  return id
}
/** What main's watcher does after a local edit: announce the status (the badge follows). */
async function announce(ws: string) {
  sync.handleEvent({ type: 'status', status: await b.getSyncStatus(ws) })
}
const badge = () => screen.queryByTitle(/changes? waiting to upload/)?.textContent?.trim() ?? null

describe('the sync chip count follows adds and deletes', () => {
  it('adding a collection counts up and deleting it again counts back down', async () => {
    const ws = await publishPersonal()
    render(SyncChip)
    expect(badge()).toBeNull()
    const col = await b.createCollection(ws, 'Draft')
    await b.createRequest({ workspaceId: ws, collectionId: col.id, name: 'r', method: 'GET', url: 'https://x', documentJson: '{}' })
    await announce(ws)
    await waitFor(() => expect(badge()).toBe('2 pending'))
    await b.deleteCollection(col.id)
    await announce(ws)
    // Created and deleted before it was ever synced: nothing is waiting.
    await waitFor(() => expect(badge()).toBeNull())
    expect((await b.getSyncStatus(ws)).pendingChanges).toBe(0)
    expect(await b.listSyncPending(ws)).toEqual([])
  })

  it('deleting a collection that is in the cloud is one change, not one per request', async () => {
    const ws = await publishPersonal()
    render(SyncChip)
    const col = app.collections[0]!
    expect(app.requestsOf(col.id).length).toBeGreaterThan(3)
    await b.deleteCollection(col.id)
    await announce(ws)
    await waitFor(() => expect(badge()).toBe('1 pending'))
    expect((await b.listSyncPending(ws)).map((i) => `${i.change} ${i.entityType}`)).toEqual(['deleted collection'])
  })
})
