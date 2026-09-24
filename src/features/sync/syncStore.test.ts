import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../app/state.svelte'
import { toast } from '../../app/toast.svelte'
import { ui } from '../../app/ui.svelte'
import { tabsStore } from '../requests/tabs.svelte'
import { sync } from './syncStore.svelte'
import { flush, selectWorkspaceByName, setupSync, signInMock, teardownSync, type Backend } from './testUtils'

let b: Backend
beforeEach(async () => {
  b = await setupSync()
})
afterEach(teardownSync)

async function publishPersonal() {
  const id = app.workspaceId!
  await signInMock(b)
  await sync.publish(id)
  await b.cloud.runCycle(id)
  await flush()
  return id
}
const remoteId = async (ws: string) => (await b.getSyncStatus(ws)).remoteWorkspaceId!

describe('init and account', () => {
  it('loads session, config and statuses and subscribes to events once', async () => {
    expect(sync.session?.status).toBe('signedOut')
    expect(sync.config?.apiBaseUrl).toBe('https://api.slinger.app')
    await sync.init() // idempotent
    await signInMock(b)
    expect(sync.session?.status).toBe('signedIn')
    expect(sync.signedIn).toBe(true)
  })

  it('moves a legacy localStorage config to the main process on first init', async () => {
    sync.reset()
    localStorage.setItem('slinger.cloud.config', JSON.stringify({ apiBaseUrl: 'http://127.0.0.1:9000', deviceName: 'Old' }))
    localStorage.setItem('slinger.cloud.links', JSON.stringify({ x: { [app.workspaceId!]: { remoteId: 'r', remoteName: 'Legacy Team' } } }))
    await sync.init()
    expect(await b.getCloudConfig()).toEqual({ apiBaseUrl: 'http://127.0.0.1:9000', deviceName: 'Old' })
    expect(sync.legacyLinks).toEqual([{ localWorkspaceId: app.workspaceId, remoteName: 'Legacy Team' }])
    expect(localStorage.getItem('slinger.cloud.links')).toBeNull()
    sync.dismissLegacy(app.workspaceId!)
    expect(sync.legacyLinks).toEqual([])
  })

  it('device flow: waiting -> approved, with the code in the state', async () => {
    await sync.startSignIn()
    expect(sync.signIn.phase).toBe('waiting')
    expect(sync.signIn.info?.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
    expect(sync.signIn.expiresAt).toBeGreaterThan(Date.now() / 1000)
    b.cloud.approveSignIn()
    await flush()
    expect(sync.signIn.phase).toBe('approved')
    expect(sync.session?.status).toBe('signedIn')
    expect(sync.session?.user?.email).toBe('ana@example.com')
  })

  it.each([
    ['denySignIn', 'denied'],
    ['expireSignIn', 'expired'],
  ] as const)('device flow end states: %s', async (control, phase) => {
    await sync.startSignIn()
    b.cloud[control]()
    await flush()
    expect(sync.signIn.phase).toBe(phase)
    expect(sync.signIn.message).toBeTruthy()
    expect(sync.session?.status).toBe('signedOut')
  })

  it('cancel and a failing start (offline)', async () => {
    await sync.startSignIn()
    await sync.cancelSignIn()
    expect(sync.signIn.phase).toBe('cancelled')
    b.cloud.setOffline(true)
    await sync.startSignIn()
    expect(sync.signIn.phase).toBe('error')
    expect(sync.signIn.message).toContain('Could not reach')
  })

  it('sign out clears the remote list without a "signed out" toast', async () => {
    const id = await publishPersonal()
    await sync.loadRemotes()
    expect(sync.remotes.length).toBeGreaterThan(0)
    toast.clear()
    await sync.signOut()
    expect(sync.signedIn).toBe(false)
    expect(sync.remotes).toEqual([])
    expect(sync.statusOf(id)?.state).toBe('signedOut')
    expect(toast.items.some((t) => t.title.includes('Signed out'))).toBe(false)
  })

  it('a dropped session shows a toast that opens the cloud dialog', async () => {
    await publishPersonal()
    toast.clear()
    b.cloud.expireAuth()
    await flush()
    const t = toast.items.find((x) => x.title === 'Signed out of Slinger Cloud')!
    expect(t).toBeTruthy()
    t.action!.run()
    expect(ui.cloudOpen).toBe(true)
  })
})

describe('status events', () => {
  it('drive the chip and the per-workspace status', async () => {
    const id = await publishPersonal()
    expect(sync.chip.kind).toBe('idle')
    b.cloud.setOffline(true)
    await sync.syncNow(id)
    expect(sync.chip.kind).toBe('offline')
    b.cloud.setOffline(false)
    await sync.syncNow(id)
    expect(sync.chip.kind).toBe('idle')
    expect(sync.current?.lastSyncedAt).not.toBeNull()
  })

  it('pending changes appear after local edits of a linked workspace', async () => {
    const id = await publishPersonal()
    const col = app.collections[0]!
    await b.renameCollection(col.id, 'Renamed')
    expect((await b.getSyncStatus(id)).pendingChanges).toBe(1)
  })

  it('pending changes follow the user\'s own edits without a cycle (debounced re-read, no polling)', async () => {
    const id = await publishPersonal()
    await sync.setAutoSync(id, false)
    const before = b.calls.filter((c) => c.method === 'getSyncStatus').length
    await b.renameCollection(app.collections[0]!.id, 'Edited locally')
    await app.reloadCollections()
    await app.reloadCollections()
    expect(sync.current?.pendingChanges).toBe(0) // not yet: debounced
    await flush(500)
    expect(sync.current?.pendingChanges).toBe(1)
    expect(b.calls.filter((c) => c.method === 'getSyncStatus').length - before).toBe(1) // one read for the whole burst
    await flush(600)
    expect(b.calls.filter((c) => c.method === 'getSyncStatus').length - before).toBe(1) // and nothing afterwards
  })

  it('toasts a failed sync once, with a Retry that runs another cycle', async () => {
    const id = await publishPersonal()
    toast.clear()
    sync.handleEvent({ type: 'status', status: { ...(await b.getSyncStatus(id)), state: 'error', lastError: { code: 'internal_error', message: 'boom' } } })
    sync.handleEvent({ type: 'status', status: { ...(await b.getSyncStatus(id)), state: 'error', lastError: { code: 'internal_error', message: 'boom' } } })
    const errors = toast.items.filter((t) => t.kind === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0].detail).toBe('boom')
    const spy = vi.spyOn(b, 'syncNow')
    errors[0].action!.run()
    await flush()
    expect(spy).toHaveBeenCalledWith(id)
  })

  it('one conflict toast that is replaced (not stacked) and has a Review action', async () => {
    const id = await publishPersonal()
    toast.clear()
    const s = await b.getSyncStatus(id)
    sync.handleEvent({ type: 'status', status: { ...s, openConflicts: 2 } })
    sync.handleEvent({ type: 'status', status: { ...s, openConflicts: 3 } })
    const t = toast.items.filter((x) => x.title.includes('sync conflict'))
    expect(t).toHaveLength(1)
    expect(t[0].title).toBe('3 sync conflicts')
    t[0].action!.run()
    await flush()
    expect(ui.conflictsOpen).toBe(true)
  })

  it('no conflict toast while the conflict center is open', async () => {
    const id = await publishPersonal()
    toast.clear()
    ui.conflictsOpen = true
    sync.handleEvent({ type: 'status', status: { ...(await b.getSyncStatus(id)), openConflicts: 1 } })
    expect(toast.items).toHaveLength(0)
  })

  it('announces role changes and lost access', async () => {
    const id = await publishPersonal()
    toast.clear()
    const s = await b.getSyncStatus(id)
    sync.handleEvent({ type: 'status', status: { ...s, readOnly: true, role: 'viewer' } })
    expect(toast.items.map((t) => t.title)).toContain('Workspace is now read-only')
    sync.handleEvent({ type: 'status', status: { ...s, state: 'accessRevoked' } })
    expect(toast.items.map((t) => t.title)).toContain('Cloud access lost')
  })

  it('serverUnsupported is reported for the account panel', async () => {
    await publishPersonal()
    b.cloud.setServerProtocol(1)
    await flush()
    expect(sync.serverUnsupported).toBe(true)
    expect(toast.items.some((t) => t.title === 'Cloud server not supported')).toBe(true)
  })
})

