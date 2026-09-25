import { EditorView } from '@codemirror/view'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../app/state.svelte'
import { toast } from '../../app/toast.svelte'
import { ui } from '../../app/ui.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import QuickOpen from '../requests/QuickOpen.svelte'
import { tabsStore } from '../requests/tabs.svelte'
import UrlBar from '../requests/UrlBar.svelte'
import { sync } from '../sync/syncStore.svelte'
import ImportDialog from './ImportDialog.svelte'
import { detectImportText, parsePostmanFile } from './parse'

Element.prototype.scrollIntoView ??= function () {}

const SCHEMA_21 = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
const SCHEMA_20 = 'https://schema.getpostman.com/json/collection/v2.0.0/collection.json'
const req = (name: string, url = `https://x.test/${name.toLowerCase()}`) => ({ name, request: { method: 'GET', url } })

const collection = (info: object = {}, extra: object = {}) =>
  JSON.stringify(
    {
      info: { name: 'Pets', _postman_id: '1d3f8a2b-0000-4000-8000-000000000001', schema: SCHEMA_21, ...info },
      item: [{ name: 'Dogs', item: [req('List')] }, req('Health')],
      ...extra,
    },
    null,
    2,
  )
const envFile = (name: string, values: Array<{ key: string; value: string; type?: string }>, exportedUsing = 'Postman/11.2.0') =>
  JSON.stringify({ id: 'e1', name, values: values.map((v) => ({ type: 'default', enabled: true, ...v })), _postman_variable_scope: 'environment', _postman_exported_using: exportedUsing }, null, 2)

/** A collection export of roughly `mb` megabytes. */
function hugeCollection(mb: number): string {
  const body = 'x'.repeat(1000)
  const item = Array.from({ length: Math.ceil((mb * 1024 * 1024) / 1100) }, (_, i) => ({
    name: `R${i}`,
    request: { method: 'POST', url: `https://x.test/r/${i}`, body: { mode: 'raw', raw: body } },
  }))
  return JSON.stringify({ info: { name: 'Huge', schema: SCHEMA_21 }, item })
}

function pasteEvent(text: string): ClipboardEvent {
  const e = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(e, 'clipboardData', { value: { getData: (t: string) => (t === 'text/plain' ? text : ''), types: ['text/plain'] } })
  return e
}

async function setup(props: { initialText?: string | null } = {}) {
  const mock = createMockBackend({ latencyMs: 0, seed: false })
  window.slinger = mock
  sync.statuses = {}
  await app.init()
  toast.clear()
  const onclose = vi.fn()
  render(ImportDialog, { open: true, onclose, ...props })
  return { mock, onclose }
}
const area = () => screen.getByLabelText('Or paste JSON') as HTMLTextAreaElement
/** Paste into the paste area like a browser does: the value changes, then the parse runs. */
async function pasteIntoArea(text: string) {
  const el = area()
  const e = pasteEvent(text)
  el.dispatchEvent(e)
  if (!e.defaultPrevented) {
    el.value = text
    await fireEvent.input(el)
  }
}
async function pickFile(text: string, name = 'x.json') {
  const input = screen.getByLabelText('Import file') as HTMLInputElement
  Object.defineProperty(input, 'files', { value: [new File([text], name, { type: 'application/json' })], configurable: true })
  await fireEvent.change(input)
}

beforeEach(() => vi.restoreAllMocks())
afterEach(() => {
  cleanup()
  ui.closeImport()
})

