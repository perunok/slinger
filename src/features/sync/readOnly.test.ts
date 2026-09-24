import { cleanup, render, screen, waitFor, within } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../app/state.svelte'
import { toast } from '../../app/toast.svelte'
import { ui } from '../../app/ui.svelte'
import { READ_ONLY_MESSAGE, errorInfo } from '../../lib/ipc'
import CollectionsPanel from '../collections/CollectionsPanel.svelte'
import EnvironmentEditor from '../environments/EnvironmentEditor.svelte'
import RequestView from '../requests/RequestView.svelte'
import { tabsStore } from '../requests/tabs.svelte'
import VersionsPanel from '../versions/VersionsPanel.svelte'
import SyncBanner from './SyncBanner.svelte'
import { sync } from './syncStore.svelte'
import { flush, setupSync, signInMock, teardownSync, type Backend } from './testUtils'

let b: Backend

/** Links the remote workspace `name` (role forced to `role`) into a new local workspace and opens it. */
async function openLinked(name: string, role: 'viewer' | 'editor' = 'viewer'): Promise<string> {
  await signInMock(b)
  const rid = b.cloud.findRemote(name)!
  b.cloud.setRole(rid, role)
  await sync.loadRemotes()
  const res = await sync.link({ remoteWorkspaceId: rid, localWorkspaceId: null })
  await b.cloud.runCycle(res.workspace.id)
  await app.refreshWorkspaces()
  await app.selectWorkspace(res.workspace.id)
  await flush()
  return res.workspace.id
}

beforeEach(async () => {
  b = await setupSync()
})
afterEach(() => {
  cleanup()
  teardownSync()
})

describe('error mapping', () => {
  it('read_only rejections get one friendly message everywhere', () => {
    const e = { name: 'IpcError', code: 'read_only', message: 'slinger:read_only raw text' }
    expect(errorInfo(e)).toMatchObject({ code: 'read_only', message: READ_ONLY_MESSAGE })
    expect(errorInfo(new Error("Error invoking remote method 'x': IpcError: read_only")).code).toBe('read_only')
  })
})

