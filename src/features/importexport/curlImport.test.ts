import { EditorView } from '@codemirror/view'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiFolder, Collection } from '../../../shared/types'
import { app } from '../../app/state.svelte'
import { toast } from '../../app/toast.svelte'
import { ui } from '../../app/ui.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import { tabsStore } from '../requests/tabs.svelte'
import UrlBar from '../requests/UrlBar.svelte'
import { sync } from '../sync/syncStore.svelte'
import { defaultCurlTarget, folderChoices } from './curlImport'
import ImportDialog from './ImportDialog.svelte'
import { detectImportText } from './parse'

Element.prototype.scrollIntoView ??= function () {}

const CURL = `curl -X POST 'https://api.example.com/orders?dry=1' \\
  -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer $TOKEN' \\
  --proxy http://p:1 \\
  -d '{"item":"book"}'`

function pasteEvent(text: string): ClipboardEvent {
  const e = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(e, 'clipboardData', { value: { getData: (t: string) => (t === 'text/plain' ? text : ''), types: ['text/plain'] } })
  return e
}

let mock: ReturnType<typeof createMockBackend>
async function setup(props: { initialText?: string | null } = {}) {
  mock = createMockBackend({ latencyMs: 0, seed: false })
  window.slinger = mock
  sync.statuses = {}
  await app.init()
  toast.clear()
  const ws = app.workspaceId!
  const shop = await mock.createCollection(ws, 'Shop')
  const admin = await mock.createFolder({ workspaceId: ws, collectionId: shop.id, parentFolderId: null, name: 'Admin' })
  await mock.createCollection(ws, 'Other')
  await app.reloadCollections()
  const onclose = vi.fn()
  render(ImportDialog, { open: true, onclose, ...props })
  return { onclose, shop, admin }
}

async function paste(text: string) {
  const el = screen.getByLabelText('Or paste JSON or a cURL command') as HTMLTextAreaElement
  el.value = text
  await fireEvent.input(el)
  await screen.findByTestId('curl-preview', {}, { timeout: 2000 })
}

afterEach(() => {
  cleanup()
  ui.closeImport()
})

