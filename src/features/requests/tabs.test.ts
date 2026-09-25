import { beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../app/state.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import { RequestTab, tabsStore } from './tabs.svelte'

let backend: ReturnType<typeof createMockBackend>

beforeEach(async () => {
  localStorage.clear()
  backend = createMockBackend({ latencyMs: 0 })
  window.slinger = backend
  window.__slingerMock = backend
  tabsStore.tabs = []
  tabsStore.activeId = null
  await app.init()
  await app.setActiveEnvironment(app.environments.find((e) => e.name === 'Local')!.id)
})

const find = (name: string) => app.requests.find((r) => r.name === name)!

describe('request tabs', () => {
  it('tracks dirty state from the draft, ignoring trailing blank rows', () => {
    const tab = tabsStore.openRequest(find('Get user'))
    expect(tab.dirty).toBe(false)
    tab.draft.name = 'Renamed'
    expect(tab.dirty).toBe(true)
    tab.draft.name = 'Get user'
    expect(tab.dirty).toBe(false)
  })

  it('reuses the tab when the same request is opened twice', () => {
    const a = tabsStore.openRequest(find('Get user'))
    const b = tabsStore.openRequest(find('Get user'))
    expect(a).toBe(b)
    expect(tabsStore.tabs).toHaveLength(1)
  })

  it('saves, adopts the new version and clears dirty', async () => {
    const tab = tabsStore.openRequest(find('Get user'))
    const v = tab.baseVersion
    tab.draft.url = '{{baseUrl}}/json?saved=1'
    expect(await tabsStore.save(tab)).toBe(true)
    expect(tab.baseVersion).toBe(v + 1)
    expect(tab.dirty).toBe(false)
    expect(app.requestById(tab.requestId)!.url).toBe('{{baseUrl}}/json?saved=1')
  })

  it('reports a version conflict, then overwrite succeeds', async () => {
    const tab = tabsStore.openRequest(find('Get user'))
    const server = find('Get user')
    await backend.renameRequest(server.id, 'Changed elsewhere')
    tab.draft.url = '{{baseUrl}}/json?mine=1'
    expect(await tabsStore.save(tab)).toBe(false)
    expect(tab.conflict).not.toBeNull()
    expect(tab.conflict?.serverRequest?.name).toBe('Changed elsewhere')
    expect(await tabsStore.save(tab, { overwrite: true })).toBe(true)
    expect(tab.conflict).toBeNull()
    expect((await backend.listRequests(server.collectionId)).find((r) => r.id === server.id)!.url).toBe('{{baseUrl}}/json?mine=1')
  })

  it('reload from stored discards local edits', async () => {
    const tab = tabsStore.openRequest(find('Get user'))
    await backend.renameRequest(tab.requestId!, 'Server name')
    tab.draft.url = 'http://local-edit'
    await tabsStore.save(tab)
    await tabsStore.reloadFromServer(tab)
    expect(tab.draft.name).toBe('Server name')
    expect(tab.draft.url).not.toBe('http://local-edit')
    expect(tab.dirty).toBe(false)
  })

  it('a save failure other than a conflict leaves the tab dirty and does not throw', async () => {
    const tab = tabsStore.openRequest(find('Get user'))
    tab.draft.name = 'x'
    backend.failNext('updateRequest', { code: 'io_error', message: 'disk full' })
    expect(await tabsStore.save(tab)).toBe(false)
    expect(tab.dirty).toBe(true)
    expect(tab.conflict).toBeNull()
  })

  it('asks before closing dirty tabs and closes clean ones immediately', () => {
    const clean = tabsStore.openRequest(find('Get user'))
    const dirty = tabsStore.openRequest(find('Create user'))
    dirty.draft.name = 'edited'
    tabsStore.requestClose([clean.id])
    expect(tabsStore.tabs).toHaveLength(1)
    tabsStore.requestClose([dirty.id])
    expect(tabsStore.pendingClose?.ids).toEqual([dirty.id])
    expect(tabsStore.tabs).toHaveLength(1)
    tabsStore.closeNow(dirty.id ? [dirty.id] : [])
    expect(tabsStore.tabs).toHaveLength(0)
    expect(tabsStore.pendingClose).toBeNull()
  })

  it('close others keeps only the chosen tab', () => {
    const a = tabsStore.openRequest(find('Get user'))
    tabsStore.openRequest(find('Create user'))
    tabsStore.openRequest(find('Basic auth check'))
    tabsStore.closeOthers(a.id)
    expect(tabsStore.tabs.map((t) => t.id)).toEqual([a.id])
    expect(tabsStore.activeId).toBe(a.id)
  })

  it('Save As turns a new tab into a saved request', async () => {
    const tab = tabsStore.newTab()
    tab.draft.url = 'https://mock.slinger.local/json'
    const col = app.collections[0]
    await tabsStore.saveAs(tab, { collectionId: col.id, folderId: null, name: 'Fresh' })
    expect(tab.requestId).not.toBeNull()
    expect(tab.dirty).toBe(false)
    expect(app.requests.some((r) => r.name === 'Fresh')).toBe(true)
  })

  it('Save As failure throws so the dialog can show it, leaving the tab unsaved', async () => {
    const tab = tabsStore.newTab()
    backend.failNext('createRequest', { code: 'io_error', message: 'nope' })
    await expect(tabsStore.saveAs(tab, { collectionId: app.collections[0].id, folderId: null, name: 'X' })).rejects.toMatchObject({ message: 'nope' })
    expect(tab.requestId).toBeNull()
  })

  it('adopts location-only changes (move) without marking a conflict, and drops tabs of deleted requests', async () => {
    const tab = tabsStore.openRequest(find('Get user'))
    tab.draft.name = 'dirty edit'
    const auth = app.folders.find((f) => f.name === 'Auth')!
    await backend.moveRequest({ requestId: tab.requestId!, targetCollectionId: tab.collectionId!, targetFolderId: auth.id, targetIndex: 0 })
    await app.reloadCollection(tab.collectionId!)
    expect(tab.folderId).toBe(auth.id)
    expect(tab.baseVersion).toBe(app.requestById(tab.requestId)!.version)
    expect(await tabsStore.save(tab)).toBe(true) // no spurious conflict
    await backend.deleteRequest(tab.requestId!)
    await app.reloadCollection(tab.collectionId!)
    expect(tabsStore.tabs).toHaveLength(0)
  })

  it('sends with templates resolved, including secrets, and records the response', async () => {
    const tab = tabsStore.openRequest(find('Basic auth check'))
    tab.draft.url = '{{baseUrl}}/echo'
    tab.draft.auth = { ...tab.draft.auth, kind: 'bearer', bearer: { token: '{{apiToken}}' } }
    const out = await tabsStore.send(tab)
    expect(out?.ok).toBe(true)
    const body = JSON.parse(tab.response!.data.bodyText!)
    expect(body.headers.Authorization).toBe('Bearer sk_live_demo_123')
    expect(tab.error).toBeNull()
    expect(tab.sending).toBe(false)
    expect(tab.lastOutcome).toBe('success') // the loading animation's finish
    expect(tab.sendStartedAt).toBeGreaterThan(0)
  })

  it('a 4xx / 5xx response ends the loading animation as an error', async () => {
    const tab = new RequestTab()
    tab.draft.url = 'https://mock.slinger.local/500'
    tabsStore.tabs.push(tab)
    const out = await tabsStore.send(tab)
    expect(out?.ok).toBe(true)
    expect(tab.lastOutcome).toBe('error')
  })

  it('refuses to send with unresolved variables and lists them', async () => {
    const tab = new RequestTab()
    tab.draft.url = '{{baseUrl}}/{{missingA}}/{{missingB}}'
    tabsStore.tabs.push(tab)
    const out = await tabsStore.send(tab)
    expect(out).toMatchObject({ ok: false, kind: 'unresolved', unresolved: ['missingA', 'missingB'] })
    expect(tab.error?.unresolved).toEqual(['missingA', 'missingB'])
    expect(tab.lastOutcome).toBe('error')
    expect(backend.calls.some((c) => c.method === 'executeHttpRequest')).toBe(false)
  })

  it('cancelling an in-flight send calls cancelHttpRequest and reports it', async () => {
    const tab = new RequestTab()
    tab.draft.url = 'https://mock.slinger.local/slow'
    tabsStore.tabs.push(tab)
    const pending = tabsStore.send(tab)
    await new Promise((r) => setTimeout(r, 30))
    await tabsStore.cancel(tab)
    const out = await pending
    expect(out).toMatchObject({ ok: false, kind: 'cancelled' })
    expect(backend.calls.some((c) => c.method === 'cancelHttpRequest')).toBe(true)
    expect(tab.error?.message).toMatch(/cancel/i)
    expect(tab.lastOutcome).toBe('cancelled')
  })
})
