import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../app/state.svelte'
import { ui } from '../../app/ui.svelte'
import SyncActivityDialog from './SyncActivityDialog.svelte'
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
async function openDialog() {
  ui.syncActivityOpen = true
  render(SyncActivityDialog)
  await waitFor(() => expect(sync.activityLoading).toBe(false))
}
const remoteNames = async (ws: string) => {
  const remote = (await b.getSyncStatus(ws)).remoteWorkspaceId!
  return b.cloud.remoteEntities(remote).filter((e) => e.type === 'request').map((e) => String(e.payload.name))
}

describe('keep on this device', () => {
  it('a kept change moves to its own list, stops counting and is not uploaded until released', async () => {
    const ws = await publishPersonal()
    const req = app.requests[0]!
    await b.renameRequest(req.id, 'Only here')
    await app.reloadCollections()
    await openDialog()
    const row = await within(await screen.findByTestId('sync-pending')).findByTestId('sync-item')
    await fireEvent.click(within(row).getByTestId('sync-keep'))
    await waitFor(() => expect(screen.getByTestId('sync-kept')).toHaveTextContent('Only here'))
    expect(screen.getByTestId('sync-pending-empty')).toBeInTheDocument()
    expect((await b.getSyncStatus(ws)).pendingChanges).toBe(0)

    await b.syncNow(ws)
    expect(await remoteNames(ws)).not.toContain('Only here')

    await fireEvent.click(within(screen.getByTestId('sync-kept')).getByTestId('sync-unkeep'))
    await waitFor(() => expect(screen.queryByTestId('sync-kept')).toBeNull())
    expect((await b.getSyncStatus(ws)).pendingChanges).toBe(1)
    await b.syncNow(ws)
    expect(await remoteNames(ws)).toContain('Only here')
  })

  it('keeping a new collection keeps what is created in it', async () => {
    const ws = await publishPersonal()
    const col = await b.createCollection(ws, 'Scratch')
    await b.createRequest({ workspaceId: ws, collectionId: col.id, name: 'Draft', method: 'GET', url: 'https://x', documentJson: '{}' })
    await app.reloadCollections()
    await openDialog()
    await waitFor(() => expect(sync.pending).toHaveLength(2))
    await sync.keepItems(ws, sync.pending.filter((i) => i.entityType === 'collection'), true)
    expect(sync.pending).toEqual([])
    expect(sync.kept.map((i) => i.path.join(' / ')).sort()).toEqual(['Scratch', 'Scratch / Draft'])
    await b.syncNow(ws)
    expect(await remoteNames(ws)).not.toContain('Draft')
  })
})