describe('detectImportText', () => {
  it('recognises collections v2.0 / v2.1, Slinger collections and Postman / Slinger environments', () => {
    expect(detectImportText(collection())).toBe('collection')
    expect(detectImportText(collection({ schema: SCHEMA_20 }))).toBe('collection')
    expect(detectImportText(collection({ version: '1.2.0', _slinger: { formatVersion: 1, versions: [] } }))).toBe('collection')
    expect(detectImportText(envFile('Prod', [{ key: 'host', value: 'https://prod.example.com/api/v1/really/long/path' }]))).toBe('environment')
    expect(detectImportText(envFile('Prod', [{ key: 'host', value: 'https://prod.example.com/api/v1/really/long/path' }], 'Slinger/0.4.1'))).toBe('environment')
  })

  it('rejects short text, URLs, arrays and other JSON', () => {
    expect(detectImportText('{"a":1}')).toBeNull()
    expect(detectImportText('https://api.example.com/items?q={{term}}&page=2'.repeat(10))).toBeNull()
    expect(detectImportText(JSON.stringify([JSON.parse(collection())]))).toBeNull()
    expect(detectImportText(JSON.stringify({ data: 'x'.repeat(500), item: [] }))).toBeNull() // no info
    expect(detectImportText(JSON.stringify({ name: 'x', values: [], pad: 'x'.repeat(300) }))).toBeNull() // no scope
    expect(detectImportText('{' + 'x'.repeat(500) + '}')).toBeNull() // not JSON
  })

  it('labels the detected source', () => {
    const src = (t: string) => (parsePostmanFile(t) as { ok: true; file: { source: string } }).file.source
    expect(src(collection())).toBe('Postman collection v2.1')
    expect(src(collection({ schema: SCHEMA_20 }))).toBe('Postman collection v2.0')
    expect(src(collection({ version: '1.2.0', _slinger: { formatVersion: 1, versions: [] } }))).toBe('Slinger collection v1.2.0')
    expect(src(envFile('Prod', []))).toBe('Postman environment')
    expect(src(envFile('Prod', [], 'Slinger/0.4.1'))).toBe('Slinger environment')
  })

  it('stays fast on huge input (5 MB+)', () => {
    const huge = hugeCollection(5.5)
    expect(huge.length).toBeGreaterThan(5 * 1024 * 1024)
    let t = performance.now()
    expect(detectImportText(huge)).toBe('collection')
    expect(performance.now() - t).toBeLessThan(2000)
    // Text that is obviously not an export is rejected without parsing.
    const notJson = 'h' + huge
    t = performance.now()
    expect(detectImportText(notJson)).toBeNull()
    expect(performance.now() - t).toBeLessThan(100)
  })
})

