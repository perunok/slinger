import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SyncRun } from '../../../shared/types'
import { app } from '../../app/state.svelte'
import { ui } from '../../app/ui.svelte'
import QuickOpen from '../requests/QuickOpen.svelte'
import { tabsStore } from '../requests/tabs.svelte'
import { pendingSummary, runSummary, triggerLabel } from './activity'
import SyncActivityDialog from './SyncActivityDialog.svelte'
import SyncChip from './SyncChip.svelte'
import { sync } from './syncStore.svelte'
import { flush, setupSync, signInMock, teardownSync, type Backend } from './testUtils'

Element.prototype.scrollIntoView ??= function () {}

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
const remoteId = async (ws: string) => (await b.getSyncStatus(ws)).remoteWorkspaceId!
const rows = (el: HTMLElement) => within(el).getAllByTestId('sync-item').map((r) => r.textContent?.replace(/\s+/g, ' ').replace(/ (Keep here |Upload )?(Cancel|Restore)$/, '').trim())

async function openDialog() {
  ui.syncActivityOpen = true
  render(SyncActivityDialog)
  await waitFor(() => expect(sync.activityLoading).toBe(false))
}

describe('Sync activity dialog', () => {
  it('lists what waits to upload, then what the sync uploaded; requests open from it', async () => {
    const ws = await publishPersonal()
    const col = app.collections[0]!
    const req = app.requests.find((r) => r.collectionId === col.id)!
    await b.renameRequest(req.id, 'Renamed here')
    await b.createRequest({ workspaceId: ws, collectionId: col.id, name: 'Brand new', method: 'GET', url: 'https://x', documentJson: '{}' })
    await app.reloadCollections()
    await openDialog()

    const pending = await screen.findByTestId('sync-pending')
    expect(rows(pending)).toEqual(
      expect.arrayContaining([`New Request ${col.name} / Brand new`, expect.stringMatching(new RegExp(`^Edited Request ${col.name} / .*Renamed here$`))]),
    )
    expect(screen.getByRole('heading', { name: /Waiting to upload \(2: 1 new, 1 edited\)/ })).toBeInTheDocument()

    await fireEvent.click(within(screen.getByTestId('sync-activity')).getByRole('button', { name: 'Sync now' }))
    await waitFor(() => expect(screen.getByTestId('sync-pending-empty')).toBeInTheDocument())
    const run = (await screen.findAllByTestId('sync-run'))[0]!
    expect(within(run).getByTestId('sync-run-summary')).toHaveTextContent('2 uploaded')
    expect(run).toHaveTextContent('Sync now')
    // The newest run with items starts open, or opens on click.
    if (!within(run).queryByTestId('sync-run-items')) await fireEvent.click(within(run).getByRole('button', { expanded: false }))
    const items = within(run).getByTestId('sync-run-items')
    expect(items).toHaveTextContent('Uploaded (2)')
    await fireEvent.click(within(items).getByRole('button', { name: /Brand new/ }))
    expect(tabsStore.active?.draft.name).toBe('Brand new')
    expect(ui.syncActivityOpen).toBe(false)
  })

  it('shows downloads from the cloud and failed syncs with their reason', async () => {
    const ws = await publishPersonal()
    const rid = await remoteId(ws)
    const col = app.collections[0]!
    b.cloud.remoteEdit(rid, 'collection', col.id, { name: 'Renamed in the cloud' })
    await b.syncNow(ws)
    b.cloud.setOffline(true)
    await b.syncNow(ws)
    await openDialog()
    const runs = await screen.findAllByTestId('sync-run')
    expect(within(runs[0]!).getByTestId('sync-run-summary')).toHaveTextContent('Failed')
    expect(runs[0]).toHaveTextContent('Could not reach')
    expect(within(runs[1]!).getByTestId('sync-run-summary')).toHaveTextContent('1 downloaded')
    if (!within(runs[1]!).queryByTestId('sync-run-items')) await fireEvent.click(within(runs[1]!).getByRole('button', { expanded: false }))
    expect(rows(within(runs[1]!).getByTestId('sync-run-items'))).toEqual(['Edited Collection Renamed in the cloud'])
    b.cloud.setOffline(false)
  })

  it('updates live while it is open', async () => {
    const ws = await publishPersonal()
    await openDialog()
    const before = sync.activity.length
    await b.createCollection(ws, 'Live one')
    // Main's scheduler announces local edits with a status event (the mock leaves that to the test).
    sync.handleEvent({ type: 'status', status: await b.getSyncStatus(ws) })
    await waitFor(() => expect(screen.getByTestId('sync-pending')).toHaveTextContent('Live one'), { timeout: 2000 })
    await b.syncNow(ws)
    await waitFor(() => expect(sync.activity.length).toBe(before + 1))
    expect(within(screen.getAllByTestId('sync-run')[0]!).getByTestId('sync-run-summary')).toHaveTextContent('1 uploaded')
  })

  it('opens from the sync chip popover and from Ctrl+K', async () => {
    await publishPersonal()
    render(SyncChip)
    await fireEvent.click(screen.getByTestId('sync-chip'))
    await fireEvent.click(within(screen.getByTestId('sync-popover')).getByRole('button', { name: 'Sync activity…' }))
    expect(ui.syncActivityOpen).toBe(true)
    ui.syncActivityOpen = false
    ui.quickOpen = true
    render(QuickOpen)
    await fireEvent.input(screen.getByRole('combobox', { name: 'Search requests and commands' }), { target: { value: '> sync activity' } })
    await fireEvent.click(screen.getByRole('option', { name: /Sync activity…/ }))
    expect(ui.syncActivityOpen).toBe(true)
  })
})

describe('activity wording', () => {
  const run = (over: Partial<SyncRun>): SyncRun => ({
    id: 1, workspaceId: 'w', trigger: 'auto', startedAt: 0, finishedAt: 10, result: 'ok', error: null, initial: false,
    uploaded: [], uploadedCount: 0, downloaded: [], downloadedCount: 0, conflicts: 0, ...over,
  })
  it('summarises runs', () => {
    expect(runSummary(run({}))).toBe('Nothing to sync')
    expect(runSummary(run({ uploadedCount: 2, downloadedCount: 5, conflicts: 1 }))).toBe('2 uploaded, 5 downloaded, 1 conflict')
    expect(runSummary(run({ result: 'running', downloadedCount: 3 }))).toBe('In progress: 3 downloaded')
    expect(runSummary(run({ result: 'error' }))).toBe('Failed')
    expect(runSummary(run({ initial: true, downloadedCount: 40 }))).toBe('40 items downloaded')
    expect(triggerLabel(run({ trigger: 'manual' }))).toBe('Sync now')
    expect(triggerLabel(run({ initial: true }))).toBe('First sync')
  })
  it('summarises the waiting list', () => {
    const item = (change: 'created' | 'updated' | 'deleted') => ({ entityType: 'request' as const, entityId: 'x', path: ['x'], change })
    expect(pendingSummary([item('deleted'), item('created'), item('created')])).toBe('2 new, 1 deleted')
  })
})