describe('Import dialog: cURL commands', () => {
  it('previews a pasted curl and adds it as a request to the chosen collection and folder', async () => {
    const { onclose, shop, admin } = await setup()
    await paste(CURL)
    const item = screen.getByTestId('curl-request')
    expect(item).toHaveTextContent('POST')
    expect(item).toHaveTextContent('https://api.example.com/orders?dry=1')
    expect(screen.getByTestId('curl-summary')).toHaveTextContent('2 headers · JSON body')
    expect(screen.getByTestId('curl-warnings')).toHaveTextContent('The proxy http://p:1 was not imported')
    expect((screen.getByLabelText('Request name') as HTMLInputElement).value).toBe('POST /orders')

    await fireEvent.change(screen.getByLabelText('Collection'), { target: { value: shop.id } })
    await fireEvent.change(screen.getByLabelText('Folder'), { target: { value: admin.id } })
    await fireEvent.input(screen.getByLabelText('Request name'), { target: { value: 'Create order' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Add request' }))
    await waitFor(() => expect(onclose).toHaveBeenCalled())

    const [r] = await mock.listRequests(shop.id)
    expect(r).toMatchObject({ name: 'Create order', method: 'POST', url: 'https://api.example.com/orders?dry=1', folderId: admin.id })
    const doc = JSON.parse(r!.documentJson)
    expect(doc.headers).toEqual([
      expect.objectContaining({ key: 'Content-Type', value: 'application/json' }),
      expect.objectContaining({ key: 'Authorization', value: 'Bearer $TOKEN' }),
    ])
    expect(doc.body).toMatchObject({ mode: 'raw', raw: '{"item":"book"}', options: { raw: { language: 'json' } } })
    expect(doc.params).toEqual([expect.objectContaining({ key: 'dry', value: '1' })])
    expect(tabsStore.active?.requestId).toBe(r!.id)
    expect(toast.items.at(-1)).toMatchObject({ title: 'Request added' })
  })

  it('adds several commands, into a new collection when chosen', async () => {
    const { onclose } = await setup()
    await paste('curl https://a.example/one\ncurl -X DELETE https://a.example/two')
    expect(screen.getAllByTestId('curl-request')).toHaveLength(2)
    expect((screen.getByLabelText('Name of request 2') as HTMLInputElement).value).toBe('DELETE /two')
    await fireEvent.change(screen.getByLabelText('Collection'), { target: { value: '' } })
    await fireEvent.input(screen.getByLabelText('New collection name'), { target: { value: 'From docs' } })
    expect(screen.queryByLabelText('Folder')).toBeNull()
    await fireEvent.click(screen.getByRole('button', { name: 'Add 2 requests' }))
    await waitFor(() => expect(onclose).toHaveBeenCalled())
    const created = app.collections.find((c) => c.name === 'From docs')!
    expect((await mock.listRequests(created.id)).map((r) => [r.method, r.name])).toEqual([
      ['GET', 'GET /one'],
      ['DELETE', 'DELETE /two'],
    ])
  })

  it('shows why a curl cannot be read; JSON still goes the export way', async () => {
    await setup()
    const el = screen.getByLabelText('Or paste JSON or a cURL command') as HTMLTextAreaElement
    el.value = "curl 'https://x"
    await fireEvent.input(el)
    expect(await screen.findByText("A single quote (') is never closed.", {}, { timeout: 2000 })).toBeInTheDocument()
    expect(screen.queryByTestId('curl-preview')).toBeNull()
  })

  it('reads curl from a chosen text file', async () => {
    await setup()
    const input = screen.getByLabelText('Import file') as HTMLInputElement
    Object.defineProperty(input, 'files', { value: [new File(['curl https://f.example/x\n'], 'call.sh', { type: 'text/plain' })], configurable: true })
    await fireEvent.change(input)
    expect(within(await screen.findByTestId('curl-preview')).getByTestId('curl-request')).toHaveTextContent('https://f.example/x')
  })

  it('opened with a curl pasted elsewhere, it says so', async () => {
    await setup({ initialText: 'curl https://h.example/ping' })
    expect(await screen.findByTestId('import-note')).toHaveTextContent('Detected pasted cURL command — choose where to add it')
  })
})

describe('URL bar paste of a curl', () => {
  beforeEach(async () => {
    window.slinger = createMockBackend({ latencyMs: 0, seed: false })
    sync.statuses = {}
    await app.init()
    ui.closeImport()
  })

  it('opens the Import dialog with it; the URL is unchanged', () => {
    const tab = tabsStore.newTab()
    const { container } = render(UrlBar, { tab, onsend: vi.fn(), oncancel: vi.fn(), onsave: vi.fn() })
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!
    const e = pasteEvent(CURL)
    view.contentDOM.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
    expect(ui.importOpen).toBe(true)
    expect(ui.importText).toBe(CURL)
    expect(tab.draft.url).toBe('')
  })

  it('detectImportText knows curl; a plain URL is not an import', () => {
    expect(detectImportText('curl https://x.example')).toBe('curl')
    expect(detectImportText('https://x.example/curl')).toBeNull()
  })
})

describe('placement helpers', () => {
  const col = (id: string): Collection => ({ id, name: id, workspaceId: 'w', createdAt: 0, updatedAt: 0 }) as unknown as Collection
  const folder = (id: string, parentFolderId: string | null, name: string, sortOrder = 0): ApiFolder =>
    ({ id, parentFolderId, name, sortOrder, collectionId: 'c' }) as unknown as ApiFolder

  it('lists folders in tree order with their path', () => {
    expect(folderChoices([folder('b', null, 'Users', 1), folder('a', null, 'Admin', 0), folder('c', 'a', 'Keys')])).toEqual([
      { id: 'a', label: 'Admin' },
      { id: 'c', label: 'Admin / Keys' },
      { id: 'b', label: 'Users' },
    ])
  })

  it("defaults to the open tab's collection and folder, else the first collection, else a new one", () => {
    expect(defaultCurlTarget([col('x'), col('y')], { collectionId: 'y', folderId: 'f' })).toMatchObject({ collectionId: 'y', folderId: 'f' })
    expect(defaultCurlTarget([col('x'), col('y')], null)).toMatchObject({ collectionId: 'x', folderId: null })
    expect(defaultCurlTarget([], null)).toMatchObject({ collectionId: null, newName: 'Imported from cURL' })
  })
})