describe('Import dialog: pasted JSON', () => {
  it('is titled Import and not Postman-only', async () => {
    await setup()
    expect(screen.getByRole('dialog', { name: 'Import' })).toBeInTheDocument()
    expect(screen.getByTestId('import-subtitle')).toHaveTextContent('Slinger or Postman collections and environments (JSON)')
    expect(screen.getByLabelText('Import file')).toBeInTheDocument()
  })

  it('previews and imports a pasted collection', async () => {
    const { mock, onclose } = await setup()
    await pasteIntoArea(collection({}, { variable: [{ key: 'baseUrl', value: 'https://x.test' }] }))
    const preview = await screen.findByLabelText('Import preview')
    expect(preview).toHaveTextContent('Pets')
    expect(screen.getByTestId('import-source')).toHaveTextContent('Postman collection v2.1')
    expect(screen.getByTestId('import-paste-size')).toHaveTextContent(/pasted/)
    await fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(onclose).toHaveBeenCalled())
    const col = app.collections.find((c) => c.name === 'Pets')!
    expect(app.requestsOf(col.id)).toHaveLength(2)
    const env = app.environments.find((e) => e.name === 'Pets')!
    expect((await mock.listEnvironmentVariables(env.id)).map((v) => v.key)).toEqual(['baseUrl'])
  })

  it('imports a pasted Slinger environment and merges into an existing one', async () => {
    const { mock, onclose } = await setup()
    const existing = await mock.createEnvironment(app.workspaceId!, 'Staging')
    await mock.upsertEnvironmentVariable({ environmentId: existing.id, key: 'host', value: 'old', isSecret: false })
    await app.reloadEnvironments()
    await pasteIntoArea(envFile('Staging', [{ key: 'host', value: 'new' }, { key: 'token', value: 't', type: 'secret' }], 'Slinger/0.4.1'))
    expect(await screen.findByTestId('import-source')).toHaveTextContent('Slinger environment')
    expect(screen.getByTestId('import-env-help')).toHaveTextContent('already exists')
    await fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(onclose).toHaveBeenCalled())
    const vars = await mock.listEnvironmentVariables(existing.id)
    expect(vars.map((v) => [v.key, v.isSecret ? '(secret)' : v.value, v.isSecret])).toEqual([
      ['host', 'new', false],
      ['token', '(secret)', true],
    ])
    expect(app.environments.filter((e) => e.name === 'Staging')).toHaveLength(1)
  })

  it('shows an inline error for invalid JSON and for other JSON', async () => {
    await setup()
    await pasteIntoArea('{"oops": ')
    expect(await screen.findByRole('alert')).toHaveTextContent(/not valid JSON/)
    await pasteIntoArea('{"hello": "world"}')
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Not a collection or environment: expected info.schema'))
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled()
  })

  it('uses whichever was provided last and clears errors when switching', async () => {
    await setup()
    await pickFile('not json', 'bad.json')
    expect(await screen.findByRole('alert')).toHaveTextContent(/not valid JSON/)
    await pasteIntoArea(envFile('Prod', [{ key: 'a', value: '1' }]))
    expect(await screen.findByTestId('import-source')).toHaveTextContent('Postman environment')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByTestId('import-file-name')).toBeNull()
    await pickFile(collection(), 'pets.json')
    await waitFor(() => expect(screen.getByTestId('import-source')).toHaveTextContent('Postman collection v2.1'))
    expect(area().value).toBe('')
    expect(screen.getByTestId('import-file-name')).toHaveTextContent('pets.json')
    await pasteIntoArea('nope')
    expect(await screen.findByRole('alert')).toHaveTextContent(/not valid JSON/)
    expect(screen.queryByLabelText('Import preview')).toBeNull()
  })

  it('parses typed text only after a pause, not on every keystroke', async () => {
    await setup()
    const el = area()
    el.value = '{"info": {"name": "T"}, "item": [{"name": "a", "request": {"method": "GET", "url": "x"}}]}'
    await fireEvent.input(el)
    expect(screen.queryByLabelText('Import preview')).toBeNull()
    expect(await screen.findByLabelText('Import preview', {}, { timeout: 1500 })).toHaveTextContent('T')
  })

  it('Ctrl+V outside a text field pastes into the dialog', async () => {
    await setup()
    const e = pasteEvent(collection())
    document.body.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
    expect(await screen.findByLabelText('Import preview')).toHaveTextContent('Pets')
    expect(area().value).toContain('"Pets"')
  })

  it('handles a 5 MB+ paste without putting it into the textarea', async () => {
    const { onclose } = await setup()
    const huge = hugeCollection(5.5)
    const e = pasteEvent(huge)
    area().dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
    expect(await screen.findByTestId('import-paste-large')).toHaveTextContent(/MB/)
    expect(area().value).toBe('')
    expect(screen.getByLabelText('Import preview')).toHaveTextContent('Huge')
    await fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(onclose).toHaveBeenCalled())
    expect(app.requestsOf(app.collections.find((c) => c.name === 'Huge')!.id).length).toBeGreaterThan(4000)
  })

  it('a pasted collection that already exists offers Replace (default) or Copy', async () => {
    const mock = createMockBackend({ latencyMs: 0, seed: false })
    window.slinger = mock
    sync.statuses = {}
    await app.init()
    const first = await mock.importPostmanCollection(app.workspaceId!, collection())
    await app.reloadCollections()
    const onclose = vi.fn()
    render(ImportDialog, { open: true, onclose })
    const updated = collection({}, { item: [req('Cats')] })
    await pasteIntoArea(updated)
    expect(await screen.findByRole('radio', { name: /Replace existing "Pets"/ })).toBeChecked()
    expect(screen.getByRole('radio', { name: /Import as a copy named "Pets \(2\)"/ })).toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
    await waitFor(() => expect(onclose).toHaveBeenCalled())
    expect(mock.calls.find((c) => c.method === 'replaceCollectionFromPostman')!.args).toEqual([first.collection.id, updated, 'pasted JSON'])
    expect((await mock.listCollectionVersions(first.collection.id))[0]!.notes).toBe('Automatic snapshot before re-import from pasted JSON')
    expect(app.requestsOf(first.collection.id).map((r) => r.name)).toEqual(['Cats'])
  })

  it('opens prefilled with text pasted elsewhere, with a note', async () => {
    await setup({ initialText: envFile('Prod', [{ key: 'a', value: '1' }]) })
    expect(await screen.findByTestId('import-note')).toHaveTextContent('Detected pasted environment — review and import')
    expect(screen.getByLabelText('Import preview')).toHaveTextContent('Prod')
    expect(area().value).toContain('"Prod"')
    await pasteIntoArea(collection())
    await waitFor(() => expect(screen.queryByTestId('import-note')).toBeNull())
  })
})

