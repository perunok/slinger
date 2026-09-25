import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { expandedStore } from '../../app/expanded.svelte'
import { app } from '../../app/state.svelte'
import { toast } from '../../app/toast.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import { tabsStore } from '../requests/tabs.svelte'
import { sync } from '../sync/syncStore.svelte'
import ImportPostmanDialog from './ImportPostmanDialog.svelte'
import { parsePostmanFile } from './parse'
import { copyName, findReimportMatches } from './reimport'

const collection = (extra: object = {}) =>
  JSON.stringify({
    info: { name: 'Pets', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [
      { name: 'Dogs', item: [{ name: 'List', request: { method: 'GET', url: 'https://x.test/dogs' } }] },
      { name: 'Health', request: { method: 'GET', url: 'https://x.test/health' } },
    ],
    ...extra,
  })

async function setup() {
  const mock = createMockBackend({ latencyMs: 0, seed: false })
  window.slinger = mock
  await app.init()
  toast.clear()
  const onclose = vi.fn()
  render(ImportPostmanDialog, { open: true, onclose })
  return { mock, onclose }
}
async function pick(text: string, name = 'x.json') {
  const input = screen.getByLabelText('Postman file') as HTMLInputElement
  const file = new File([text], name, { type: 'application/json' })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await fireEvent.change(input)
}

beforeEach(() => vi.restoreAllMocks())

describe('parsePostmanFile', () => {
  it('counts folders and requests and reads variables', () => {
    const r = parsePostmanFile(collection({ variable: [{ key: 'baseUrl', value: 'https://x.test' }, { key: '', value: 'skip' }] }))
    expect(r).toMatchObject({ ok: true, file: { kind: 'collection', name: 'Pets', folders: 1, requests: 2, variables: [{ key: 'baseUrl', value: 'https://x.test' }] } })
  })
  it('counts saved examples of the sample collection', () => {
    const r = parsePostmanFile(readFileSync(join(__dirname, '..', '..', '..', 'example-postman-collection.json'), 'utf8'))
    expect(r).toMatchObject({ ok: true, file: { kind: 'collection', requests: 8, examples: 16 } })
  })
  it('counts scripts at collection, folder and request level (non-empty, enabled only)', () => {
    const ev = (listen: string, code: string, extra = {}) => ({ listen, script: { type: 'text/javascript', exec: [code] }, ...extra })
    const text = JSON.stringify({
      info: { name: 'S' },
      event: [ev('prerequest', 'a()'), ev('test', '')],
      item: [
        { name: 'F', event: [ev('test', 'b()')], item: [{ name: 'R', event: [ev('prerequest', 'c()'), ev('test', 'd()', { disabled: true })], request: { method: 'GET', url: 'x' } }] },
      ],
    })
    expect(parsePostmanFile(text)).toMatchObject({ ok: true, file: { scripts: 3 } })
  })

  it('shows the script count and imports collection and folder scripts', async () => {
    await setup()
    const ev = [{ listen: 'prerequest', script: { type: 'text/javascript', exec: ['pm.variables.set("x", 1)'] } }]
    await pick(collection({ event: ev }))
    expect(await screen.findByTestId('import-scripts')).toHaveTextContent('1 (pre-request and test, all levels)')
    await fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(app.collections.some((c) => c.name === 'Pets')).toBe(true))
    expect(app.collections.find((c) => c.name === 'Pets')!.scriptsJson).toBe(JSON.stringify(ev))
    expect(toast.items.find((t) => t.kind === 'success')?.detail).toMatch(/1 script/)
  })

  it('recognises environments', () => {
    const r = parsePostmanFile(JSON.stringify({ name: 'Prod', _postman_variable_scope: 'environment', values: [{ key: 'a', value: '1', type: 'default', enabled: true }, { key: 's', value: 'x', type: 'secret' }, { key: 'off', value: '', enabled: false }] }))
    expect(r).toMatchObject({ ok: true, file: { kind: 'environment', name: 'Prod', skippedDisabled: 1 } })
    if (r.ok && r.file.kind === 'environment') expect(r.file.variables.map((v) => v.secret)).toEqual([false, true])
  })
  it.each([
    ['{oops', /not valid JSON/],
    ['[1]', /not a Postman export/],
    ['{"a":1}', /no "item" array/],
    [JSON.stringify({ info: { schema: 'https://schema.getpostman.com/json/collection/v1.0.0/collection.json' } }), /Unsupported Postman schema/],
    [JSON.stringify({ info: { name: 'E' }, item: [] }), /no requests/],
  ])('rejects %s', (text, msg) => {
    const r = parsePostmanFile(text)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(msg)
  })
})

