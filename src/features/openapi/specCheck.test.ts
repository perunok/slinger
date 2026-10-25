/**
 * Checking responses against a linked OpenAPI document in the renderer: the Spec chip of the response pane, the link
 * cache, and the runner option. The mock backend runs the same validation engine as main.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OpenApiValidation } from '../../../shared/types'
import { app } from '../../app/state.svelte'
import { toast } from '../../app/toast.svelte'
import { ui } from '../../app/ui.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import { tabsStore } from '../requests/tabs.svelte'
import ResponsePane from '../response/ResponsePane.svelte'
import RunnerDialog from '../runner/RunnerDialog.svelte'
import { runsStore } from '../runner/runs.svelte'
import { invalidateOpenApiLink, openapiStore, specTestResult } from './openapiStore.svelte'
import SpecChip from './SpecChip.svelte'

/** The mock's canned /json answers { id: 1, name: 'Slinger mock', ... }; `nameType` decides whether it matches. */
const SPEC = (nameType: string) => `openapi: 3.0.3
info: { title: Mock API, version: '1' }
servers: [ { url: 'https://mock.slinger.local' } ]
paths:
  /json:
    get:
      summary: Get JSON
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
                required: [id, name]
                properties: { id: { type: integer }, name: { type: ${nameType} } }
  /404:
    get:
      summary: Missing
      responses:
        '200': { description: OK }
`

let mock: ReturnType<typeof createMockBackend>

beforeEach(async () => {
  mock = createMockBackend({ latencyMs: 0, seed: false })
  window.slinger = mock
  window.__slingerMock = mock
  tabsStore.tabs = []
  tabsStore.activeId = null
  ui.runner = null
  for (const s of runsStore.sessions) runsStore.dismiss(s)
  toast.items = []
  invalidateOpenApiLink()
  await app.init()
})
afterEach(cleanup)

async function importSpec(nameType = 'string') {
  const r = await mock.importOpenApi({ workspaceId: app.workspaceId!, text: SPEC(nameType), source: { kind: 'text', value: null }, folders: 'none' })
  await app.reloadCollections()
  return r
}

describe('Spec chip', () => {
  it('says "Matches spec" after a send whose response fits the document', async () => {
    const r = await importSpec('string')
    const tab = tabsStore.openRequest(r.requests.find((x) => x.name === 'Get JSON')!)
    render(ResponsePane, { tab })
    await tabsStore.send(tab)
    const chip = await screen.findByTestId('spec-chip', {}, { timeout: 3000 })
    expect(chip).toHaveTextContent('Matches spec')
    expect(chip).toHaveAttribute('data-status', 'valid')
    expect(mock.calls.filter((c) => c.method === 'validateOpenApiResponse')).toHaveLength(1)
  })

  it('counts errors and lists them with the operation checked', async () => {
    const r = await importSpec('integer')
    const tab = tabsStore.openRequest(r.requests.find((x) => x.name === 'Get JSON')!)
    render(ResponsePane, { tab })
    await tabsStore.send(tab)
    const chip = await screen.findByTestId('spec-chip', {}, { timeout: 3000 })
    expect(chip).toHaveTextContent('1 spec error')
    await fireEvent.click(chip)
    const list = screen.getByRole('region', { name: 'Spec errors' })
    expect(list).toHaveTextContent('Checked against GET /json → 200')
    expect(list).toHaveTextContent('$.name expected integer, got string')
    await fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('region', { name: 'Spec errors' })).toBeNull()
  })

  it('stays hidden without a linked document; the link cache follows invalidation', async () => {
    const col = await mock.createCollection(app.workspaceId!, 'Plain')
    expect(await openapiStore.ensure(col.id)).toBeNull()
    expect(openapiStore.links[col.id]).toBeNull()
    const r = await importSpec()
    expect(await openapiStore.ensure(r.collection.id)).toMatchObject({ title: 'Mock API' })
    await mock.unlinkOpenApi(r.collection.id)
    expect(await openapiStore.ensure(r.collection.id)).not.toBeNull() // cached
    invalidateOpenApiLink(r.collection.id)
    expect(await openapiStore.ensure(r.collection.id)).toBeNull()
    const tab = tabsStore.openRequest(r.requests.find((x) => x.name === 'Get JSON')!)
    render(ResponsePane, { tab })
    await tabsStore.send(tab)
    await new Promise((res) => setTimeout(res, 300))
    expect(screen.queryByTestId('spec-chip')).toBeNull()
    expect(mock.calls.some((c) => c.method === 'validateOpenApiResponse')).toBe(false)
  })

  it('renders each result state', async () => {
    const base: OpenApiValidation = { status: 'no-operation', operation: null, responseKey: null, errors: [] }
    const { rerender } = render(SpecChip, { result: base })
    expect(screen.queryByTestId('spec-chip')).toBeNull()
    await rerender({ result: { ...base, status: 'no-schema', operation: 'DELETE /x', responseKey: '204' } })
    expect(screen.getByTestId('spec-chip')).toHaveTextContent('No schema in spec')
    await rerender({ result: { status: 'not-json', operation: 'GET /x', responseKey: '200', errors: [{ path: '$', message: 'Expected a JSON body: the body is empty' }] } })
    expect(screen.getByTestId('spec-chip')).toHaveTextContent('1 spec error')
  })
})

