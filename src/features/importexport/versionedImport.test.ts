import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../app/state.svelte'
import { toast } from '../../app/toast.svelte'
import { ui } from '../../app/ui.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import { exportPostmanCollection } from '../../lib/postman'
import { buildSlingerBlock, latestVersion } from '../../lib/slingerExport'
import QuickOpen from '../requests/QuickOpen.svelte'
import ImportDialog from './ImportDialog.svelte'
import { parsePostmanFile } from './parse'

Element.prototype.scrollIntoView ??= function () {}

type Mock = ReturnType<typeof createMockBackend>

async function setup() {
  const mock = createMockBackend({ latencyMs: 0, seed: false })
  window.slinger = mock
  await app.init()
  toast.clear()
  return mock
}

/** A collection with versions 1.0.0 and 1.1.0, exported like the Export dialog does. */
async function versionedExport(mock: Mock, includeSnapshots = true): Promise<string> {
  const ws = app.workspaceId!
  const col = await mock.createCollection(ws, 'enat uat')
  await mock.createRequest({ workspaceId: ws, collectionId: col.id, name: 'Ping', method: 'GET', url: 'https://x.test/ping', documentJson: '{}' })
  await mock.createCollectionVersion({ collectionId: col.id, version: '1.0.0', notes: 'first' })
  await mock.createRequest({ workspaceId: ws, collectionId: col.id, name: 'Pong', method: 'POST', url: 'https://x.test/pong', documentJson: '{}' })
  await mock.createCollectionVersion({ collectionId: col.id, version: '1.1.0', notes: null })
  const list = await mock.listCollectionVersions(col.id)
  const versions = await Promise.all(list.map((v) => mock.getCollectionVersion(v.id)))
  return exportPostmanCollection({
    collection: col,
    folders: await mock.listFolders(col.id),
    requests: await mock.listRequests(col.id),
    version: latestVersion(list),
    slinger: buildSlingerBlock({ collectionId: col.id, versions, includeSnapshots, appVersion: 'test' }),
  })
}

async function pick(text: string, name: string) {
  const input = screen.getByLabelText('Import file') as HTMLInputElement
  expect(input.accept).toContain('.slinger_collection.json')
  expect(input.accept).toContain('.postman_collection.json')
  Object.defineProperty(input, 'files', { value: [new File([text], name, { type: 'application/json' })], configurable: true })
  await fireEvent.change(input)
}

beforeEach(() => vi.restoreAllMocks())

describe('dev mock backend: versioned import', () => {
  it('restores versions with notes, dates and snapshots', async () => {
    const mock = await setup()
    const text = await versionedExport(mock)
    const other = await mock.createWorkspace('Other')
    const result = await mock.importPostmanCollection(other.id, text)
    expect(result.versionHistory).toEqual({ restored: 2, skipped: 0, notes: [] })
    const versions = await mock.listCollectionVersions(result.collection.id)
    expect(versions.map((v) => [v.version, v.notes, v.requestCount])).toEqual([
      ['1.1.0', null, 2],
      ['1.0.0', 'first', 1],
    ])
    const restored = await mock.getCollectionVersion(versions[1]!.id)
    expect(restored.snapshot.requests.map((r) => r.name)).toEqual(['Ping'])
  })

  it('metadata-only files and malformed blocks import the collection and report why', async () => {
    const mock = await setup()
    const meta = await mock.importPostmanCollection(app.workspaceId!, await versionedExport(mock, false))
    expect(meta.versionHistory).toMatchObject({ restored: 0, skipped: 2 })
    expect(meta.versionHistory!.notes[0]).toMatch(/2 versions were exported without snapshots/)
    const broken = JSON.parse(await versionedExport(mock))
    broken.info._slinger = { formatVersion: 1, versions: [{ version: 'nope' }] }
    const r = await mock.importPostmanCollection(app.workspaceId!, JSON.stringify(broken))
    expect(r.requests).toHaveLength(2)
    expect(r.versionHistory!.notes[0]).toMatch(/^Version history not restored/)
  })
})