describe('ImportPostmanDialog', () => {
  it('shows an error for invalid JSON and keeps Import disabled', async () => {
    await setup()
    await pick('not json')
    expect(await screen.findByRole('alert')).toHaveTextContent(/not valid JSON/)
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled()
  })

  it('rejects JSON that is not a Postman collection', async () => {
    await setup()
    await pick('{"hello": "world"}')
    expect(await screen.findByRole('alert')).toHaveTextContent(/does not look like a Postman collection/)
  })

  it('previews and imports a collection, then reloads and closes', async () => {
    const { mock, onclose } = await setup()
    await pick(collection())
    const preview = await screen.findByLabelText('Import preview')
    expect(preview).toHaveTextContent('Pets')
    expect(preview).toHaveTextContent('Folders1')
    expect(preview).toHaveTextContent('Requests2')
    expect(preview).toHaveTextContent('none')
    await fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(onclose).toHaveBeenCalled())
    expect(app.collections.map((c) => c.name)).toContain('Pets')
    expect(app.requestsOf(app.collections.find((c) => c.name === 'Pets')!.id)).toHaveLength(2)
    expect(toast.items.some((t) => t.kind === 'success')).toBe(true)
    expect(mock.calls.some((c) => c.method === 'createEnvironment')).toBe(false)
  })

  it('creates an environment from collection variables by default and can opt out', async () => {
    const { mock, onclose } = await setup()
    await pick(collection({ variable: [{ key: 'baseUrl', value: 'https://x.test' }, { key: 'token', value: 'abc' }] }))
    expect(await screen.findByLabelText(/from collection variables/)).toBeChecked()
    await fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(onclose).toHaveBeenCalled())
    const env = app.environments.find((e) => e.name === 'Pets')
    expect(env).toBeTruthy()
    const vars = await mock.listEnvironmentVariables(env!.id)
    expect(vars.map((v) => v.key).sort()).toEqual(['baseUrl', 'token'])
  })

  it('skips the environment when unchecked', async () => {
    const { mock, onclose } = await setup()
    await pick(collection({ variable: [{ key: 'a', value: '1' }] }))
    await fireEvent.click(await screen.findByLabelText(/from collection variables/))
    await fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(onclose).toHaveBeenCalled())
    expect(mock.calls.some((c) => c.method === 'createEnvironment')).toBe(false)
  })

  it('imports a Postman environment with secret values', async () => {
    const { mock, onclose } = await setup()
    await pick(JSON.stringify({ name: 'Staging', _postman_variable_scope: 'environment', values: [{ key: 'host', value: 'h', type: 'default', enabled: true }, { key: 'pw', value: 'p', type: 'secret', enabled: true }] }))
    expect(await screen.findByLabelText('Import preview')).toHaveTextContent('Staging')
    await fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(onclose).toHaveBeenCalled())
    const env = app.environments.find((e) => e.name === 'Staging')!
    const vars = await mock.listEnvironmentVariables(env.id)
    expect(vars.find((v) => v.key === 'pw')?.isSecret).toBe(true)
    expect(vars.find((v) => v.key === 'host')?.isSecret).toBe(false)
  })

  it('merges collection variables into an existing same-named environment instead of creating a duplicate', async () => {
    const mock = createMockBackend({ latencyMs: 0, seed: false })
    window.slinger = mock
    await app.init()
    const existing = await mock.createEnvironment(app.workspaceId!, 'pets')
    await mock.upsertEnvironmentVariable({ environmentId: existing.id, key: 'token', value: 'from-script', isSecret: false })
    await app.reloadEnvironments()
    toast.clear()
    const onclose = vi.fn()
    render(ImportPostmanDialog, { open: true, onclose })
    await pick(collection({ variable: [{ key: 'baseUrl', value: 'https://x.test' }, { key: 'token', value: 'abc' }] }))
    expect(await screen.findByLabelText(/Create or update environment "Pets" from collection variables/)).toBeChecked()
    await waitFor(() =>
      expect(screen.getByTestId('import-env-help')).toHaveTextContent('Adds 1 new variable to the existing environment "pets"; existing values are kept.'),
    )
    await fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(onclose).toHaveBeenCalled())
    expect(app.environments.filter((e) => e.name.toLowerCase() === 'pets')).toHaveLength(1)
    const vars = await mock.listEnvironmentVariables(existing.id)
    expect(vars.map((v) => [v.key, v.value])).toEqual([['baseUrl', 'https://x.test'], ['token', 'from-script']])
    expect(toast.items.some((t) => t.detail === 'Environment "pets" updated: 1 added, 1 kept')).toBe(true)
  })

  it('re-importing an environment file updates the existing environment', async () => {
    const { mock, onclose } = await setup()
    const file = (host: string) => JSON.stringify({ name: 'Staging', _postman_variable_scope: 'environment', values: [{ key: 'host', value: host, enabled: true }] })
    await pick(file('a'))
    await screen.findByLabelText('Import preview')
    await fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(onclose).toHaveBeenCalledTimes(1))
    expect(toast.items.some((t) => t.detail === 'Environment "Staging" created with 1 variable')).toBe(true)
    cleanup()
    render(ImportPostmanDialog, { open: true, onclose })
    await pick(file('b'))
    expect(await screen.findByTestId('import-env-help')).toHaveTextContent('already exists')
    await fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(onclose).toHaveBeenCalledTimes(2))
    const envs = app.environments.filter((e) => e.name === 'Staging')
    expect(envs).toHaveLength(1)
    expect((await mock.listEnvironmentVariables(envs[0].id)).map((v) => v.value)).toEqual(['b'])
    expect(toast.items.some((t) => t.detail === 'Environment "Staging" updated: 0 added, 1 updated, 0 kept')).toBe(true)
  })

  it('stays open and shows the error when the import fails', async () => {
    const { mock, onclose } = await setup()
    mock.failNext('importPostmanCollection', { code: 'invalid_input', message: 'Postman collection must contain an item array' })
    await pick(collection())
    await screen.findByLabelText('Import preview')
    await fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('must contain an item array')
    expect(onclose).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled()
  })
})