describe('runner option', () => {
  it('is offered (on) for a linked collection and adds a spec test per request with an operation', async () => {
    const r = await importSpec('integer')
    ui.runner = { collectionId: r.collection.id, folderId: null }
    render(RunnerDialog)
    const box = await screen.findByRole('checkbox', { name: 'Check responses against the OpenAPI spec' })
    expect(box).toBeChecked()
    await fireEvent.click(screen.getByRole('button', { name: 'Run 2 requests' }))
    const summary = await screen.findByTestId('summary', {}, { timeout: 3000 })
    expect(summary).toHaveTextContent('2 failed')
    const session = runsStore.forTarget({ collectionId: r.collection.id, folderId: null })!
    const [json, missing] = session.state.rows
    expect(json!.tests).toEqual([{ name: 'Response matches the OpenAPI spec', status: 'failed', error: '$.name: expected integer, got string', source: 'OpenAPI · GET /json 200' }])
    expect(json!.reason).toBe('1 of 1 test failed')
    expect(missing!.tests[0]).toMatchObject({ status: 'failed', error: 'Status 404 is not documented for GET /404 (documented: 200)' })
    expect(session.options.checkOpenApi).toBe(true)
  })

  it('runs without the check when unticked, and is not offered without a link', async () => {
    const r = await importSpec('integer')
    ui.runner = { collectionId: r.collection.id, folderId: null }
    render(RunnerDialog)
    await fireEvent.click(await screen.findByRole('checkbox', { name: 'Check responses against the OpenAPI spec' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Run 2 requests' }))
    await screen.findByTestId('summary', {}, { timeout: 3000 })
    const rows = within(screen.getByRole('list', { name: 'Run results' })).getAllByRole('listitem')
    expect(rows[0]).toHaveAttribute('data-status', 'passed')
    cleanup()
    ui.runner = null
    const col = await mock.createCollection(app.workspaceId!, 'Plain')
    await app.reloadCollections()
    ui.runner = { collectionId: col.id, folderId: null }
    render(RunnerDialog)
    await waitFor(() => expect(openapiStore.links[col.id]).toBeNull())
    expect(screen.queryByRole('checkbox', { name: 'Check responses against the OpenAPI spec' })).toBeNull()
  })

  it('turns a check into a test result (first 5 errors)', () => {
    expect(specTestResult(null)).toBeNull()
    expect(specTestResult({ status: 'no-operation', operation: null, responseKey: null, errors: [] })).toBeNull()
    expect(specTestResult({ status: 'valid', operation: 'GET /a', responseKey: '200', errors: [] })).toMatchObject({ status: 'passed', error: null })
    const errors = Array.from({ length: 7 }, (_, i) => ({ path: `$.a${i}`, message: 'bad' }))
    expect(specTestResult({ status: 'invalid', operation: 'GET /a', responseKey: '200', errors })!.error).toBe('$.a0: bad; $.a1: bad; $.a2: bad; $.a3: bad; $.a4: bad (and 2 more)')
  })
})
