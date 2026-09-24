import { cleanup, render, screen, waitFor, within } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../app/state.svelte'
import { toast } from '../../app/toast.svelte'
import { ui } from '../../app/ui.svelte'
import { duplicateWorkspace, isIdInUse } from './duplicateWorkspace'
import LinkDialog from './LinkDialog.svelte'
import PublishDialog from './PublishDialog.svelte'
import { sync } from './syncStore.svelte'
import { flush, setupSync, signInMock, teardownSync, type Backend } from './testUtils'

let b: Backend
beforeEach(async () => {
  b = await setupSync()
})
afterEach(() => {
  cleanup()
  teardownSync()
})

describe('duplicateWorkspace', () => {
  it('copies collections, nested folders, requests and environments with fresh ids (secrets stay local)', async () => {
    const src = app.workspaceId!
    const progress: number[] = []
    const copy = await duplicateWorkspace(src, 'Personal (copy)', (p) => progress.push(p.done))
    expect(copy.id).not.toBe(src)
    const [a, c] = [await b.listCollections(src), await b.listCollections(copy.id)]
    expect(c.map((x) => x.name)).toEqual(a.map((x) => x.name))
    expect(c.map((x) => x.id).some((id) => a.some((y) => y.id === id))).toBe(false)
    const demoA = a.find((x) => x.name === 'Demo API')!
    const demoC = c.find((x) => x.name === 'Demo API')!
    const [fa, fc] = [await b.listFolders(demoA.id), await b.listFolders(demoC.id)]
    expect(fc).toHaveLength(fa.length)
    const admin = fc.find((f) => f.name === 'Admin')!
    expect(fc.find((f) => f.id === admin.parentFolderId)?.name).toBe('Users') // nesting preserved
    const [ra, rc] = [await b.listRequests(demoA.id), await b.listRequests(demoC.id)]
    expect(rc).toHaveLength(ra.length)
    const delUser = rc.find((r) => r.name === 'Delete user')!
    expect(fc.find((f) => f.id === delUser.folderId)?.name).toBe('Admin')
    const perFolder = (reqs: typeof ra, folders: typeof fa) =>
      Object.fromEntries([...new Set(reqs.map((r) => r.folderId))].map((id) => [folders.find((f) => f.id === id)?.name ?? '(root)', reqs.filter((r) => r.folderId === id).map((r) => r.name)]))
    expect(perFolder(rc, fc)).toEqual(perFolder(ra, fa)) // order within every folder kept
    const envs = await b.listEnvironments(copy.id)
    expect(envs.map((e) => e.name).sort()).toEqual(['Local', 'Staging'])
    const local = envs.find((e) => e.name === 'Local')!
    const secret = (await b.listEnvironmentVariables(local.id)).find((v) => v.key === 'apiToken')!
    expect(secret.isSecret).toBe(true)
    expect(await b.revealEnvironmentVariable(secret.id)).toBe('sk_live_demo_123')
    expect(progress.at(-1)).toBeGreaterThan(30)
    expect(progress).toEqual([...progress].sort((x, y) => x - y))
  })

  it('recognises the "id in use" wording', () => {
    expect(isIdInUse("Rejected: this item's id is already used by another cloud workspace.")).toBe(true)
    expect(isIdInUse('id in use')).toBe(true)
    expect(isIdInUse('Name too long')).toBe(false)
    expect(isIdInUse(null)).toBe(false)
  })
})