describe('Import dialog with a Slinger export', () => {
  it('previews the version history and reports the restore in a toast', async () => {
    const mock = await setup()
    const text = await versionedExport(mock)
    expect(parsePostmanFile(text)).toMatchObject({ ok: true, file: { kind: 'collection', history: { versions: 2, snapshots: true, latest: '1.1.0' } } })
    const onclose = vi.fn()
    render(ImportDialog, { open: true, onclose })
    await pick(text, 'enat uat v1.1.0.slinger_collection.json')
    expect(await screen.findByTestId('import-history')).toHaveTextContent('2 versions, latest v1.1.0')
    await fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(onclose).toHaveBeenCalled())
    expect(toast.items.some((t) => t.title === 'Version history restored' && t.detail === '2 versions restored')).toBe(true)
  })

  it('pasted export JSON restores the version history like the file does', async () => {
    const mock = await setup()
    const text = await versionedExport(mock)
    const onclose = vi.fn()
    render(ImportDialog, { open: true, onclose })
    const area = screen.getByLabelText('Or paste JSON') as HTMLTextAreaElement
    area.value = text
    await fireEvent.input(area)
    await fireEvent.blur(area)
    expect(await screen.findByTestId('import-source')).toHaveTextContent('Slinger collection v1.1.0')
    expect(screen.getByTestId('import-history')).toHaveTextContent('2 versions, latest v1.1.0')
    await fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(onclose).toHaveBeenCalled())
    expect(toast.items.some((t) => t.title === 'Version history restored' && t.detail === '2 versions restored')).toBe(true)
  })

  it('a metadata-only file is flagged in the preview and the toast explains it', async () => {
    const mock = await setup()
    const text = await versionedExport(mock, false)
    const onclose = vi.fn()
    render(ImportDialog, { open: true, onclose })
    await pick(text, 'x.json')
    expect(await screen.findByTestId('import-history')).toHaveTextContent('not restorable')
    await fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(onclose).toHaveBeenCalled())
    expect(toast.items.some((t) => t.title === 'Version history: 0 versions restored' && /without snapshots/.test(t.detail ?? ''))).toBe(true)
  })
})

describe('Import dialog: replacing a collection from a Slinger export', () => {
  it('replace adds the file versions next to the safety snapshot and reports skipped duplicates', async () => {
    const mock = await setup()
    const text = await versionedExport(mock)
    await app.reloadCollections() // the exported collection is now in the workspace: the dialog offers Replace
    const col = app.collections.find((c) => c.name === 'enat uat')!
    const onclose = vi.fn()
    render(ImportDialog, { open: true, onclose })
    await pick(text, 'enat uat v1.1.0.slinger_collection.json')
    expect(await screen.findByTestId('reimport-choice')).toBeInTheDocument()
    expect((screen.getByRole('radio', { name: /Replace existing/ }) as HTMLInputElement).checked).toBe(true)
    await fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
    await waitFor(() => expect(onclose).toHaveBeenCalled())
    expect(toast.items.some((t) => t.title === 'Collection replaced')).toBe(true)
    const history = toast.items.find((t) => t.title === 'Version history: 0 versions restored')
    expect(history?.detail).toBe('Version 1.0.0 is already in this collection; skipped. Version 1.1.0 is already in this collection; skipped.')
    const versions = (await mock.listCollectionVersions(col.id)).map((v) => v.version)
    expect(versions).toEqual(['1.1.1', '1.1.0', '1.0.0']) // the safety snapshot plus the untouched originals
  })

  it('mock backend: replace restores versions into a collection without them', async () => {
    const mock = await setup()
    const text = await versionedExport(mock)
    const target = await mock.importPostmanCollection(app.workspaceId!, JSON.stringify({ info: { name: 'T', schema: 'x' }, item: [{ name: 'a', request: { method: 'GET', url: 'x' } }] }))
    const r = await mock.replaceCollectionFromPostman(target.collection.id, text, 'f.json')
    expect(r.safetyVersion.version).toBe('0.0.1')
    expect(r.versionHistory).toEqual({ restored: 2, skipped: 0, notes: [] })
    expect((await mock.listCollectionVersions(target.collection.id)).map((v) => v.version)).toEqual(['1.1.0', '1.0.0', '0.0.1'])
  })
})

describe('Ctrl+K export commands', () => {
  it('opens the collection and environment export dialogs', async () => {
    const mock = await setup()
    const col = await mock.createCollection(app.workspaceId!, 'enat uat')
    const env = await mock.createEnvironment(app.workspaceId!, 'Prod')
    await app.reloadCollections()
    await app.reloadEnvironments()
    ui.quickOpen = true
    ui.exportCollectionId = null
    ui.exportEnvironmentId = null
    render(QuickOpen)
    const input = screen.getByRole('combobox', { name: 'Search requests and commands' })
    await fireEvent.input(input, { target: { value: '> export' } })
    const options = screen.getAllByRole('option').map((o) => o.textContent?.replace(/\s+/g, ' ').trim())
    expect(options).toContain('Export collection: enat uat with version history')
    expect(options).toContain('Export environment: Prod Postman environment file')
    await fireEvent.input(input, { target: { value: '> export environment prod' } })
    await fireEvent.keyDown(input, { key: 'Enter' })
    expect(ui.exportEnvironmentId).toBe(env.id)
    expect(ui.quickOpen).toBe(false)
    ui.quickOpen = true
    render(QuickOpen)
    const again = screen.getAllByRole('combobox', { name: 'Search requests and commands' }).at(-1)!
    await fireEvent.input(again, { target: { value: '> export collection enat' } })
    await fireEvent.keyDown(again, { key: 'Enter' })
    expect(ui.exportCollectionId).toBe(col.id)
  })
})
