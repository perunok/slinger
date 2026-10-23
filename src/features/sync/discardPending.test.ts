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
async function confirm(label: string) {
  const dialogs = await screen.findAllByRole('dialog')
  await fireEvent.click(within(dialogs[dialogs.length - 1]!).getByRole('button', { name: label }))
}

describe('cancelling waiting changes from Sync activity', () => {
  it('cancelling an edit puts the cloud version back and empties the waiting list', async () => {
    const ws = await publishPersonal()
    const req = app.requests[0]!
    const original = req.name
    await b.renameRequest(req.id, 'Edited here')
    await app.reloadCollections()
    await openDialog()
    const row = await within(await screen.findByTestId('sync-pending')).findByTestId('sync-item')
    await fireEvent.click(within(row).getByTestId('sync-discard'))
    await confirm('Cancel change')
    await waitFor(() => expect(screen.getByTestId('sync-pending-empty')).toBeInTheDocument())
    expect(app.requests.find((r) => r.id === req.id)?.name).toBe(original)
    expect((await b.getSyncStatus(ws)).pendingChanges).toBe(0)
  })

  it('a deleted collection can be brought back, with what was inside it', async () => {
    const ws = await publishPersonal()
    const col = app.collections[0]!
    const inside = app.requests.filter((r) => r.collectionId === col.id).length
    expect(inside).toBeGreaterThan(0)
    await b.deleteCollection(col.id)
    await app.reloadCollections()
    await openDialog()
    const row = await within(await screen.findByTestId('sync-pending')).findByTestId('sync-item')
    expect(within(row).getByTestId('sync-discard')).toHaveTextContent('Restore')
    await fireEvent.click(within(row).getByTestId('sync-discard'))
    await confirm('Bring back')
    await waitFor(() => expect(app.collections.map((c) => c.id)).toContain(col.id))
    expect(app.requests.filter((r) => r.collectionId === col.id)).toHaveLength(inside)
    expect((await b.getSyncStatus(ws)).pendingChanges).toBe(0)
  })

  it('Cancel all drops every waiting change', async () => {
    const ws = await publishPersonal()
    const col = app.collections[0]!
    await b.renameRequest(app.requests[0]!.id, 'x')
    await b.createRequest({ workspaceId: ws, collectionId: col.id, name: 'Brand new', method: 'GET', url: 'https://x', documentJson: '{}' })
    await app.reloadCollections()
    await openDialog()
    await waitFor(() => expect(sync.pending).toHaveLength(2))
    await fireEvent.click(screen.getByTestId('sync-discard-all'))
    await confirm('Cancel change')
    await waitFor(() => expect(screen.getByTestId('sync-pending-empty')).toBeInTheDocument())
    expect(app.requests.some((r) => r.name === 'Brand new')).toBe(false)
    expect((await b.getSyncStatus(ws)).pendingChanges).toBe(0)
  })
})
