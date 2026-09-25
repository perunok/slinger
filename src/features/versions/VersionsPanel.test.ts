import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { expandedStore } from '../../app/expanded.svelte'
import { app } from '../../app/state.svelte'
import { toast } from '../../app/toast.svelte'
import ToastHost from '../../components/ui/ToastHost.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import { tabsStore } from '../requests/tabs.svelte'
import VersionsPanel from './VersionsPanel.svelte'

const doc = (name: string) => JSON.stringify({ name, method: 'GET', url: 'https://mock.slinger.local/json', headers: [], body: null, auth: null })

afterEach(() => {
  cleanup()
  toast.clear()
  tabsStore.tabs = []
  expandedStore.replace(new Set())
})
beforeEach(() => {
  toast.clear()
})

describe('replace-restore keeps the UI state', () => {
  it('keeps the folder expanded and offers to reopen the closed tab', async () => {
    const mock = createMockBackend({ latencyMs: 0, seed: false })
    window.slinger = mock
    await app.init()
    const ws = app.workspaceId!
    const col = await mock.createCollection(ws, 'Col')
    const folder = await mock.createFolder({ workspaceId: ws, collectionId: col.id, parentFolderId: null, name: 'Auth' })
    await mock.createRequest({ workspaceId: ws, collectionId: col.id, folderId: folder.id, name: 'Login', method: 'GET', url: 'x', documentJson: doc('Login') })
    await mock.createCollectionVersion({ collectionId: col.id, version: '1.0.0', notes: null })
    await app.reloadCollections()
    expandedStore.replace(new Set([`collection:${col.id}`, `folder:${folder.id}`]))
    const login = app.requestsOf(col.id)[0]!
    tabsStore.openRequest(login)
    expect(tabsStore.tabs).toHaveLength(1)

    render(VersionsPanel, { collectionId: col.id, onclose: () => {} })
    render(ToastHost)
    await fireEvent.click(await screen.findByRole('option', { name: /1\.0\.0/ }))
    await fireEvent.click(await screen.findByRole('button', { name: /Restore/ }))
    await fireEvent.click(screen.getByRole('radio', { name: /Replace/ }))
    await fireEvent.click(screen.getByRole('button', { name: 'Replace collection...' }))
    await fireEvent.click(within_dialog('Overwrite live collection?'))

    await waitFor(() => expect(app.foldersOf(col.id)[0]!.id).not.toBe(folder.id))
    const newFolder = app.foldersOf(col.id)[0]!
    expect(expandedStore.keys.has(`folder:${newFolder.id}`)).toBe(true)
    expect(expandedStore.keys.has(`folder:${folder.id}`)).toBe(false)
    expect(expandedStore.keys.has(`collection:${col.id}`)).toBe(true)
    expect(tabsStore.tabs).toHaveLength(0) // the replaced request's clean tab was closed ...

    await fireEvent.click(await screen.findByRole('button', { name: 'Reopen restored request' })) // ... and can be reopened
    expect(tabsStore.tabs).toHaveLength(1)
    expect(tabsStore.tabs[0]!.requestId).toBe(app.requestsOf(col.id)[0]!.id)
    expect(tabsStore.tabs[0]!.requestId).not.toBe(login.id)
  })
})

function within_dialog(title: string): HTMLElement {
  const dlg = screen.getByRole('dialog', { name: title })
  return Array.from(dlg.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Replace collection')!
}
