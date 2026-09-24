import { render, screen, within } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../app/state.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import { readExamples } from '../../lib/examples'
import CollectionsPanel from '../collections/CollectionsPanel.svelte'
import { tabsStore } from '../requests/tabs.svelte'
import * as actions from './actions'

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

const find = (name: string) => app.requests.find((r) => r.name === name)!
const stored = async (name: string) => {
  const r = find(name)
  return (await backend.listRequests(r.collectionId)).find((x) => x.id === r.id)!
}
const storedExamples = async (name: string) => readExamples((await stored(name)).documentJson) as Record<string, unknown>[]

describe('example tabs', () => {
  it('opens an example with its saved request and response, tracks dirty and saves only that example', async () => {
    const before = await storedExamples('List pets')
    const tab = tabsStore.openExample(find('List pets'), 0)
    expect(tab.title).toBe('Two pets')
    expect(tab.draft.url).toBe('https://mock.slinger.local/json?limit=2')
    expect(tab.exampleDraft).toMatchObject({ code: 200, status: 'OK', language: 'json' })
    expect(tab.dirty).toBe(false)
    expect(tabsStore.openExample(find('List pets'), 0)).toBe(tab) // reused

    tab.exampleDraft!.body = '[]'
    tab.exampleDraft!.code = 404
    expect(tab.dirty).toBe(true)
    expect(await tabsStore.save(tab)).toBe(true)
    expect(tab.dirty).toBe(false)
    const after = await storedExamples('List pets')
    expect(after[0]).toEqual({ ...before[0], body: '[]', code: 404 })
    expect(JSON.stringify(after[1])).toBe(JSON.stringify(before[1])) // the other example is untouched
  })

  it('keeps request edits made meanwhile, and reports a conflict only when this example changed', async () => {
    const tab = tabsStore.openExample(find('List pets'), 1)
    const request = find('List pets')
    // Someone else renames the request (a different part of the same document): no conflict.
    await backend.renameRequest(request.id, 'All pets')
    tab.exampleDraft!.name = 'Server error (edited)'
    expect(await tabsStore.save(tab)).toBe(true)
    expect((await stored('All pets')).name).toBe('All pets')
    expect((await storedExamples('All pets'))[1].name).toBe('Server error (edited)')

    // Now this example itself is changed elsewhere: conflict, then overwrite wins.
    const server = await stored('All pets')
    const list = readExamples(server.documentJson) as Record<string, unknown>[]
    list[1] = { ...list[1], body: 'changed elsewhere' }
    await backend.updateRequest({ ...server, requestId: server.id, documentJson: JSON.stringify({ ...JSON.parse(server.documentJson), responses: list }), expectedVersion: server.version })
    tab.exampleDraft!.status = 'Mine'
    expect(await tabsStore.save(tab)).toBe(false)
    expect(tab.conflict).not.toBeNull()
    expect(await tabsStore.save(tab, { overwrite: true })).toBe(true)
    expect((await storedExamples('All pets'))[1]).toMatchObject({ status: 'Mine', name: 'Server error (edited)' })
  })

  it('"Try" sends the example request from a new unsaved tab without touching the example', async () => {
    const tab = tabsStore.openExample(find('List pets'), 0)
    const before = await storedExamples('List pets')
    const tried = tabsStore.tryExample(tab)
    expect(tried).not.toBe(tab)
    expect(tried.requestId).toBeNull()
    expect(tried.draft.url).toBe('https://mock.slinger.local/json?limit=2')
    expect(tried.draft.extras).toEqual({})
    await expect.poll(() => tried.response?.data.status).toBe(200)
    expect(await storedExamples('List pets')).toEqual(before)
  })
})

describe('example actions', () => {
  it('saves a live response as an example and a dirty request tab keeps its edits without a conflict later', async () => {
    const tab = tabsStore.openRequest(find('JSON sample'))
    await tabsStore.send(tab)
    expect(tab.response).not.toBeNull()
    tab.draft.url = `${tab.draft.url}?edited=1` // unsaved edit
    const { index } = await actions.saveResponseAsExample(tab.requestId!, '200 OK', tab.draft, tab.response!.data)
    expect(index).toBe(0)
    const list = await storedExamples('JSON sample')
    expect(list[0]).toMatchObject({ name: '200 OK', code: 200, originalRequest: { method: 'GET', url: { raw: 'https://mock.slinger.local/json?edited=1' } } })
    expect(typeof list[0].id).toBe('string')
    // The stored request URL did not take the unsaved edit, the tab is still dirty, and saving it works.
    expect((await stored('JSON sample')).url).toBe('https://mock.slinger.local/json')
    expect(tab.dirty).toBe(true)
    expect(await tabsStore.save(tab)).toBe(true)
    expect(await storedExamples('JSON sample')).toHaveLength(1) // the save kept the new example
  })

  it('renames, duplicates and deletes examples; open tabs follow', async () => {
    const r = find('List pets')
    const second = tabsStore.openExample(r, 1)
    await actions.duplicateExampleAt(r.id, 0)
    expect((await storedExamples('List pets')).map((e) => e.name)).toEqual(['Two pets', 'Two pets copy', 'Server error'])
    expect(second.example!.index).toBe(2) // followed its example
    expect(tabsStore.active!.title).toBe('Two pets copy')

    second.exampleDraft!.body = 'unsaved'
    await actions.renameExample(r.id, 2, 'Boom')
    expect(second.exampleDraft!.name).toBe('Boom')
    expect(second.dirty).toBe(true) // the body edit is still unsaved
    second.exampleDraft!.body = (await storedExamples('List pets'))[2].body as string
    expect(second.dirty).toBe(false)

    await actions.deleteExampleAt(r.id, 1)
    expect((await storedExamples('List pets')).map((e) => e.name)).toEqual(['Two pets', 'Boom'])
    expect(tabsStore.tabs.some((t) => t.title === 'Two pets copy')).toBe(false)
    expect(second.example!.index).toBe(1)
  })

  it('adds a blank example', async () => {
    const r = find('Health')
    await actions.addExample(r.id, 'Up')
    expect(await storedExamples('Health')).toMatchObject([{ name: 'Up', code: 200, originalRequest: { method: 'GET' } }])
    expect(tabsStore.active!.title).toBe('Up')
  })
})

describe('collection tree', () => {
  it('lists examples under their request with keyboard expand/collapse and opens them', async () => {
    render(CollectionsPanel)
    const tree = screen.getByRole('tree', { name: 'Collections' })
    const user = userEvent.setup()
    await user.click(within(tree).getByRole('treeitem', { name: /Petstore/ }))
    await user.click(within(tree).getByRole('treeitem', { name: /^pets/ }))
    const row = within(tree).getByRole('treeitem', { name: /List pets/ })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    row.focus()
    await user.keyboard('{ArrowRight}')
    expect(row.getAttribute('aria-expanded')).toBe('true')
    const ex = within(tree).getByRole('treeitem', { name: /500 Server error/ })
    expect(ex.getAttribute('aria-level')).toBe(String(Number(row.getAttribute('aria-level')) + 1))
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')
    expect(tabsStore.active?.title).toBe('Server error')
    await user.keyboard('{ArrowLeft}') // to the parent request
    await user.keyboard('{ArrowLeft}') // collapse
    expect(row.getAttribute('aria-expanded')).toBe('false')
    // Enter on a request opens it (does not toggle).
    await user.keyboard('{Enter}')
    expect(tabsStore.active?.title).toBe('List pets')
  })
})
