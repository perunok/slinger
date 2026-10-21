import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../app/state.svelte'
import { ui } from '../../app/ui.svelte'
import QuickOpen from '../requests/QuickOpen.svelte'
import SyncChip from '../sync/SyncChip.svelte'
import SyncPanel from '../sync/SyncPanel.svelte'
import { sync } from '../sync/syncStore.svelte'
import { flush, setupSync, signInMock, teardownSync, type Backend } from '../sync/testUtils'
import TeamDialog from './TeamDialog.svelte'

Element.prototype.scrollIntoView ??= function () {}

let b: Backend
beforeEach(async () => {
  b = await setupSync()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  teardownSync()
})

const TEAM = [
  { name: 'Zed Viewer', email: 'zed@example.com', role: 'viewer' as const },
  { name: 'Bea Editor', email: 'bea@example.com', role: 'editor' as const },
  { name: 'Ana Silva', email: 'ana@example.com', role: 'owner' as const },
  { name: 'Ada Admin', email: 'ada@example.com', role: 'admin' as const },
]

async function publishShared(members = TEAM) {
  const id = app.workspaceId!
  await signInMock(b)
  await sync.publish(id)
  await b.cloud.runCycle(id)
  await flush()
  const rid = (await b.getSyncStatus(id)).remoteWorkspaceId!
  if (members.length) b.cloud.setMembers(rid, members)
  await flush()
  return { id, rid }
}

async function openDialog() {
  ui.teamOpen = true
  render(TeamDialog)
  await waitFor(() => expect(screen.queryByRole('status', { name: 'Loading' })).toBeNull())
}

describe('Team dialog', () => {
  it('titles itself with the cloud workspace and lists members by role then name, with You, email, role and join date', async () => {
    await publishShared()
    await openDialog()
    expect(screen.getByRole('dialog', { name: /Team · / })).toBeInTheDocument()
    expect(screen.getByTestId('team-count')).toHaveTextContent('4 members')
    const rows = screen.getAllByTestId('team-member')
    expect(rows.map((r) => within(r).getByTestId('team-role').textContent)).toEqual(['Owner', 'Admin', 'Editor', 'Viewer'])
    expect(rows[0]).toHaveTextContent('Ana Silva')
    expect(within(rows[0]!).getByTestId('team-you')).toHaveTextContent('You')
    expect(rows[0]).toHaveTextContent('ana@example.com')
    expect(rows[0]).toHaveTextContent(/Joined /)
    expect(screen.getAllByTestId('team-you')).toHaveLength(1)
    expect(rows[3]).toHaveTextContent('Zed Viewer')
  })

  it('refetches every time it opens and on Refresh', async () => {
    const { rid } = await publishShared()
    const spy = vi.spyOn(b, 'listWorkspaceMembers')
    await openDialog()
    expect(spy).toHaveBeenCalledTimes(1)
    b.cloud.setMembers(rid, [...TEAM, { name: 'New Person', email: 'new@example.com', role: 'editor' }])
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(screen.getByTestId('team-count')).toHaveTextContent('5 members'))
    expect(spy).toHaveBeenCalledTimes(2)
    cleanup()
    await openDialog()
    expect(spy).toHaveBeenCalledTimes(3)
  })

  it('explains who manages the team behind an (i)', async () => {
    await publishShared()
    await openDialog()
    const tip = screen.getByRole('button', { name: 'About the team' })
    await fireEvent.focus(tip)
    expect(await screen.findByText(/in the Slinger Cloud dashboard/)).toBeInTheDocument()
  })

  it('shows an empty state', async () => {
    await publishShared([])
    const rid = (await b.getSyncStatus(app.workspaceId!)).remoteWorkspaceId!
    b.cloud.setMembers(rid, [])
    await openDialog()
    expect(screen.getByTestId('team-empty')).toHaveTextContent('No members to show')
  })

  it('shows an offline message and recovers on Refresh', async () => {
    await publishShared()
    b.cloud.setOffline(true)
    await openDialog()
    expect(screen.getByTestId('team-error')).toHaveTextContent(/offline or the cloud cannot be reached/)
    expect(screen.queryByTestId('team-members')).toBeNull()
    b.cloud.setOffline(false)
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(screen.getAllByTestId('team-member')).toHaveLength(4))
    expect(screen.queryByTestId('team-error')).toBeNull()
  })

  it('shows another error and keeps the last list visible when a refresh fails', async () => {
    await publishShared()
    await openDialog()
    vi.spyOn(b, 'listWorkspaceMembers').mockRejectedValueOnce({ code: 'sync_blocked', message: 'You no longer have access to this cloud workspace.' })
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(screen.getByTestId('team-error')).toHaveTextContent('You no longer have access'))
    expect(screen.getAllByTestId('team-member')).toHaveLength(4)
    expect(screen.getByTestId('team-error')).toHaveTextContent('last time it loaded')
  })

  it('closes with Close', async () => {
    await publishShared()
    await openDialog()
    await fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(ui.teamOpen).toBe(false)
  })
})

describe('Team entry points', () => {
  it('the sync chip popover has a Team (N) button for a linked workspace with known members', async () => {
    await publishShared()
    render(SyncChip)
    await fireEvent.click(screen.getByTestId('sync-chip'))
    await fireEvent.click(within(screen.getByTestId('sync-popover')).getByRole('button', { name: 'Team (4)…' }))
    expect(ui.teamOpen).toBe(true)
  })

  it('the chip popover has no Team button while local only or while the count is unknown', async () => {
    render(SyncChip)
    await fireEvent.click(screen.getByTestId('sync-chip'))
    expect(within(screen.getByTestId('sync-popover')).queryByRole('button', { name: /^Team/ })).toBeNull()
    cleanup()
    await publishShared([])
    const id = app.workspaceId!
    sync.handleEvent({ type: 'status', status: { ...(await b.getSyncStatus(id)), members: null } })
    render(SyncChip)
    await fireEvent.click(screen.getByTestId('sync-chip'))
    expect(within(screen.getByTestId('sync-popover')).queryByRole('button', { name: /^Team/ })).toBeNull()
  })

  it('Ctrl+K has "Team members…" for linked workspaces only', async () => {
    ui.quickOpen = true
    render(QuickOpen)
    const box = () => screen.getByRole('combobox', { name: 'Search requests and commands' })
    await fireEvent.input(box(), { target: { value: '> team members' } })
    expect(screen.queryByRole('option', { name: /Team members…/ })).toBeNull()
    cleanup()
    await publishShared()
    ui.quickOpen = true
    render(QuickOpen)
    await fireEvent.input(box(), { target: { value: '> team members' } })
    await fireEvent.click(screen.getByRole('option', { name: /Team members…/ }))
    expect(ui.teamOpen).toBe(true)
  })

  it('the Cloud panel lists the team size in its status rows', async () => {
    await publishShared()
    render(SyncPanel)
    expect(screen.getByTestId('sync-members')).toHaveTextContent('4 members')
    const rid = (await b.getSyncStatus(app.workspaceId!)).remoteWorkspaceId!
    b.cloud.setMembers(rid, [{ name: 'Ana Silva', email: 'ana@example.com', role: 'owner' }])
    await waitFor(() => expect(screen.getByTestId('sync-members')).toHaveTextContent('1 member'))
    expect(within(screen.getByTestId('sync-panel')).queryByRole('button', { name: /Team/ })).toBeNull()
  })
})
