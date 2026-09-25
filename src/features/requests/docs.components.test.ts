/**
 * Component tests: the request Docs tab (rendered by default, Edit/Preview/Split, edits persist, read-only),
 * link routing in rendered docs, and the collection/folder overview tab.
 */
import { EditorView } from '@codemirror/view'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../app/state.svelte'
import { toast } from '../../app/toast.svelte'
import MarkdownView from '../../components/markdown/MarkdownView.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import CollectionsPanel from '../collections/CollectionsPanel.svelte'
import ExampleView from '../examples/ExampleView.svelte'
import OverviewView from '../overview/OverviewView.svelte'
import { sync } from '../sync/syncStore.svelte'
import DocsPanel from './DocsPanel.svelte'
import { tabsStore } from './tabs.svelte'

let backend: ReturnType<typeof createMockBackend>
beforeEach(async () => {
  localStorage.clear()
  backend = createMockBackend({ latencyMs: 0 })
  window.slinger = backend
  window.__slingerMock = backend
  tabsStore.tabs = []
  toast.clear()
  await app.init()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const editorOf = (label: RegExp) => EditorView.findFromDOM(screen.getByRole('textbox', { name: label }).closest('.cm-editor') as HTMLElement)!
const typeInto = (label: RegExp, text: string) => {
  const v = editorOf(label)
  v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } })
}
const request = (name: string) => app.requests.find((r) => r.name === name)!

