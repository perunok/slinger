import { cleanup, render, screen, waitFor, within } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../app/state.svelte'
import { ui } from '../../app/ui.svelte'
import { flush, setupSync, signInMock, teardownSync, type Backend } from '../sync/testUtils'
import { sync } from '../sync/syncStore.svelte'
import CloudDialog from './CloudDialog.svelte'

let b: Backend
beforeEach(async () => {
  b = await setupSync()
  ui.cloudOpen = true
})
afterEach(() => {
  cleanup()
  teardownSync()
})

describe('CloudDialog account', () => {
  it('signed out: server URL, device name and Sign in; publishing is disabled', async () => {
    render(CloudDialog)
    expect(await screen.findByLabelText('API base URL')).toHaveValue('https://api.slinger.app')
    expect(screen.getByLabelText('Device name')).toHaveValue('Slinger Desktop')
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Publish to cloud/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Link a cloud workspace/ })).toBeDisabled()
    expect(screen.getByText(/Sign in above to publish/)).toBeInTheDocument()
  })

  it('device flow: shows the code and locks the fields, opens the browser, then shows the identity', async () => {
    const user = userEvent.setup()
    const open = vi.spyOn(b, 'openExternalUrl').mockResolvedValue(undefined)
    render(CloudDialog)
    await user.click(await screen.findByRole('button', { name: 'Sign in' }))
    const code = await screen.findByTestId('user-code')
    expect(code).toHaveTextContent('WDJB-MJHT')
    expect(screen.getByLabelText('API base URL')).toBeDisabled()
    expect(screen.getByText(/code expires in/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Open in browser/ }))
    expect(open).toHaveBeenCalledWith('https://api.slinger.app/device?user_code=WDJB-MJHT')
    b.cloud.approveSignIn()
    expect(await screen.findByText('Ana Silva')).toBeInTheDocument()
    expect(screen.getByText('(ana@example.com)')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
    expect(await screen.findByRole('list', { name: 'Cloud workspaces' })).toHaveTextContent('Payments API')
  })

  it('cancelling, expiry and denial return to the Sign in button with a message', async () => {
    const user = userEvent.setup()
    render(CloudDialog)
    await user.click(await screen.findByRole('button', { name: 'Sign in' }))
    await screen.findByTestId('user-code')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByText('Sign-in cancelled.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByTestId('user-code')
    b.cloud.expireSignIn()
    expect(await screen.findByText('The code expired.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByTestId('user-code')
    b.cloud.denySignIn()
    expect(await screen.findByText(/denied in the browser/)).toBeInTheDocument()
  })

  it('saves changed server settings before signing in; an invalid URL is rejected inline', async () => {
    const user = userEvent.setup()
    render(CloudDialog)
    const url = await screen.findByLabelText('API base URL')
    await user.clear(url)
    await user.type(url, 'ftp://nope')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('http:// or https://')
    expect(b.calls.some((c) => c.method === 'startCloudSignIn')).toBe(false)
    await user.clear(url)
    await user.type(url, 'http://127.0.0.1:8080/')
    expect(screen.queryByTestId('user-code')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByTestId('user-code')
    expect(await b.getCloudConfig()).toEqual({ apiBaseUrl: 'http://127.0.0.1:8080', deviceName: 'Slinger Desktop' })
  })

  it('warns about plain http on a non-loopback host only', async () => {
    const user = userEvent.setup()
    render(CloudDialog)
    const url = await screen.findByLabelText('API base URL')
    await user.clear(url)
    await user.type(url, 'http://api.example.com')
    expect(screen.getByText(/plain http/)).toBeInTheDocument()
    await user.clear(url)
    await user.type(url, 'http://localhost:8080')
    expect(screen.queryByText(/plain http/)).toBeNull()
  })

  it('shows the protocol-incompatible message when a linked workspace reports serverUnsupported', async () => {
    const ws = app.workspaceId!
    await signInMock(b)
    await sync.publish(ws)
    await b.cloud.runCycle(ws)
    b.cloud.setServerProtocol(1)
    await flush()
    render(CloudDialog)
    const warning = await screen.findByTestId('protocol-warning')
    expect(warning).toHaveTextContent('too old for collection sync')
    expect(screen.getByRole('button', { name: /Sync now/ })).toBeDisabled()
  })

  it('a publish refused by an old server surfaces its message', async () => {
    await signInMock(b)
    b.cloud.setServerProtocol(1)
    await expect(sync.publish(app.workspaceId!)).rejects.toMatchObject({ code: 'sync_blocked', message: expect.stringContaining('too old') })
  })

  it('signed in offline: identity stays, with an offline note; signing out returns to sign-in', async () => {
    const user = userEvent.setup()
    await signInMock(b)
    b.cloud.setOffline(true)
    render(CloudDialog)
    expect(await screen.findByText(/Offline: the server cannot be reached/)).toBeInTheDocument()
    b.cloud.setOffline(false)
    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  })
})

describe('CloudDialog workspace section', () => {
  it('unlinked, signed in: publish and link buttons open the flows', async () => {
    const user = userEvent.setup()
    await signInMock(b)
    render(CloudDialog)
    await user.click(await screen.findByRole('button', { name: /Publish to cloud/ }))
    expect(ui.publishOpen).toBe(true)
    ui.publishOpen = false
    await user.click(screen.getByRole('button', { name: /Link a cloud workspace/ }))
    expect(ui.linkOpen).toEqual({ remoteId: null })
  })

  it('linked: shows role, status, last synced and pending count; sync now / auto sync / unlink (with pending count)', async () => {
    const user = userEvent.setup()
    const ws = app.workspaceId!
    await signInMock(b)
    await sync.publish(ws)
    await b.cloud.runCycle(ws)
    await b.renameCollection(app.collections[0]!.id, 'edited')
    render(CloudDialog)
    const panel = await screen.findByTestId('sync-panel')
    await waitFor(() => expect(panel).toHaveTextContent('Synced with Personal'))
    expect(panel).toHaveTextContent('owner')
    expect(panel).toHaveTextContent('1 change')
    await user.click(within(panel).getByRole('button', { name: 'Sync now' }))
    await waitFor(() => expect(panel).toHaveTextContent('0 changes'))
    await user.click(within(panel).getByRole('checkbox', { name: 'Auto sync' }))
    await waitFor(() => expect(sync.current?.autoSync).toBe(false))
    await b.renameCollection(app.collections[0]!.id, 'again')
    await user.click(within(panel).getByRole('button', { name: 'Unlink' }))
    const confirm = await screen.findByRole('dialog', { name: 'Unlink workspace' })
    expect(confirm).toHaveTextContent('has not been uploaded')
    await user.click(within(confirm).getByRole('button', { name: 'Unlink' }))
    await waitFor(() => expect(screen.getByTestId('sync-panel')).toHaveTextContent('Local only'))
  })

  it('shows the legacy hint for a workspace that used to be "linked", and it can be dismissed', async () => {
    const user = userEvent.setup()
    await signInMock(b)
    sync.legacyLinks = [{ localWorkspaceId: app.workspaceId!, remoteName: 'Old Team' }]
    render(CloudDialog)
    const hint = await screen.findByTestId('legacy-hint')
    expect(hint).toHaveTextContent('Old Team')
    await user.click(within(hint).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByTestId('legacy-hint')).toBeNull()
  })

  it('remote list: roles, read-only hint, linked ones say where, Link opens the flow preselected', async () => {
    const user = userEvent.setup()
    await signInMock(b)
    render(CloudDialog)
    const list = await screen.findByRole('list', { name: 'Cloud workspaces' })
    expect(list).toHaveTextContent('Shared Docs')
    expect(list).toHaveTextContent('viewer (read-only)')
    const payments = within(list).getByText('Payments API').closest('li')!
    await user.click(within(payments).getByRole('button', { name: /Link/ }))
    expect(ui.linkOpen?.remoteId).toBe(sync.remotes.find((r) => r.name === 'Payments API')!.id)
  })

  it('a failing remote list shows the error inline', async () => {
    await signInMock(b)
    b.cloud.setOffline(true)
    render(CloudDialog)
    expect(await screen.findByText(/Could not reach/)).toBeInTheDocument()
  })
})