describe('read-only gating state', () => {
  it('is blocked for viewer workspaces and revoked ones, not for others', async () => {
    await signInMock(b)
    expect(sync.blocked).toBe(false)
    const docs = (await sync.loadRemotes(), sync.remotes.find((r) => r.name === 'Shared Docs')!)
    const res = await sync.link({ remoteWorkspaceId: docs.id, localWorkspaceId: null })
    await b.cloud.runCycle(res.workspace.id)
    await app.refreshWorkspaces()
    await app.selectWorkspace(res.workspace.id)
    await flush()
    expect(sync.blocked).toBe(true)
    expect(sync.blockReason).toBe('readOnly')
    expect(sync.blockedMessage).toContain('Shared Docs')
    expect(sync.isBlocked(res.workspace.id)).toBe(true)
    // role upgrade unblocks
    b.cloud.setRole(docs.id, 'editor')
    await sync.syncNow(res.workspace.id)
    expect(sync.blocked).toBe(false)
    b.cloud.revokeAccess(docs.id)
    await sync.syncNow(res.workspace.id)
    expect(sync.blockReason).toBe('accessRevoked')
    // the other workspace is unaffected
    await selectWorkspaceByName('Personal')
    expect(sync.blocked).toBe(false)
  })
})

describe('applied events refresh the UI', () => {
  it('reloads collections and environments of the open workspace', async () => {
    const id = await publishPersonal()
    const rid = await remoteId(id)
    const col = app.collections[0]!
    b.cloud.remoteEdit(rid, 'collection', col.id, { name: 'Renamed remotely' })
    const env = app.environments[0]!
    b.cloud.remoteEdit(rid, 'environment', env.id, { name: 'Env remote' })
    await b.syncNow(id)
    await flush(400)
    expect(app.collections.find((c) => c.id === col.id)?.name).toBe('Renamed remotely')
    expect(app.environments.find((e) => e.id === env.id)?.name).toBe('Env remote')
  })

  it('ignores applied events of other workspaces', async () => {
    await publishPersonal()
    const spy = vi.spyOn(app, 'reloadCollections')
    sync.handleEvent({ type: 'applied', workspaceId: 'someone-else', changed: [], truncated: false })
    await flush(300)
    expect(spy).not.toHaveBeenCalled()
  })

  it('a clean open tab reloads silently; a dirty one keeps its edits and gets a "changed" notice', async () => {
    const id = await publishPersonal()
    const rid = await remoteId(id)
    const [r1, r2] = app.requests.slice(0, 2)
    const clean = tabsStore.openRequest(r1)
    const dirty = tabsStore.openRequest(r2)
    dirty.draft.url = 'https://typed-by-user.example'
    expect(dirty.dirty).toBe(true)
    b.cloud.remoteEdit(rid, 'request', r1.id, { url: 'https://cloud-1.example', document_json: JSON.stringify({ ...JSON.parse(r1.documentJson), url: 'https://cloud-1.example' }) })
    b.cloud.remoteEdit(rid, 'request', r2.id, { url: 'https://cloud-2.example', document_json: JSON.stringify({ ...JSON.parse(r2.documentJson), url: 'https://cloud-2.example' }) })
    await b.syncNow(id)
    await flush(400)
    expect(clean.draft.url).toBe('https://cloud-1.example')
    expect(clean.remoteNotice).toBeNull()
    expect(dirty.draft.url).toBe('https://typed-by-user.example') // never clobbered
    expect(dirty.remoteNotice?.kind).toBe('changed')
  })

  it('a dirty tab whose request was deleted remotely stays open, detached, with a "deleted" notice', async () => {
    const id = await publishPersonal()
    const rid = await remoteId(id)
    const r = app.requests[0]!
    const tab = tabsStore.openRequest(r)
    tab.draft.name = 'my unsaved name'
    b.cloud.remoteDelete(rid, 'request', r.id)
    await b.syncNow(id)
    await flush(400)
    expect(tabsStore.tabs).toContain(tab)
    expect(tab.requestId).toBeNull()
    expect(tab.draft.name).toBe('my unsaved name')
    expect(tab.remoteNotice).toEqual({ kind: 'deleted' })
  })
})