describe('read-only workspace', () => {
  it('banner explains, offers unlink, and the chip says Read-only', async () => {
    const user = userEvent.setup()
    await openLinked('Shared Docs')
    render(SyncBanner)
    const banner = screen.getByTestId('readonly-banner')
    expect(banner.dataset.reason).toBe('readOnly')
    expect(banner).toHaveTextContent('Shared Docs')
    expect(sync.chip.kind).toBe('readOnly')
    await user.click(within(banner).getByRole('button', { name: /Unlink and keep as local copy/ }))
    const confirm = await screen.findByRole('dialog', { name: 'Unlink workspace' })
    await user.click(within(confirm).getByRole('button', { name: 'Unlink' }))
    await waitFor(() => expect(sync.blocked).toBe(false))
    expect(screen.queryByTestId('readonly-banner')).toBeNull()
  })

  it('no banner for editable and unlinked workspaces', async () => {
    render(SyncBanner)
    expect(screen.queryByTestId('readonly-banner')).toBeNull()
    await openLinked('Payments API', 'editor')
    expect(screen.queryByTestId('readonly-banner')).toBeNull()
  })

  it('collections tree: creation, import, rename/delete keys and mutating menu entries are gone', async () => {
    const user = userEvent.setup()
    await openLinked('Shared Docs')
    render(CollectionsPanel)
    expect(screen.getByRole('button', { name: 'New collection' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Import Postman collection' })).toBeDisabled()
    const row = await screen.findByRole('treeitem', { name: /Reference/ })
    if (row.getAttribute('aria-expanded') !== 'true') await user.click(row)
    const request = await screen.findByRole('treeitem', { name: /Status/ })
    expect(request.getAttribute('draggable')).toBe('true') // attribute stays, the drag is cancelled in the handler
    request.focus()
    await user.keyboard('{F2}')
    expect(screen.queryByRole('dialog', { name: /Rename/ })).toBeNull()
    await user.keyboard('{Delete}')
    expect(screen.queryByRole('dialog', { name: /Delete/ })).toBeNull()
    expect(toast.items.some((t) => t.title === 'Read-only workspace')).toBe(true)
    await user.pointer({ keys: '[MouseRight]', target: request })
    const menu = await screen.findByRole('menu')
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent?.replace(/Enter/, '').trim())).toEqual(['Open'])
    await user.keyboard('{Escape}')
    await user.pointer({ keys: '[MouseRight]', target: row })
    const cmenu = await screen.findByRole('menu')
    const labels = within(cmenu).getAllByRole('menuitem').map((i) => i.textContent ?? '')
    expect(labels.some((l) => /Run collection/.test(l))).toBe(true)
    expect(labels.some((l) => /Versions/.test(l))).toBe(true)
    expect(labels.some((l) => /Export/.test(l))).toBe(true)
    expect(labels.some((l) => /New request|New folder|Rename|Delete/.test(l))).toBe(false)
  })

  it('an editable linked workspace keeps every action', async () => {
    await openLinked('Payments API', 'editor')
    render(CollectionsPanel)
    expect(screen.getByRole('button', { name: 'New collection' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Import Postman collection' })).toBeEnabled()
  })

  it('request editor: Save and Save As are disabled with the reason; drafts can still be edited and sent', async () => {
    await openLinked('Shared Docs')
    const req = app.requests[0]!
    const tab = tabsStore.openRequest(req)
    render(RequestView, { tab })
    tab.draft.url = 'https://changed.example'
    await flush()
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save As…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Send/ })).toBeEnabled()
    expect(screen.getByTestId('readonly-note')).toHaveTextContent('read-only')
  })

  it('a save that reaches the main process anyway is rejected with the friendly message', async () => {
    await openLinked('Shared Docs')
    const tab = tabsStore.openRequest(app.requests[0]!)
    tab.draft.url = 'https://x.example'
    expect(await tabsStore.save(tab)).toBe(false)
    expect(toast.items.at(-1)).toMatchObject({ title: 'Could not save request', detail: READ_ONLY_MESSAGE })
    expect(tab.dirty).toBe(true) // edits are never lost
  })

  it('versions: create is disabled, restore/delete are disabled, with a note', async () => {
    const user = userEvent.setup()
    // The Personal workspace becomes read-only after a downgrade.
    await signInMock(b)
    const ws = app.workspaceId!
    await sync.publish(ws)
    await b.cloud.runCycle(ws)
    const col = app.collections.find((c) => c.name === 'Demo API')!
    b.cloud.setRole((await b.getSyncStatus(ws)).remoteWorkspaceId!, 'viewer')
    await sync.syncNow(ws)
    render(VersionsPanel, { collectionId: col.id, onclose: () => {} })
    expect(await screen.findByRole('button', { name: 'Create version' })).toBeDisabled()
    expect(screen.getByTestId('readonly-note')).toBeInTheDocument()
    await user.click(await screen.findByRole('option', { name: /1\.0\.0/ }))
    expect(await screen.findByRole('button', { name: /Restore/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled()
  })

  it('environments: everything is disabled except giving a stored/missing secret a value', async () => {
    const user = userEvent.setup()
    await openLinked('Payments API', 'viewer')
    const prod = app.environments.find((e) => e.name === 'Production')!
    ui.envEditor = { open: true, environmentId: prod.id }
    render(EnvironmentEditor)
    const secretInput = await screen.findByLabelText('Secret value: apiKey')
    expect(screen.getByTestId('readonly-note')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New environment' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Rename environment' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete environment' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Bulk edit' })).toBeDisabled()
    expect(screen.getByLabelText('Variable name: baseUrl')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete variable baseUrl' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Secret: baseUrl' })).toBeDisabled()
    // ... but the missing secret can get a value on this device
    expect(secretInput).toBeEnabled()
    await user.type(secretInput, 'my-key')
    expect(screen.queryByTestId('secret-missing')).toBeNull()
    await waitFor(async () => expect((await b.listEnvironmentVariables(prod.id)).find((v) => v.key === 'apiKey')?.secretMissing).toBe(false), { timeout: 4000 })
  })

  it('access revoked disables edits too, with its own banner text', async () => {
    const id = await openLinked('Payments API', 'editor')
    b.cloud.revokeAccess(b.cloud.findRemote('Payments API')!)
    await sync.syncNow(id)
    render(SyncBanner)
    const banner = await screen.findByTestId('readonly-banner')
    expect(banner.dataset.reason).toBe('accessRevoked')
    expect(banner).toHaveTextContent('Cloud access lost')
    expect(sync.blocked).toBe(true)
  })

  it('discard local changes appears when a downgrade left pending changes', async () => {
    const user = userEvent.setup()
    const id = await openLinked('Payments API', 'editor')
    await b.renameCollection(app.collections[0]!.id, 'Renamed offline')
    b.cloud.setRole(b.cloud.findRemote('Payments API')!, 'viewer')
    await sync.syncNow(id)
    render(SyncBanner)
    const banner = await screen.findByTestId('readonly-banner')
    expect(banner).toHaveTextContent("1 local change can't be uploaded")
    await user.click(within(banner).getByRole('button', { name: 'Discard local changes' }))
    await user.click(within(await screen.findByRole('dialog', { name: 'Discard local changes' })).getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(app.collections[0]!.name).toBe('Payments'))
    expect(sync.current?.pendingChanges).toBe(0)
  })
})
