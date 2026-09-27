/**
 * Editors of the persisted variables with the mock backend: Globals in the Environments dialog (secrets, enabled,
 * autosave, "create variable" target) and the Variables section of a collection overview (bulk replace, order).
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../app/state.svelte'
import { scopeStore } from '../../app/scope.svelte'
import { ui } from '../../app/ui.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import CollectionsPanel from '../collections/CollectionsPanel.svelte'
import OverviewView from '../overview/OverviewView.svelte'
import { tabsStore } from '../requests/tabs.svelte'
import EnvironmentEditor from './EnvironmentEditor.svelte'

let backend: ReturnType<typeof createMockBackend>

beforeEach(async () => {
  localStorage.clear()
  backend = createMockBackend({ latencyMs: 0 })
  window.slinger = backend
  window.__slingerMock = backend
  tabsStore.tabs = []
  tabsStore.activeId = null
  await app.init()
})
afterEach(() => {
  cleanup()
  ui.envEditor = { open: false }
})

const status = () => screen.getByTestId('save-status')
const settled = () => vi.waitFor(() => expect(status()).toHaveTextContent('All changes saved'), { timeout: 3000 })
const globals = () => backend.listGlobalVariables(app.workspaceId!)
const demo = () => app.collections.find((c) => c.name === 'Demo API')!

describe('Globals in the Environments dialog', () => {
  it('is an entry at the top of the list; its table has Enabled and Secret columns and autosaves', async () => {
    const user = userEvent.setup()
    ui.envEditor = { open: true }
    render(EnvironmentEditor)
    await screen.findByLabelText('Variable name: baseUrl')
    await user.click(screen.getByTestId('globals-entry'))
    const panel = await screen.findByRole('region', { name: 'Globals' })
    expect(within(panel).getByRole('columnheader', { name: 'Secret' })).toBeInTheDocument()
    expect(within(panel).getByRole('columnheader', { name: 'On' })).toBeInTheDocument()

    await user.type(await within(panel).findByLabelText('Variable name (new)'), 'token')
    await user.click(within(panel).getByLabelText('Secret: token'))
    await user.type(within(panel).getByLabelText('Secret value: token'), 'glob-secret')
    await settled()
    const [g] = await globals()
    expect(g).toMatchObject({ key: 'token', isSecret: true, value: null, enabled: true })
    expect(await backend.revealGlobalVariable(g!.id)).toBe('glob-secret')
    expect(document.body.innerHTML).not.toContain('glob-secret')

    await user.click(within(panel).getByLabelText('Enabled: token'))
    await settled()
    expect((await globals())[0]!.enabled).toBe(false)
    // the app's scope follows (disabled variables do not resolve)
    await vi.waitFor(() => expect(scopeStore.scope.variables.has('token')).toBe(false))
  })

  it('"create variable" with the Globals target opens Globals with a row for the name', async () => {
    ui.envEditor = { open: true, globals: true, newVariable: 'fromPopover' }
    render(EnvironmentEditor)
    const panel = await screen.findByRole('region', { name: 'Globals' })
    expect(await within(panel).findByLabelText('Variable name: fromPopover')).toBeInTheDocument()
  })
})

describe('collection variables in the overview', () => {
  it('opens from the tree menu (Variables…), edits and saves, and the scope of the collection resolves them', async () => {
    const user = userEvent.setup()
    render(CollectionsPanel)
    await fireEvent.contextMenu(within(screen.getByRole('tree')).getByRole('treeitem', { name: /Demo API/ }))
    await fireEvent.click(screen.getByRole('menuitem', { name: /Variables…/ }))
    const tab = tabsStore.active!
    expect(tab.overviewSection).toBe('variables')
    cleanup()
    render(OverviewView, { tab })
    const panel = await screen.findByRole('region', { name: 'Collection variables' })
    expect(within(panel).queryByRole('columnheader', { name: 'Secret' })).toBeNull()
    await user.type(await within(panel).findByLabelText('Variable name (new)'), 'apiVersion')
    await settled()
    expect((await backend.listCollectionVariables(demo().id)).map((v) => v.key)).toEqual(['apiVersion'])
    await vi.waitFor(() => expect(scopeStore.scopeFor(demo().id).variables.get('apiVersion')).toMatchObject({ source: 'collection' }))
    expect(scopeStore.scopeFor(null).variables.has('apiVersion')).toBe(false)
  })

  it('bulk edit saves with one replace, in the order of the lines', async () => {
    const user = userEvent.setup()
    const col = demo()
    await backend.upsertCollectionVariable({ collectionId: col.id, key: 'a', value: '1' })
    await backend.upsertCollectionVariable({ collectionId: col.id, key: 'off', value: 'x', enabled: false })
    const tab = tabsStore.openOverview({ kind: 'collection', id: col.id })
    tab.overviewSection = 'variables'
    render(OverviewView, { tab })
    const panel = await screen.findByRole('region', { name: 'Collection variables' })
    await within(panel).findByLabelText('Variable name: a')
    const replace = vi.spyOn(backend, 'replaceCollectionVariables')
    await user.click(within(panel).getByRole('button', { name: 'Bulk edit' }))
    const ta = within(panel).getByLabelText('Bulk edit variables') as HTMLTextAreaElement
    expect(ta.value).toBe('a=1')
    await fireEvent.input(ta, { target: { value: 'b=2\na=1' } })
    await user.click(within(panel).getByRole('button', { name: 'Back to table' }))
    await settled()
    expect(replace).toHaveBeenCalledTimes(1)
    const stored = await backend.listCollectionVariables(col.id)
    expect(stored.map((v) => [v.key, v.enabled])).toEqual([['b', true], ['a', true], ['off', false]])
  })

  it('"create variable" with the collection target opens the Variables section with a row for the name', async () => {
    const tab = tabsStore.openRequest(app.requests.find((r) => r.collectionId === demo().id)!)
    expect(tab.collectionId).toBe(demo().id)
    const { openCollectionVariables } = await import('../overview/openVariables')
    openCollectionVariables(demo().id, 'newOne')
    const overview = tabsStore.active!
    render(OverviewView, { tab: overview })
    const panel = await screen.findByRole('region', { name: 'Collection variables' })
    expect(await within(panel).findByLabelText('Variable name: newOne')).toBeInTheDocument()
    expect(overview.pendingVariable).toBeNull()
  })
})
