/**
 * Component tests: a collection's / folder's Authorization section (overview tab) and what a request's Authorization tab
 * shows while it inherits.
 */
import { EditorView } from '@codemirror/view'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../app/state.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import { emptyAuth } from '../../lib/request'
import AuthPanel from '../requests/AuthPanel.svelte'
import { tabsStore } from '../requests/tabs.svelte'
import OverviewView from './OverviewView.svelte'

let backend: ReturnType<typeof createMockBackend>
beforeEach(async () => {
  localStorage.clear()
  backend = createMockBackend({ latencyMs: 0 })
  window.slinger = backend
  window.__slingerMock = backend
  tabsStore.tabs = []
  await app.init()
})
afterEach(() => cleanup())

const typeInto = (label: string, text: string) => {
  const v = EditorView.findFromDOM(screen.getByRole('textbox', { name: label }).closest('.cm-editor') as HTMLElement)!
  v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } })
}
const getUser = () => app.requests.find((r) => r.name === 'Get user')!

describe('collection / folder Authorization section', () => {
  it('edits and saves the collection auth with the overview Save; requests that inherit show it', async () => {
    const r = getUser()
    const tab = tabsStore.openOverview({ kind: 'collection', id: r.collectionId })
    render(OverviewView, { tab })
    await fireEvent.click(screen.getByTestId('overview-section-auth'))
    const kind = (await screen.findByLabelText('Authorization type')) as HTMLSelectElement
    // A collection is the top: it cannot inherit.
    expect([...kind.options].map((o) => o.value)).toEqual(['none', 'basic', 'bearer', 'apiKey', 'oauth2'])
    expect(kind.value).toBe('none')
    expect(tab.dirty).toBe(false)
    await fireEvent.change(kind, { target: { value: 'bearer' } })
    typeInto('Token', '{{apiToken}}')
    await waitFor(() => expect(tab.dirty).toBe(true))
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(tab.dirty).toBe(false))
    const stored = (await backend.listCollections(app.workspaceId!)).find((c) => c.id === r.collectionId)!
    expect(JSON.parse(stored.authJson!)).toEqual({ type: 'bearer', bearer: [{ key: 'token', value: '{{apiToken}}', type: 'string' }] })
    cleanup()

    // The request's tab: "Inherited from <collection>: Bearer Token" (its folder sets nothing).
    const req = tabsStore.openRequest(r)
    req.draft.auth = emptyAuth()
    render(AuthPanel, { tab: req })
    expect(screen.getByTestId('auth-inherited')).toHaveTextContent(/Inherited from\s*Demo API\s*\(collection\):\s*Bearer Token/)
  })

  it('a folder can inherit (the default) or set its own, including "No auth"', async () => {
    const r = getUser()
    const tab = tabsStore.openOverview({ kind: 'folder', id: r.folderId! })
    render(OverviewView, { tab })
    await fireEvent.click(screen.getByTestId('overview-section-auth'))
    const kind = (await screen.findByLabelText('Authorization type')) as HTMLSelectElement
    expect(kind.value).toBe('inherit')
    expect(screen.getByTestId('auth-inherited')).toHaveTextContent(/\(collection\):\s*No Auth/)
    await fireEvent.change(kind, { target: { value: 'none' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(tab.dirty).toBe(false))
    expect((await backend.listFolders(r.collectionId)).find((f) => f.id === r.folderId)!.authJson).toBe('{"type":"noauth"}')
    cleanup()

    const req = tabsStore.openRequest(r)
    req.draft.auth = emptyAuth()
    render(AuthPanel, { tab: req })
    expect(screen.getByTestId('auth-inherited')).toHaveTextContent(/\(folder\):\s*No Auth/)
    // The source opens its overview at the Authorization section.
    const folderName = app.folders.find((f) => f.id === r.folderId)!.name
    await fireEvent.click(screen.getByRole('button', { name: folderName }))
    const opened = tabsStore.tabs.find((t) => t.overview?.id === r.folderId)!
    expect(opened.overviewSection).toBe('auth')
  })
})
