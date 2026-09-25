/** Component-level tests of saved examples: the example tab, Save as example, tree menu, unsaved prompt, remote changes. */
import { cleanup, render, screen, waitFor, within } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ApiRequest } from '../../../shared/types'
import { app } from '../../app/state.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import { readExamples, updateExamples } from '../../lib/examples'
import CollectionsPanel from '../collections/CollectionsPanel.svelte'
import { tabsStore } from '../requests/tabs.svelte'
import UnsavedDialog from '../requests/UnsavedDialog.svelte'
import ResponsePane from '../response/ResponsePane.svelte'
import { reloadFromCloud } from '../sync/tabActions'
import ExampleView from './ExampleView.svelte'

let backend: ReturnType<typeof createMockBackend>

beforeEach(async () => {
  localStorage.clear()
  backend = createMockBackend({ latencyMs: 0 })
  window.slinger = backend
  window.__slingerMock = backend
  tabsStore.tabs = []
  tabsStore.activeId = null
  tabsStore.pendingClose = null
  await app.init()
})
afterEach(cleanup)

const find = (name: string) => app.requests.find((r) => r.name === name)!
const stored = async (name: string) => {
  const r = find(name)
  return (await backend.listRequests(r.collectionId)).find((x) => x.id === r.id)!
}
const storedExamples = async (name: string) => readExamples((await stored(name)).documentJson) as Record<string, unknown>[]

/** Writes the request's examples "elsewhere" (another window / a sync pull) and reloads the app state. */
async function editElsewhere(name: string, fn: (list: unknown[]) => unknown[]): Promise<ApiRequest> {
  const server = await stored(name)
  const updated = await backend.updateRequest({
    requestId: server.id,
    name: server.name,
    method: server.method,
    url: server.url,
    documentJson: updateExamples(server.documentJson, fn),
    expectedVersion: server.version,
  })
  await app.reloadCollection(server.collectionId)
  return updated
}

describe('ExampleView', () => {
  it('shows the saved request and response, marks edits unsaved and saves them with the Save button', async () => {
    const user = userEvent.setup()
    const tab = tabsStore.openExample(find('List pets'), 0)
    render(ExampleView, { tab })
    expect(screen.getByTestId('example-view')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Example name' })).toHaveValue('Two pets')
    expect(screen.getByTestId('status-chip')).toHaveTextContent('200 OK')
    expect(screen.queryByText('request from parent')).toBeNull()
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()

    await user.clear(screen.getByRole('textbox', { name: 'Example name' }))
    await user.type(screen.getByRole('textbox', { name: 'Example name' }), 'Pets')
    await user.clear(screen.getByRole('spinbutton', { name: 'Status code' }))
    await user.type(screen.getByRole('spinbutton', { name: 'Status code' }), '201')
    expect(screen.getByRole('textbox', { name: 'Status text' })).toHaveValue('Created') // follows the code
    expect(tab.dirty).toBe(true)
    expect(save).toBeEnabled()
    await user.click(save)
    await waitFor(() => expect(tab.dirty).toBe(false))
    expect((await storedExamples('List pets'))[0]).toMatchObject({ name: 'Pets', code: 201, status: 'Created' })
  })

  it('an example without originalRequest shows the parent request and says so', () => {
    const tab = tabsStore.openExample(find('List pets'), 1)
    render(ExampleView, { tab })
    expect(screen.getByText('request from parent')).toBeInTheDocument()
    expect(tab.draft.url).toBe(find('List pets').url)
    expect(screen.getByTestId('status-chip')).toHaveTextContent('500 Internal Server Error')
  })

  it('"Try" opens a new unsaved request tab and the example tab stays clean', async () => {
    const user = userEvent.setup()
    const tab = tabsStore.openExample(find('List pets'), 0)
    render(ExampleView, { tab })
    await user.click(screen.getByRole('button', { name: 'Try' }))
    const tried = tabsStore.active!
    expect(tried).not.toBe(tab)
    expect(tried.example).toBeNull()
    expect(tried.requestId).toBeNull()
    expect(tried.draft.name).toBe('List pets')
    expect(tab.dirty).toBe(false)
  })

  it('a deleted example keeps a dirty tab with a banner; Save asks, Overwrite adds it back', async () => {
    const tab = tabsStore.openExample(find('List pets'), 1)
    tab.exampleDraft!.body = 'mine'
    render(ExampleView, { tab })
    await editElsewhere('List pets', (list) => list.slice(0, 1))
    expect(tab.example!.remote).toBe('gone')
    expect(await screen.findByTestId('example-gone')).toBeInTheDocument()
    expect(await tabsStore.save(tab)).toBe(false)
    expect(tab.conflict).not.toBeNull()
    expect(await screen.findByRole('dialog', { name: 'Example deleted elsewhere' })).toBeInTheDocument()
    expect(await tabsStore.save(tab, { overwrite: true })).toBe(true)
    expect((await storedExamples('List pets')).map((e) => e.body)).toEqual([expect.any(String), 'mine'])
  })

  it('a clean tab of an example deleted elsewhere closes; one edited elsewhere reloads', async () => {
    const r = find('List pets')
    const first = tabsStore.openExample(r, 0)
    const second = tabsStore.openExample(r, 1)
    await editElsewhere('List pets', (list) => [{ ...(list[0] as object), body: 'new body' }])
    expect(tabsStore.find(second.id)).toBeNull()
    expect(first.exampleDraft!.body).toBe('new body')
    expect(first.dirty).toBe(false)
  })

  it('"Reload from cloud" closes a dirty example tab whose example is gone, and reloads one that changed', async () => {
    const r = find('List pets')
    const first = tabsStore.openExample(r, 0)
    const second = tabsStore.openExample(r, 1)
    first.exampleDraft!.body = 'a'
    second.exampleDraft!.body = 'b'
    await editElsewhere('List pets', (list) => [{ ...(list[0] as object), body: 'cloud' }])
    expect(first.example!.remote).toBe('changed')
    expect(second.example!.remote).toBe('gone')
    reloadFromCloud(first)
    expect(first.exampleDraft!.body).toBe('cloud')
    expect(first.dirty).toBe(false)
    reloadFromCloud(second)
    expect(tabsStore.find(second.id)).toBeNull()
  })
})

describe('unsaved example tabs', () => {
  it('closing asks first, and "Save" writes the example before closing', async () => {
    const user = userEvent.setup()
    const tab = tabsStore.openExample(find('List pets'), 0)
    tab.exampleDraft!.body = '[]'
    render(UnsavedDialog)
    tabsStore.requestClose([tab.id])
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' })
    expect(dialog).toHaveTextContent('“Two pets” has unsaved changes')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(tabsStore.find(tab.id)).toBeNull())
    expect((await storedExamples('List pets'))[0].body).toBe('[]')
  })
})

