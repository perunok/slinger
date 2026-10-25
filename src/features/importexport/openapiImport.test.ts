import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../app/state.svelte'
import { toast } from '../../app/toast.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import { tabsStore } from '../requests/tabs.svelte'
import ImportDialog from './ImportDialog.svelte'
import { looksLikeOpenApi, specUrlOf } from './openapiDetect'

const fixture = (name: string) => readFileSync(join(__dirname, '../../../electron/__tests__/openapi/fixtures', name), 'utf8')
const SHOP = fixture('shop-3.0.yaml')
const SWAGGER = fixture('petstore-2.0.json')

describe('recognising OpenAPI documents', () => {
  it('YAML and JSON documents, not Postman collections that mention openapi', () => {
    expect(looksLikeOpenApi(SHOP)).toBe(true)
    expect(looksLikeOpenApi(SWAGGER)).toBe(true)
    expect(looksLikeOpenApi('{"openapi":"3.1.0","info":{}}')).toBe(true)
    expect(looksLikeOpenApi('# comment\nswagger: "2.0"\ninfo: {}')).toBe(true)
    expect(looksLikeOpenApi(JSON.stringify({ info: { name: 'x' }, item: [{ request: { body: { raw: '{"openapi":"3.0.0"}' } } }] }))).toBe(false)
    expect(looksLikeOpenApi('curl https://x')).toBe(false)
    expect(looksLikeOpenApi('  openapi: 3.0.0')).toBe(false) // indented: not a top-level key
  })
  it('pasted links to documents', () => {
    expect(specUrlOf(' https://api.example.com/openapi.json ')).toBe('https://api.example.com/openapi.json')
    expect(specUrlOf('https://petstore.example.com/v2/swagger.yaml?x=1')).toBe('https://petstore.example.com/v2/swagger.yaml?x=1')
    expect(specUrlOf('https://example.com/api-docs')).toBe('https://example.com/api-docs')
    expect(specUrlOf('https://example.com/users')).toBeNull()
    expect(specUrlOf('curl https://example.com/openapi.json')).toBeNull()
  })
})

describe('Import dialog: OpenAPI', () => {
  afterEach(() => cleanup())

  async function setup() {
    const mock = createMockBackend({ latencyMs: 0, seed: false })
    window.slinger = mock
    await app.init()
    toast.clear()
    const onclose = vi.fn()
    render(ImportDialog, { open: true, onclose })
    return { mock, onclose }
  }

  it('a YAML file is read, previewed with its options, and imported as a linked collection that opens', async () => {
    const { mock, onclose } = await setup()
    const input = screen.getByLabelText('Import file') as HTMLInputElement
    Object.defineProperty(input, 'files', { value: [new File([SHOP], 'shop.yaml', { type: 'application/yaml' })], configurable: true })
    await fireEvent.change(input)
    const preview = await screen.findByTestId('openapi-preview')
    expect(preview).toHaveTextContent('OpenAPI 3.0')
    expect(preview).toHaveTextContent('Shop API · version 1.4.0')
    expect(screen.getByTestId('openapi-operations')).toHaveTextContent('7 requests')
    expect(screen.getByTestId('openapi-tags')).toHaveTextContent('pets (5), orders (1), 1 untagged')
    await fireEvent.change(screen.getByLabelText('Folders'), { target: { value: 'paths' } })
    await fireEvent.input(screen.getByLabelText('Collection name'), { target: { value: 'Shop' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Import API' }))
    await waitFor(() => expect(onclose).toHaveBeenCalled())
    const col = app.collections.find((c) => c.name === 'Shop')!
    expect(app.foldersOf(col.id).map((f) => f.name).sort()).toEqual(['health', 'orders', 'pets'])
    expect(app.requestsOf(col.id)).toHaveLength(7)
    expect(await mock.getOpenApiLink(col.id)).toMatchObject({ sourceKind: 'file', source: 'shop.yaml', folders: 'paths', title: 'Shop API' })
    expect(tabsStore.active?.overview).toEqual({ kind: 'collection', id: col.id })
  })

  it('pasted JSON (Swagger 2.0) is recognised; a broken document shows why', async () => {
    await setup()
    const area = screen.getByLabelText(/Or paste JSON/) as HTMLTextAreaElement
    area.value = SWAGGER
    await fireEvent.input(area)
    await fireEvent.blur(area)
    expect(await screen.findByTestId('openapi-preview')).toHaveTextContent('Swagger 2.0')
    area.value = 'openapi: 3.0.0\ninfo: {title: x}\npaths: {}'
    await fireEvent.input(area)
    await fireEvent.blur(area)
    await waitFor(() => expect(screen.queryByTestId('openapi-preview')).toBeNull())
    expect(await screen.findByRole('alert')).toHaveTextContent('The document has no paths')
  })

  it('a URL is fetched by the backend; failures are shown', async () => {
    await setup()
    await fireEvent.input(screen.getByLabelText(/OpenAPI document from a URL/), { target: { value: 'https://api.example.com/openapi.yaml' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Load' }))
    // The browser mock has no network: main's error path.
    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not download the document/)
  })
})