describe('PublishDialog', () => {
  it('confirms what is uploaded, uploads, and reports done', async () => {
    const user = userEvent.setup()
    await signInMock(b)
    ui.publishOpen = true
    render(PublishDialog)
    const counts = await screen.findByTestId('publish-counts')
    expect(counts).toHaveTextContent('2 collections with 28 requests')
    expect(counts).toHaveTextContent('2 environments')
    expect(screen.getByText(/Secret variable values are never uploaded/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Publish' }))
    // Uploading runs in the (mock) background; drive the cycle to completion.
    await waitFor(() => expect(sync.current?.linked).toBe(true))
    await b.cloud.runCycle(app.workspaceId!)
    expect(await screen.findByText(/Published\./)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument()
    expect(sync.current?.pendingChanges).toBe(0)
  })

  it('shows a refused publish inline and stays on the confirm step', async () => {
    const user = userEvent.setup()
    await signInMock(b)
    b.failNext('publishWorkspace', { code: 'sync_blocked', message: 'Sync is blocked right now' })
    ui.publishOpen = true
    render(PublishDialog)
    await user.click(await screen.findByRole('button', { name: 'Publish' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Sync is blocked right now')
    expect(screen.getByRole('button', { name: 'Publish' })).toBeEnabled()
  })

  it('"id in use": offers Publish a copy, which unlinks, copies with fresh ids and publishes the copy', async () => {
    const user = userEvent.setup()
    const src = app.workspaceId!
    await signInMock(b)
    await sync.publish(src)
    await b.cloud.runCycle(src)
    await sync.unlink(src)
    ui.publishOpen = true
    render(PublishDialog)
    await user.click(await screen.findByRole('button', { name: 'Publish' }))
    await waitFor(() => expect(sync.statusOf(src)?.linked).toBe(true))
    await b.cloud.runCycle(src) // every id is already used by the first publication
    const clash = await screen.findByTestId('id-clash')
    expect(clash).toHaveTextContent('already exist in another cloud workspace')
    await user.click(screen.getByRole('button', { name: 'Publish a copy' }))
    await waitFor(() => expect(app.workspace?.name).toBe('Personal (copy)'), { timeout: 4000 })
    const copyId = app.workspaceId!
    expect(sync.statusOf(src)?.linked).toBe(false) // the clashing link was removed first
    await waitFor(() => expect(sync.statusOf(copyId)?.linked).toBe(true))
    const done = await b.cloud.runCycle(copyId)
    expect(done.openConflicts).toBe(0)
    expect(done.pendingChanges).toBe(0)
    expect(toast.items.some((t) => t.title === 'Published a copy')).toBe(true)
  })

  it('an "id in use" error thrown by publishWorkspace itself also leads to the copy offer', async () => {
    await signInMock(b)
    b.failNext('publishWorkspace', { code: 'sync_blocked', message: "Rejected: this item's id is already used by another cloud workspace" })
    const user = userEvent.setup()
    ui.publishOpen = true
    render(PublishDialog)
    await user.click(await screen.findByRole('button', { name: 'Publish' }))
    expect(await screen.findByTestId('id-clash')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Publish a copy' })).toBeInTheDocument()
  })
})

describe('LinkDialog', () => {
  it('previews the remote, recommends downloading into a new workspace, and links it', async () => {
    const user = userEvent.setup()
    await signInMock(b)
    await sync.loadRemotes()
    const payments = sync.remotes.find((r) => r.name === 'Payments API')!
    ui.linkOpen = { remoteId: payments.id }
    render(LinkDialog)
    const preview = await screen.findByTestId('link-preview')
    expect(preview).toHaveTextContent('It already has content')
    expect(preview).toHaveTextContent(/It already has content: \d+ collections?, \d+ requests?, \d+ environments?\./)
    expect(preview).toHaveTextContent('your role: editor')
    expect(screen.getByRole('radio', { name: /Download into a new workspace/ })).toBeChecked()
    expect(screen.queryByTestId('merge-warning')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Link and download' }))
    await waitFor(() => expect(ui.linkOpen).toBeNull())
    expect(app.workspace?.name).toBe('Payments API')
    expect(app.workspace?.workspaceType).toBe('team')
    expect(sync.current?.linked).toBe(true)
    // the previous workspace is untouched
    expect((await b.listWorkspaces()).some((w) => w.name === 'Personal')).toBe(true)
  })

  it('merge: explains the union/dedupe outcome, shows local counts and links into the current workspace', async () => {
    const user = userEvent.setup()
    const local = app.workspaceId!
    await signInMock(b)
    await sync.loadRemotes()
    ui.linkOpen = { remoteId: sync.remotes.find((r) => r.name === 'Payments API')!.id }
    render(LinkDialog)
    await screen.findByTestId('link-preview')
    await user.click(screen.getByRole('radio', { name: /Merge into “Personal”/ }))
    const warning = screen.getByTestId('merge-warning')
    expect(warning).toHaveTextContent('kept side by side')
    expect(warning).toHaveTextContent('Environments with the same name are combined')
    expect(warning).toHaveTextContent('Secret values stay on this device')
    expect(screen.getByText(/2 collections, 28 requests, 2 environments/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Link and merge' }))
    await waitFor(() => expect(ui.linkOpen).toBeNull())
    expect(app.workspaceId).toBe(local)
    expect(sync.statusOf(local)?.linked).toBe(true)
  })

  it('an empty remote is recommended for merge and says so', async () => {
    await signInMock(b)
    await sync.loadRemotes()
    ui.linkOpen = { remoteId: sync.remotes.find((r) => r.name === 'Empty Team')!.id }
    render(LinkDialog)
    expect(await screen.findByTestId('link-preview')).toHaveTextContent('It is empty')
    expect(screen.getByRole('radio', { name: /Merge into/ })).toBeChecked()
  })

  it('a viewer remote can only be downloaded, with the reason', async () => {
    await signInMock(b)
    await sync.loadRemotes()
    ui.linkOpen = { remoteId: sync.remotes.find((r) => r.name === 'Shared Docs')!.id }
    render(LinkDialog)
    expect(await screen.findByTestId('link-forced')).toHaveTextContent('read-only access')
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.getByRole('button', { name: 'Link and download' })).toBeEnabled()
  })

  it('link errors stay in the dialog', async () => {
    const user = userEvent.setup()
    await signInMock(b)
    await sync.loadRemotes()
    ui.linkOpen = { remoteId: sync.remotes.find((r) => r.name === 'Payments API')!.id }
    render(LinkDialog)
    await screen.findByTestId('link-preview')
    b.failNext('linkRemoteWorkspace', { code: 'sync_blocked', message: 'Already linked elsewhere' })
    await user.click(screen.getByRole('button', { name: 'Link and download' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Already linked elsewhere')
    expect(ui.linkOpen).not.toBeNull()
    await flush()
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' })).toBeEnabled()
  })

  it('offers only unlinked remotes', async () => {
    await signInMock(b)
    await sync.loadRemotes()
    const payments = sync.remotes.find((r) => r.name === 'Payments API')!
    await sync.link({ remoteWorkspaceId: payments.id, localWorkspaceId: null })
    await sync.loadRemotes()
    ui.linkOpen = { remoteId: null }
    render(LinkDialog)
    const select = await screen.findByLabelText('Cloud workspace')
    expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['Choose…', 'Shared Docs (viewer)', 'Empty Team (owner)'])
  })
})