describe('URL bar paste', () => {
  function renderUrlBar() {
    const tab = tabsStore.newTab()
    const { container } = render(UrlBar, { tab, onsend: vi.fn(), oncancel: vi.fn(), onsave: vi.fn() })
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!
    return { tab, view }
  }
  beforeEach(async () => {
    window.slinger = createMockBackend({ latencyMs: 0, seed: false })
    sync.statuses = {}
    await app.init()
    ui.closeImport()
  })

  it('a pasted collection opens the Import dialog prefilled; the URL is unchanged', () => {
    const { tab, view } = renderUrlBar()
    const text = collection()
    const e = pasteEvent(text)
    view.contentDOM.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
    expect(ui.importOpen).toBe(true)
    expect(ui.importText).toBe(text)
    expect(tab.draft.url).toBe('')
    expect(view.state.doc.toString()).toBe('')
  })

  it('a pasted environment opens the Import dialog too', () => {
    const { view } = renderUrlBar()
    view.contentDOM.dispatchEvent(pasteEvent(envFile('Prod', [{ key: 'host', value: 'https://prod.example.com/api/v1/some/long/path/segment' }])))
    expect(ui.importOpen).toBe(true)
  })

  it.each([
    ['a URL', 'https://api.example.com/items?page=2&q={{term}}'],
    ['small JSON', '{"a":1}'],
    ['other long JSON', JSON.stringify({ data: 'x'.repeat(400) })],
  ])('%s pastes as usual', (_what, text) => {
    const { tab, view } = renderUrlBar()
    view.contentDOM.dispatchEvent(pasteEvent(text))
    expect(ui.importOpen).toBe(false)
    expect(view.state.doc.toString()).toBe(text)
    expect(tab.draft.url).toBe(text)
  })
})

describe('Import entry points', () => {
  it('Ctrl+K has an Import command', async () => {
    window.slinger = createMockBackend({ latencyMs: 0, seed: false })
    sync.statuses = {}
    await app.init()
    ui.quickOpen = true
    render(QuickOpen)
    const input = screen.getByRole('combobox', { name: 'Search requests and commands' })
    await fireEvent.input(input, { target: { value: '> import' } })
    expect(screen.getAllByRole('option').map((o) => o.textContent?.replace(/\s+/g, ' ').trim())).toContain(
      'Import collection or environment… Slinger or Postman JSON, file or paste',
    )
    await fireEvent.keyDown(input, { key: 'Enter' })
    expect(ui.importOpen).toBe(true)
    expect(ui.importText).toBeNull()
  })
})
