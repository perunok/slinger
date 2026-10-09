import { cleanup, render, screen, waitFor, within } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RemoteWorkspace } from '../../../shared/types'
import { app } from '../../app/state.svelte'
import { ui } from '../../app/ui.svelte'
import SharedWorkspaceBanner from './SharedWorkspaceBanner.svelte'
import { loadDismissed, newShares, saveDismissed, shareKey, shareNoticeText } from './sharedWorkspaces'
import { sync } from './syncStore.svelte'
import { flush, setupSync, signInMock, teardownSync, type Backend } from './testUtils'

const rw = (id: string, over: Partial<RemoteWorkspace> = {}): RemoteWorkspace => ({
  id, name: id.toUpperCase(), slug: id, role: 'editor', addedBy: { id: 'u-sam', displayName: 'Sam Lee' }, linkedLocalWorkspaceId: null, ...over,
})

describe('newShares / shareNoticeText', () => {
  const base = 'https://cloud.example.test'
  it('offers unlinked workspaces you did not create and did not dismiss for this server and account', () => {
    const remotes = [rw('a'), rw('mine', { role: 'owner', addedBy: null }), rw('linked', { linkedLocalWorkspaceId: 'ws-1' }), rw('gone'), rw('b', { role: 'viewer' })]
    const dismissed = new Set([shareKey(base, 'me', 'gone'), shareKey('https://other.test', 'me', 'a'), shareKey(base, 'someone-else', 'b')])
    expect(newShares(remotes, dismissed, base, 'me').map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('names who added you and the role; falls back when the server does not say; counts several', () => {
    expect(shareNoticeText([rw('t', { name: 'Team API' })])).toBe('Sam Lee added you to the cloud workspace “Team API” as editor.')
    expect(shareNoticeText([rw('t', { name: 'Docs', role: 'viewer', addedBy: null })])).toBe('You were added to the cloud workspace “Docs” as viewer (read-only).')
    expect(shareNoticeText([rw('a'), rw('b'), rw('c')])).toBe('You were added to 3 cloud workspaces.')
  })

  it('remembers dismissals in localStorage and survives bad data', () => {
    localStorage.clear()
    saveDismissed(new Set(['x|y|z']))
    expect([...loadDismissed()]).toEqual(['x|y|z'])
    localStorage.setItem('slinger.sharedWorkspaces.dismissed', '{not json')
    expect(loadDismissed().size).toBe(0)
  })
})

describe('shared workspace banner', () => {
  let b: Backend
  beforeEach(async () => {
    b = await setupSync()
  })
  afterEach(() => {
    cleanup()
    teardownSync()
  })

  const banner = () => screen.queryByTestId('shared-banner')

  it('appears after sign-in for workspaces others shared; "Not now" hides them on this device only', async () => {
    render(SharedWorkspaceBanner)
    expect(banner()).toBeNull()
    await signInMock(b)
    await waitFor(() => expect(banner()).toHaveTextContent('You were added to 2 cloud workspaces.')) // Payments API + Shared Docs; not the owned one
    const ev = userEvent.setup()
    await ev.click(within(banner()!).getByRole('button', { name: 'Show' }))
    expect(ui.cloudOpen).toBe(true)
    await ev.click(within(banner()!).getByRole('button', { name: 'Not now' }))
    expect(banner()).toBeNull()
    expect(sync.remotes.filter((r) => r.role !== 'owner')).toHaveLength(2) // still listed in Cloud
    expect(loadDismissed().size).toBe(2)
  })

  it('a newly shared workspace shows who added you; Open downloads it into a new workspace and switches to it', async () => {
    render(SharedWorkspaceBanner)
    await signInMock(b)
    await waitFor(() => expect(banner()).not.toBeNull())
    sync.dismissShares(sync.shares.map((s) => s.id))
    b.cloud.shareWorkspace('Team API', 'editor', 'Olu Owner')
    await sync.checkShares()
    await waitFor(() => expect(banner()).toHaveTextContent('Olu Owner added you to the cloud workspace “Team API” as editor.'))
    const before = app.workspaceId
    await userEvent.setup().click(within(banner()!).getByRole('button', { name: 'Open' }))
    await waitFor(() => expect(banner()).toBeNull())
    await flush()
    expect(app.workspaceId).not.toBe(before)
    expect(app.workspace?.name).toBe('Team API')
    expect(sync.statusOf(app.workspaceId)?.linked).toBe(true)
  })

  it('background checks stay quiet when they fail', async () => {
    await signInMock(b)
    await sync.loadRemotes()
    const count = sync.remotes.length
    b.cloud.setOffline(true)
    await sync.checkShares()
    expect(sync.remotes).toHaveLength(count)
    expect(sync.remotesError).toBeNull()
  })
})
