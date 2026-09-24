import { cleanup, render, screen, waitFor } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../app/state.svelte'
import { ui } from '../../app/ui.svelte'
import SyncChip from './SyncChip.svelte'
import { sync } from './syncStore.svelte'
import { flush, setupSync, signInMock, teardownSync, type Backend } from './testUtils'

let b: Backend
let ws: string
beforeEach(async () => {
  b = await setupSync()
  ws = app.workspaceId!
})
afterEach(() => {
  cleanup()
  teardownSync()
})

async function publish() {
  await signInMock(b)
  await sync.publish(ws)
  await b.cloud.runCycle(ws)
  await flush()
}
const chip = () => screen.getByTestId('sync-chip')

describe('SyncChip', () => {
  it('shows "Local only" for an unlinked workspace and links to the cloud dialog from its popover', async () => {
    const user = userEvent.setup()
    render(SyncChip)
    expect(chip()).toHaveTextContent('Local only')
    expect(chip().dataset.kind).toBe('unlinked')
    await user.click(chip())
    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull()
    await user.click(screen.getByRole('button', { name: /Cloud/ }))
    expect(ui.cloudOpen).toBe(true)
  })

  it('reflects synced, offline, conflicts, read-only and signed-out states reactively', async () => {
    render(SyncChip)
    await publish()
    await waitFor(() => expect(chip().dataset.kind).toBe('idle'))
    expect(chip()).toHaveTextContent('Synced')
    expect(chip().getAttribute('aria-label')).toContain('Last synced')

    b.cloud.setOffline(true)
    await sync.syncNow(ws)
    await waitFor(() => expect(chip().dataset.kind).toBe('offline'))
    b.cloud.setOffline(false)
    await sync.syncNow(ws)

    b.cloud.injectConflict({ workspaceId: ws, kind: 'rejected' })
    await waitFor(() => expect(chip().dataset.kind).toBe('conflicts'))
    expect(chip()).toHaveTextContent('1 conflict')

    b.cloud.expireAuth()
    await waitFor(() => expect(chip().dataset.kind).toBe('signedOut'))
  })

  it('popover: sync now, auto sync toggle, review conflicts, Escape closes and returns focus', async () => {
    const user = userEvent.setup()
    render(SyncChip)
    await publish()
    b.cloud.injectConflict({ workspaceId: ws, kind: 'rejected' })
    await waitFor(() => expect(chip().dataset.kind).toBe('conflicts'))
    await user.click(chip())
    const pop = await screen.findByRole('dialog', { name: 'Sync details' })
    expect(pop).toHaveTextContent('Last synced')
    const before = b.calls.filter((c) => c.method === 'syncNow').length
    await user.click(screen.getByRole('button', { name: 'Sync now' }))
    await waitFor(() => expect(b.calls.filter((c) => c.method === 'syncNow').length).toBe(before + 1))
    await user.click(screen.getByRole('checkbox', { name: 'Auto sync' }))
    await waitFor(() => expect(sync.current?.autoSync).toBe(false))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Sync details' })).toBeNull()
    expect(document.activeElement).toBe(chip())
    await user.click(chip())
    await user.click(await screen.findByRole('button', { name: /Review 1 conflict/ }))
    expect(ui.conflictsOpen).toBe(true)
  })

  it('Sync now is disabled while signed out', async () => {
    const user = userEvent.setup()
    render(SyncChip)
    await publish()
    b.cloud.expireAuth()
    await waitFor(() => expect(chip().dataset.kind).toBe('signedOut'))
    await user.click(chip())
    expect(await screen.findByRole('button', { name: 'Sync now' })).toBeDisabled()
  })
})