describe('request Docs tab', () => {
  it('shows the rendered Markdown by default when the request has docs', () => {
    const tab = tabsStore.openRequest(request('Get user'))
    render(DocsPanel, { tab })
    const doc = screen.getByTestId('markdown-view')
    expect(within(doc).getByRole('heading', { name: /Query parameters/ })).toBeInTheDocument()
    expect(within(doc).getByRole('table')).toBeInTheDocument()
    expect(doc.querySelector('.md-var')).toHaveTextContent('{{userId}}')
    expect(screen.getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('textbox', { name: /Markdown source/ })).toBeNull()
  })

  it('offers "Add documentation" when empty, and edits persist into the draft and the stored request', async () => {
    const r = request('Create user')
    const tab = tabsStore.openRequest(r)
    render(DocsPanel, { tab })
    expect(screen.getByTestId('docs-empty')).toHaveTextContent('No documentation yet.')
    await fireEvent.click(screen.getByRole('button', { name: 'Add documentation' }))
    expect(tab.docsMode).toBe('edit')
    typeInto(/Markdown source/, '# Create\n\n| a | b |\n|---|---|\n| 1 | 2 |')
    expect(tab.draft.description).toContain('# Create')
    expect(tab.dirty).toBe(true)

    await fireEvent.click(screen.getByRole('button', { name: 'Split' }))
    expect(screen.getByRole('textbox', { name: /Markdown source/ })).toBeInTheDocument()
    expect(within(screen.getByTestId('markdown-view')).getByRole('heading', { name: /Create/ })).toBeInTheDocument()

    await fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(screen.queryByRole('textbox', { name: /Markdown source/ })).toBeNull()
    expect(within(screen.getByTestId('markdown-view')).getByRole('table')).toBeInTheDocument()

    expect(await tabsStore.save(tab)).toBe(true)
    const stored = (await backend.listRequests(r.collectionId)).find((x) => x.id === r.id)!
    expect(JSON.parse(stored.documentJson).description).toBe('# Create\n\n| a | b |\n|---|---|\n| 1 | 2 |')
    expect(tab.dirty).toBe(false)
  })

  it('keeps the chosen mode on the tab across remounts (switching request sections)', async () => {
    const tab = tabsStore.openRequest(request('Get user'))
    render(DocsPanel, { tab })
    await fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    cleanup()
    render(DocsPanel, { tab })
    expect(screen.getByRole('button', { name: 'Edit' })).toHaveAttribute('aria-pressed', 'true')
    expect(editorOf(/Markdown source/).state.doc.toString()).toBe(tab.draft.description)
  })

  it('is preview-only in a read-only (viewer) workspace', async () => {
    vi.spyOn(sync, 'blocked', 'get').mockReturnValue(true)
    const tab = tabsStore.openRequest(request('Create user'))
    tab.docsMode = 'edit'
    render(DocsPanel, { tab })
    expect(screen.getByTestId('readonly-note')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Split' })).toBeDisabled()
    expect(screen.queryByRole('textbox', { name: /Markdown source/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add documentation' })).toBeNull()
  })

  it('shows a text/plain description verbatim with a "Plain text" badge', async () => {
    const r = request('Create user')
    const doc = JSON.parse(r.documentJson)
    doc.description = { content: '# not a heading', type: 'text/plain' }
    const updated = await backend.updateRequest({ requestId: r.id, name: r.name, method: r.method, url: r.url, documentJson: JSON.stringify(doc), expectedVersion: r.version })
    app.upsertRequest(updated)
    const tab = tabsStore.openRequest(updated)
    render(DocsPanel, { tab })
    expect(screen.getByText('Plain text')).toBeInTheDocument()
    expect(screen.getByTestId('markdown-view').querySelector('h1')).toBeNull()
    expect(screen.getByTestId('markdown-view')).toHaveTextContent('# not a heading')
  })
})

describe('links in rendered docs', () => {
  const md = '# Top\n\n[site](https://example.com/docs) [mail](mailto:dev@example.test) [top](#top) [rel](guide.md) [bad](javascript:alert(1))'

  it('opens http(s) and mailto links through openExternalUrl and never navigates', async () => {
    const open = vi.spyOn(backend, 'openExternalUrl').mockResolvedValue(undefined)
    render(MarkdownView, { source: md })
    const site = screen.getByRole('link', { name: 'site' })
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
    site.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    await fireEvent.click(screen.getByRole('link', { name: 'mail' }))
    await waitFor(() => expect(open.mock.calls.map((c) => c[0])).toEqual(['https://example.com/docs', 'mailto:dev@example.test']))
  })

  it('scrolls to anchors inside the doc; relative links do not open; javascript: links are not links', async () => {
    const open = vi.spyOn(backend, 'openExternalUrl').mockResolvedValue(undefined)
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    const info = vi.spyOn(toast, 'info')
    render(MarkdownView, { source: md })
    await fireEvent.click(screen.getByRole('link', { name: 'top' }))
    expect(scroll).toHaveBeenCalledTimes(1)
    expect((scroll.mock.contexts[0] as HTMLElement).dataset.anchor).toBe('top')
    await fireEvent.click(screen.getByRole('link', { name: 'rel' }))
    expect(info).toHaveBeenCalledWith('Link not opened', expect.stringContaining('guide.md'))
    expect(screen.queryByRole('link', { name: 'bad' })).toBeNull()
    expect(open).not.toHaveBeenCalled()
  })

  it('shows a toast when the main process refuses the URL', async () => {
    backend.failNext('openExternalUrl', { code: 'invalid_input', message: 'nope' })
    const err = vi.spyOn(toast, 'error')
    render(MarkdownView, { source: '[x](https://example.com)' })
    await fireEvent.click(screen.getByRole('link', { name: 'x' }))
    await waitFor(() => expect(err).toHaveBeenCalledWith('Could not open link', 'nope'))
  })
})

describe('collection / folder overview', () => {
  it('opens from the tree context menu and shows the rendered docs and counts', async () => {
    render(CollectionsPanel)
    const tree = screen.getByRole('tree')
    await fireEvent.contextMenu(within(tree).getByRole('treeitem', { name: /Demo API/ }))
    await fireEvent.click(screen.getByRole('menuitem', { name: /Overview & docs/ }))
    const tab = tabsStore.active!
    expect(tab.overview).toEqual({ kind: 'collection', id: app.collections.find((c) => c.name === 'Demo API')!.id })
    expect(tab.title).toBe('Demo API')
    cleanup()
    render(OverviewView, { tab })
    expect(screen.getByTestId('overview-title')).toHaveTextContent('Demo API')
    const count = app.requests.filter((r) => r.collectionId === tab.overview!.id).length
    expect(screen.getByTestId('overview-stats')).toHaveTextContent(`${count} requests`)
    const doc = screen.getByTestId('markdown-view')
    expect(within(doc).getByRole('heading', { name: /Demo API/, level: 1 })).toBeInTheDocument()
    expect(within(doc).getAllByRole('table').length).toBeGreaterThan(0)
    expect(doc.querySelector('img')!.getAttribute('src')).toMatch(/^data:image\/png;base64,/)
    expect(doc.querySelector('.md-img-blocked')).toHaveTextContent('Remote banner')
    expect(doc.querySelector('script')).toBeNull()
  })

  it('edits and saves collection documentation (Ctrl+S path) and a second open focuses the same tab', async () => {
    const col = app.collections.find((c) => c.name === 'Demo API')!
    const tab = tabsStore.openOverview({ kind: 'collection', id: col.id })
    expect(tabsStore.openOverview({ kind: 'collection', id: col.id })).toBe(tab)
    render(OverviewView, { tab })
    await fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    typeInto(/Markdown source/, '# Rewritten')
    expect(tab.dirty).toBe(true)
    const save = screen.getByRole('button', { name: 'Save' })
    await waitFor(() => expect(save).not.toBeDisabled())
    expect(await tabsStore.save(tab)).toBe(true)
    expect((await backend.listCollections(app.workspaceId!)).find((c) => c.id === col.id)!.description).toBe('# Rewritten')
    expect(app.collections.find((c) => c.id === col.id)!.description).toBe('# Rewritten')
    expect(tab.dirty).toBe(false)
  })

  it('shows folder breadcrumbs, recursive counts, and plain-text folder docs verbatim', async () => {
    const users = app.folders.find((f) => f.name === 'Users')!
    const tab = tabsStore.openOverview({ kind: 'folder', id: users.id })
    render(OverviewView, { tab })
    expect(screen.getByRole('button', { name: 'Demo API' })).toBeInTheDocument()
    // Users holds 2 requests itself and 2 in its Admin subfolder.
    expect(screen.getByTestId('overview-stats')).toHaveTextContent('4 requests')
    expect(screen.getByTestId('overview-stats')).toHaveTextContent('1 folder')
    cleanup()
    const pets = app.folders.find((f) => f.name === 'pets')!
    render(OverviewView, { tab: tabsStore.openOverview({ kind: 'folder', id: pets.id }) })
    expect(screen.getByText('Plain text')).toBeInTheDocument()
    expect(screen.getByTestId('markdown-view').querySelector('em')).toBeNull()
  })

  it('is read-only for viewers', () => {
    vi.spyOn(sync, 'blocked', 'get').mockReturnValue(true)
    const tab = tabsStore.openOverview({ kind: 'collection', id: app.collections[0]!.id })
    render(OverviewView, { tab })
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('closes a clean overview tab when its folder is deleted', async () => {
    const admin = app.folders.find((f) => f.name === 'Admin')!
    const tab = tabsStore.openOverview({ kind: 'folder', id: admin.id })
    await backend.deleteFolder(admin.id)
    await app.reloadCollection(admin.collectionId)
    expect(tabsStore.find(tab.id)).toBeNull()
  })
})

describe('example tabs', () => {
  it('show the parent request docs read-only in a Docs section (only when there are docs)', async () => {
    const r = request('List pets')
    const tab = tabsStore.openExample(r, 0)
    render(ExampleView, { tab })
    expect(screen.queryByRole('tab', { name: 'Docs' })).toBeNull()
    cleanup()
    const doc = JSON.parse(r.documentJson)
    doc.description = '## Pets\n\nReturns `{{limit}}` pets.'
    app.upsertRequest(await backend.updateRequest({ requestId: r.id, name: r.name, method: r.method, url: r.url, documentJson: JSON.stringify(doc), expectedVersion: r.version }))
    render(ExampleView, { tab })
    await fireEvent.click(screen.getByRole('tab', { name: 'Docs' }))
    const docs = screen.getByTestId('example-docs')
    expect(within(docs).getByRole('heading', { name: /Pets/ })).toBeInTheDocument()
    expect(docs.querySelector('.md-var')).toHaveTextContent('{{limit}}')
    expect(within(docs).queryByRole('button', { name: 'Edit' })).toBeNull()
  })
})