describe('re-import helpers', () => {
  const col = (id: string, name: string, sourcePostmanId: string | null = null) => ({ id, workspaceId: 'w', name, sourcePostmanId, createdAt: 0, updatedAt: 0, version: 1 })

  it('matches by _postman_id (collection id or recorded source id) before name', () => {
    const cols = [col('a', 'Pets'), col('b', 'Renamed', 'PM-1'), col('c', 'Other')]
    expect(findReimportMatches(cols, { name: 'Pets', postmanId: 'pm-1' })).toEqual({ by: 'id', collections: [cols[1]] })
    expect(findReimportMatches(cols, { name: 'x', postmanId: 'C' })).toEqual({ by: 'id', collections: [cols[2]] })
    expect(findReimportMatches(cols, { name: '  pets ', postmanId: 'unknown' })).toEqual({ by: 'name', collections: [cols[0]] })
    expect(findReimportMatches(cols, { name: 'Nope', postmanId: null })).toBeNull()
  })

  it('names copies X (2), X (3)... skipping taken names', () => {
    expect(copyName('Pets', ['Other'])).toBe('Pets')
    expect(copyName('Pets', ['pets'])).toBe('Pets (2)')
    expect(copyName('Pets', ['Pets', 'Pets (2)'])).toBe('Pets (3)')
    expect(copyName('Pets', ['Pets', 'Pets (3)'])).toBe('Pets (2)')
  })

  it('parse reads info._postman_id', () => {
    expect(parsePostmanFile(collection({ info: { _postman_id: 'abc', name: 'Pets' } }))).toMatchObject({ ok: true, file: { postmanId: 'abc' } })
    expect(parsePostmanFile(collection())).toMatchObject({ ok: true, file: { postmanId: null } })
  })
})