describe('Save as example', () => {
  it('is disabled until the request is saved, then stores the live response under the request', async () => {
    const user = userEvent.setup()
    const draftTab = tabsStore.newTab({ draft: { ...tabsStore.openRequest(find('JSON sample')).draft } })
    await tabsStore.send(draftTab)
    const first = render(ResponsePane, { tab: draftTab })
    expect(screen.getByRole('button', { name: 'Save as example' })).toBeDisabled()
    first.unmount()

    const tab = tabsStore.openRequest(find('JSON sample'))
    await tabsStore.send(tab)
    render(ResponsePane, { tab })
    await user.click(screen.getByRole('button', { name: 'Save as example' }))
    const dialog = await screen.findByRole('dialog', { name: 'Save as example' })
    expect(within(dialog).getByRole('textbox', { name: 'Example name' })).toHaveValue('200 OK')
    await user.click(within(dialog).getByRole('button', { name: 'Save example' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Save as example' })).toBeNull())
    const list = await storedExamples('JSON sample')
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name: '200 OK', code: 200, _postman_previewlanguage: 'json' })
    expect(tab.dirty).toBe(false)
  })
})

describe('tree context menu', () => {
  async function exampleRow(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
    const tree = screen.getByRole('tree', { name: 'Collections' })
    await user.click(within(tree).getByRole('treeitem', { name: /Petstore/ }))
    await user.click(within(tree).getByRole('treeitem', { name: /^pets/ }))
    await user.click(within(tree).getAllByTestId('examples-toggle')[0]!)
    return within(tree).findByRole('treeitem', { name })
  }

  it('renames, duplicates and deletes (after confirming) an example', async () => {
    const user = userEvent.setup()
    render(CollectionsPanel)
    let row = await exampleRow(user, /Two pets/)

    await user.pointer({ keys: '[MouseRight]', target: row })
    expect(within(await screen.findByRole('menu')).getAllByRole('menuitem').map((i) => i.textContent?.replace(/(Enter|F2|Del)$/, '').trim())).toEqual([
      'Open',
      'Duplicate',
      'Rename',
      'Delete',
    ])
    await user.click(screen.getByRole('menuitem', { name: /Rename/ }))
    const rename = await screen.findByRole('dialog', { name: 'Rename example' })
    const input = within(rename).getByRole('textbox')
    await user.clear(input)
    await user.type(input, 'Two cats{Enter}')
    await waitFor(async () => expect((await storedExamples('List pets'))[0].name).toBe('Two cats'))

    row = await screen.findByRole('treeitem', { name: /Two cats/ })
    await user.pointer({ keys: '[MouseRight]', target: row })
    await user.click(await screen.findByRole('menuitem', { name: /Duplicate/ }))
    await waitFor(async () => expect((await storedExamples('List pets')).map((e) => e.name)).toEqual(['Two cats', 'Two cats copy', 'Server error']))

    row = await screen.findByRole('treeitem', { name: /Server error/ })
    row.focus()
    await user.keyboard('{Delete}')
    const confirm = await screen.findByRole('dialog', { name: 'Delete example' })
    expect(confirm).toHaveTextContent('Delete the example “Server error”?')
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    expect(await storedExamples('List pets')).toHaveLength(3)
    row.focus()
    await user.keyboard('{Delete}')
    await user.click(within(await screen.findByRole('dialog', { name: 'Delete example' })).getByRole('button', { name: 'Delete' }))
    await waitFor(async () => expect((await storedExamples('List pets')).map((e) => e.name)).toEqual(['Two cats', 'Two cats copy']))
  })

  it('deleting a request with examples says how many go with it', async () => {
    const user = userEvent.setup()
    render(CollectionsPanel)
    await exampleRow(user, /Two pets/)
    const request = screen.getByRole('treeitem', { name: /List pets/ })
    request.focus()
    await user.keyboard('{Delete}')
    expect(await screen.findByRole('dialog', { name: 'Delete request' })).toHaveTextContent('and its 2 saved examples')
  })
})