describe('conflicts and actions', () => {
  it('loads, resolves and refreshes conflicts; errors are thrown to the caller', async () => {
    const out = await b.cloud.scenario('conflicts')
    await selectWorkspaceByName('Personal')
    await sync.refreshStatuses()
    await sync.loadConflicts()
    expect(sync.conflicts.length).toBe(6)
    const rej = sync.conflicts.find((c) => c.kind === 'rejected')!
    await expect(sync.resolve({ conflictId: rej.id, resolution: 'keep_local' })).rejects.toMatchObject({ code: 'invalid_input' })
    await sync.resolve({ conflictId: rej.id, resolution: 'keep_remote' })
    expect(sync.conflicts.some((c) => c.id === rej.id)).toBe(false)
    expect(sync.current?.openConflicts).toBe(5)
    expect(out.workspaceId).toBe(app.workspaceId)
  })

  it('unlink and discard update the status; failures toast', async () => {
    const id = await publishPersonal()
    await b.renameCollection(app.collections[0]!.id, 'Local rename')
    expect(await sync.discardPending(id)).toBe(true)
    expect(app.collections[0]!.name).not.toBe('Local rename')
    expect(await sync.unlink(id)).toBe(true)
    expect(sync.current?.linked).toBe(false)
    toast.clear()
    b.failNext('unlinkWorkspace', { code: 'internal_error', message: 'nope' })
    expect(await sync.unlink(id)).toBe(false)
    expect(toast.items[0].detail).toBe('nope')
  })

  it('auto sync toggle', async () => {
    const id = await publishPersonal()
    await sync.setAutoSync(id, false)
    expect(sync.current?.autoSync).toBe(false)
  })

  it('syncNow failure toasts with Retry', async () => {
    const id = await publishPersonal()
    toast.clear()
    b.failNext('syncNow', { code: 'internal_error', message: 'exploded' })
    await sync.syncNow(id)
    expect(toast.items[0]).toMatchObject({ title: 'Sync failed', detail: 'exploded' })
    expect(toast.items[0].action?.label).toBe('Retry')
  })
})