describe('ImportPostmanDialog: re-importing an existing collection', () => {
  const updated = (extra: object = {}) =>
    JSON.stringify({
      info: { name: 'Pets', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [
        { name: 'Dogs', item: [{ name: 'List', request: { method: 'GET', url: 'https://x.test/v2/dogs' } }] },
        { name: 'Cats', request: { method: 'GET', url: 'https://x.test/cats' } },
      ],
      ...extra,
    })

  async function setupExisting(...files: Array<{ text: string; name?: string }>) {
    const mock = createMockBackend({ latencyMs: 0, seed: false })
    window.slinger = mock
    sync.statuses = {}
    await app.init()
    const created = []
    for (const f of files) created.push(await mock.importPostmanCollection(app.workspaceId!, f.text, f.name ? { name: f.name } : undefined))
    await app.reloadCollections()
    toast.clear()
    const onclose = vi.fn()
    render(ImportPostmanDialog, { open: true, onclose })
    return { mock, onclose, created }
  }

  afterEach(() => {
    cleanup()
    tabsStore.tabs = []
    expandedStore.replace(new Set())
    sync.statuses = {}
  })

  it('offers Replace (default) or a copy, and replace keeps the collection id with a safety version', async () => {
    const { mock, onclose, created } = await setupExisting({ text: collection() })
    const id = created[0]!.collection.id
    const dogs = created[0]!.folders[0]!
    expandedStore.replace(new Set([`collection:${id}`, `folder:${dogs.id}`]))
    await pick(updated(), 'pets.json')
    const replace = await screen.findByRole('radio', { name: /Replace existing "Pets"/ })
    expect(replace).toBeChecked()
    expect(screen.getByRole('radio', { name: /Import as a copy named "Pets \(2\)"/ })).not.toBeChecked()
    expect(screen.getByText(/version snapshot of the current content/)).toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
    await waitFor(() => expect(onclose).toHaveBeenCalled())

    expect(app.collections.map((c) => c.id)).toEqual([id])
    expect(app.requestsOf(id).map((r) => r.name).sort()).toEqual(['Cats', 'List'])
    const call = mock.calls.find((c) => c.method === 'replaceCollectionFromPostman')!
    expect(call.args).toEqual([id, updated(), 'pets.json'])
    const versions = await mock.listCollectionVersions(id)
    expect(versions).toMatchObject([{ version: '0.0.1', notes: 'Automatic snapshot before re-import from pets.json', requestCount: 2 }])
    expect(toast.items.find((t) => t.kind === 'success')?.detail).toMatch(/saved as version 0\.0\.1/)
    // The replaced folder stays expanded under its new id.
    const newDogs = app.foldersOf(id)[0]!
    expect(newDogs.id).not.toBe(dogs.id)
    expect(expandedStore.keys.has(`folder:${newDogs.id}`)).toBe(true)
  })

  it('clean tabs follow the replaced request; dirty tabs keep their unsaved edits', async () => {
    const { onclose, created } = await setupExisting({ text: collection() })
    const id = created[0]!.collection.id
    const [list, health] = [...app.requestsOf(id)].sort((a, b) => a.name.localeCompare(b.name)).reverse()
    expect([list!.name, health!.name]).toEqual(['List', 'Health'])
    const clean = tabsStore.openRequest(list!)
    const dirty = tabsStore.openRequest(health!)
    dirty.draft.url = 'https://x.test/edited'
    await pick(updated({ item: [{ name: 'Dogs', item: [{ name: 'List', request: { method: 'GET', url: 'https://x.test/v2/dogs' } }] }, { name: 'Health', request: { method: 'GET', url: 'https://x.test/v2/health' } }] }))
    await fireEvent.click(await screen.findByRole('button', { name: 'Replace' }))
    await waitFor(() => expect(onclose).toHaveBeenCalled())

    const newList = app.requestsOf(id).find((r) => r.name === 'List')!
    expect(newList.id).not.toBe(list!.id)
    expect(tabsStore.tabs).toContain(clean)
    expect(clean.requestId).toBe(newList.id)
    expect(clean.draft.url).toBe('https://x.test/v2/dogs')
    expect(clean.dirty).toBe(false)
    expect(tabsStore.tabs).toContain(dirty)
    expect(dirty.draft.url).toBe('https://x.test/edited')
    expect(dirty.requestId).toBeNull()
  })

  it('imports as a copy named X (2), then X (3)', async () => {
    const { mock, onclose } = await setupExisting({ text: collection() }, { text: collection(), name: 'Pets (2)' })
    await pick(collection())
    await fireEvent.click(await screen.findByRole('radio', { name: /Import as a copy named "Pets \(3\)"/ }))
    await fireEvent.click(screen.getByRole('button', { name: 'Import as copy' }))
    await waitFor(() => expect(onclose).toHaveBeenCalled())
    expect(app.collections.map((c) => c.name).sort()).toEqual(['Pets', 'Pets (2)', 'Pets (3)'])
    expect(mock.calls.some((c) => c.method === 'replaceCollectionFromPostman')).toBe(false)
  })

  it('lets the user pick which of several matches to replace', async () => {
    const { mock, onclose, created } = await setupExisting({ text: collection() }, { text: collection({ info: { name: 'pets' } }) })
    await pick(updated())
    expect(await screen.findByText(/2 collections in the workspace match this file by name/)).toBeInTheDocument()
    const picker = screen.getByLabelText('Collection to replace') as HTMLSelectElement
    expect(picker.options).toHaveLength(2)
    const second = created[1]!.collection
    await fireEvent.change(picker, { target: { value: second.id } })
    expect(screen.getByRole('radio', { name: /Replace existing "pets"/ })).toBeChecked()
    await fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
    await waitFor(() => expect(onclose).toHaveBeenCalled())
    expect(mock.calls.find((c) => c.method === 'replaceCollectionFromPostman')!.args[0]).toBe(second.id)
    expect(app.requestsOf(second.id).map((r) => r.name).sort()).toEqual(['Cats', 'List'])
    expect(app.requestsOf(created[0]!.collection.id).map((r) => r.name).sort()).toEqual(['Health', 'List'])
  })

  it('matches a renamed collection by _postman_id', async () => {
    const pid = '11111111-2222-4333-8444-555555555555'
    const { mock, created } = await setupExisting({ text: collection({ info: { _postman_id: pid, name: 'Pets' } }) })
    await mock.renameCollection(created[0]!.collection.id, 'My pets')
    await app.reloadCollections()
    await pick(updated({ info: { _postman_id: pid, name: 'Pets' } }))
    expect(await screen.findByRole('radio', { name: /Replace existing "My pets"/ })).toBeChecked()
    expect(screen.getByText('This collection already exists in the workspace.')).toBeInTheDocument()
  })

  it('does not offer replace in a read-only workspace', async () => {
    const { mock } = await setupExisting({ text: collection() })
    sync.statuses = { [app.workspaceId!]: { ...(await mock.getSyncStatus(app.workspaceId!)), linked: true, readOnly: true, remoteName: 'Team' } }
    await pick(updated())
    const replace = await screen.findByRole('radio', { name: /Replace existing "Pets"/ })
    expect(replace).toBeDisabled()
    expect(replace).not.toBeChecked()
    expect(screen.getByRole('radio', { name: /Import as a copy/ })).toBeChecked()
    expect(screen.getByText(/Not available:/)).toHaveTextContent(/viewer|read-only/i)
    expect(screen.getByRole('button', { name: 'Import as copy' })).toBeEnabled()
  })

  it('Cancel closes without importing', async () => {
    const { mock, onclose } = await setupExisting({ text: collection() })
    await pick(updated())
    await screen.findByRole('radio', { name: /Replace existing/ })
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onclose).toHaveBeenCalled()
    expect(mock.calls.filter((c) => c.method === 'replaceCollectionFromPostman' || c.method === 'importPostmanCollection')).toHaveLength(1)
  })
})
