/** Collections tree context menus: New MCP request (collection and folder) and the request menu of MCP requests. */
import { render, screen, waitFor, within } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../app/state.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import { newMcpRequestDraft } from '../../lib/mcpRequest'
import { serializeDraft } from '../../lib/request'
import { tabsStore } from '../requests/tabs.svelte'
import CollectionsPanel from './CollectionsPanel.svelte'

let backend: ReturnType<typeof createMockBackend>
let collectionId: string
let folderId: string

beforeEach(async () => {
  localStorage.clear()
  backend = createMockBackend({ latencyMs: 0, seed: false })
  window.slinger = backend
  window.__slingerMock = backend
  tabsStore.tabs = []
  tabsStore.activeId = null
  await app.init()
  const ws = app.workspaceId!
  collectionId = (await backend.createCollection(ws, 'Tools')).id
  folderId = (await backend.createFolder({ workspaceId: ws, collectionId, parentFolderId: null, name: 'Servers' })).id
  await app.reloadCollections()
})

const menuLabels = (menu: HTMLElement) => within(menu).getAllByRole('menuitem').map((i) => i.textContent?.trim().replace(/(Enter|F2|Del|←|→)$/, '').trim())

async function createFrom(rowName: RegExp, name: string) {
  const user = userEvent.setup()
  const row = await screen.findByRole('treeitem', { name: rowName })
  await user.pointer({ keys: '[MouseRight]', target: row })
  const menu = await screen.findByRole('menu')
  const labels = menuLabels(menu)
  expect(labels.indexOf('New MCP request')).toBe(labels.indexOf('New request') + 1)
  await user.click(within(menu).getByRole('menuitem', { name: /New MCP request/ }))
  const dialog = await screen.findByRole('dialog', { name: 'New MCP request' })
  const input = within(dialog).getByLabelText('Request name')
  expect(input).toHaveValue('New MCP Request')
  await user.clear(input)
  await user.type(input, name)
  await user.click(within(dialog).getByRole('button', { name: 'Create' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  return app.requests.find((r) => r.name === name)!
}

describe('New MCP request', () => {
  it('creates an MCP request in the collection and opens it', async () => {
    render(CollectionsPanel)
    const r = await createFrom(/Tools/, 'Weather')
    expect(r).toMatchObject({ collectionId, folderId: null, method: 'MCP', url: '' })
    expect(JSON.parse(r.documentJson).mcp).toMatchObject({ v: 1, transport: 'http', operation: 'tools/call' })
    const tab = tabsStore.active!
    expect(tab.requestId).toBe(r.id)
    expect(tab.draft.mcp).toMatchObject({ transport: 'http', operation: 'tools/call', arguments: '{}' })
    expect(tab.dirty).toBe(false)
  })

  it('creates an MCP request in a folder', async () => {
    const user = userEvent.setup()
    render(CollectionsPanel)
    const col = await screen.findByRole('treeitem', { name: /Tools/ })
    if (col.getAttribute('aria-expanded') !== 'true') await user.click(col)
    const r = await createFrom(/Servers/, 'Local')
    expect(r).toMatchObject({ collectionId, folderId, method: 'MCP' })
    expect(tabsStore.active?.draft.mcp).toBeDefined()
  })

  it('MCP requests have no "Add example"; HTTP requests keep it', async () => {
    const ws = app.workspaceId!
    const s = serializeDraft(newMcpRequestDraft('Demo MCP'))
    await backend.createRequest({ workspaceId: ws, collectionId, folderId: null, name: s.name, method: s.method, url: s.url, documentJson: s.documentJson })
    await backend.createRequest({ workspaceId: ws, collectionId, folderId: null, name: 'Plain', method: 'GET', url: 'https://x.test', documentJson: '{}' })
    await app.reloadCollections()
    const user = userEvent.setup()
    render(CollectionsPanel)
    const col = await screen.findByRole('treeitem', { name: /Tools/ })
    if (col.getAttribute('aria-expanded') !== 'true') await user.click(col)

    const mcpRow = await screen.findByRole('treeitem', { name: /Demo MCP/ })
    expect(within(mcpRow).getByText('MCP')).toBeInTheDocument()
    await user.pointer({ keys: '[MouseRight]', target: mcpRow })
    expect(menuLabels(await screen.findByRole('menu'))).toEqual(['Open', 'Duplicate', 'Rename', 'Delete'])
    await user.keyboard('{Escape}')

    await user.pointer({ keys: '[MouseRight]', target: await screen.findByRole('treeitem', { name: /Plain/ }) })
    expect(menuLabels(await screen.findByRole('menu'))).toContain('Add example')
  })
})
