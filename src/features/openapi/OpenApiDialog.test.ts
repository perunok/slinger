import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../app/state.svelte'
import { ui } from '../../app/ui.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import { sync } from '../sync/syncStore.svelte'
import OpenApiDialog from './OpenApiDialog.svelte'
import { applySummary, defaultChoices, reviewGroups } from './review'

const V1 = `openapi: 3.0.3
info: { title: Pet API, version: 1.0.0 }
servers: [{ url: https://pets.example.com/v1 }]
tags: [{ name: pets }]
paths:
  /pets:
    get:
      tags: [pets]
      summary: List pets
      responses:
        '200': { description: OK, content: { application/json: { example: [{ id: 1 }] } } }
  /pets/{id}:
    get:
      tags: [pets]
      summary: Get a pet
      parameters: [{ name: id, in: path, required: true, schema: { type: integer } }]
      responses:
        '200': { description: OK, content: { application/json: { example: { id: 1 } } } }
    delete:
      tags: [pets]
      summary: Delete a pet
      parameters: [{ name: id, in: path, required: true, schema: { type: integer } }]
      responses:
        '204': { description: Deleted }
`
// v2: the list gains a query parameter, delete is gone, a stock operation (new tag) is added, a new server.
const V2 = V1.replace('version: 1.0.0', 'version: 2.0.0')
  .replace('https://pets.example.com/v1', 'https://pets.example.com/v2')
  .replace("      summary: List pets\n", "      summary: List pets\n      parameters: [{ name: page, in: query, required: true, schema: { type: integer }, example: 1 }]\n")
  .replace(/ {4}delete:\n(?: {6}.*\n)+/, '')
  .concat(`  /stock:
    get:
      tags: [stock]
      summary: Stock levels
      responses:
        '200': { description: OK, content: { application/json: { example: { count: 3 } } } }
`)

async function setup(linked = true) {
  const mock = createMockBackend({ latencyMs: 0, seed: false })
  window.slinger = mock
  await app.init()
  const ws = app.workspaceId!
  let collectionId: string
  if (linked) {
    collectionId = (await mock.importOpenApi({ workspaceId: ws, text: V1, source: { kind: 'text', value: null }, folders: 'tags' })).collection.id
  } else {
    collectionId = (await mock.createCollection(ws, 'Hand made')).id
    await mock.createRequest({ workspaceId: ws, collectionId, name: 'One pet', method: 'GET', url: '{{baseUrl}}/pets/:petId', documentJson: '{}' })
  }
  await app.reloadCollections()
  ui.openApiFor = collectionId
  render(OpenApiDialog)
  return { mock, collectionId }
}

const choice = (key: string) => screen.getByLabelText(`Choice for ${key}`) as HTMLSelectElement

beforeEach(() => {
  ui.openApiFor = null
  ui.exportCollectionId = null
  sync.statuses = {}
})
afterEach(() => {
  sync.statuses = {}
})

describe('OpenApiDialog', () => {
  it('shows the link and updates the collection from a pasted new version', async () => {
    const { mock, collectionId } = await setup()
    const info = await screen.findByTestId('openapi-link')
    expect(info).toHaveTextContent('Pet API')
    expect(info).toHaveTextContent('Pasted text')
    expect(info).toHaveTextContent('3') // operations

    // A pasted document cannot be re-read: the dialog asks for the new version.
    await fireEvent.click(screen.getByRole('button', { name: 'Update from source' }))
    expect(screen.getByRole('radio', { name: 'Paste' })).toBeChecked()
    expect(screen.getByRole('button', { name: 'Review changes' })).toBeDisabled()
    await fireEvent.input(screen.getByLabelText('Document text'), { target: { value: V2 } })
    await fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))

    expect(await screen.findByRole('heading', { name: 'Added (1)' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Changed (1)' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Removed (1)' })).toBeInTheDocument()
    expect(within(screen.getByTestId('openapi-notes')).getByText('New folder: stock')).toBeInTheDocument()
    expect(screen.getByTestId('openapi-notes')).toHaveTextContent('Server URL: https://pets.example.com/v1 -> https://pets.example.com/v2')
    expect(choice('GET /stock').value).toBe('apply')
    expect(choice('GET /pets').value).toBe('apply')
    expect(choice('DELETE /pets/{id}').value).toBe('keep')
    expect(screen.getByTestId('openapi-apply-summary')).toHaveTextContent('1 to add, 1 to update; 1 unchanged.')
    await fireEvent.change(choice('DELETE /pets/{id}'), { target: { value: 'delete' } })
    expect(screen.getByTestId('openapi-apply-summary')).toHaveTextContent('1 to add, 1 to update, 1 to delete')

    await fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    const result = await screen.findByTestId('openapi-result')
    expect(result).toHaveTextContent('Collection updated from Pet API v2.0.0')
    expect(result).toHaveTextContent('1 added, 1 updated, 1 deleted, 0 kept.')
    expect(result).toHaveTextContent('saved as version 0.0.1')
    await waitFor(() => expect(app.requestsOf(collectionId).map((r) => r.name).sort()).toEqual(['Get a pet', 'List pets', 'Stock levels']))
    expect(app.requestsOf(collectionId).find((r) => r.name === 'List pets')!.url).toBe('{{baseUrl}}/pets?page=1')
    expect(app.foldersOf(collectionId).map((f) => f.name)).toEqual(['pets', 'stock'])
    expect((await mock.getOpenApiLink(collectionId))?.specVersion).toBe('2.0.0')
    await fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(ui.openApiFor).toBeNull()
  })

  it('links a hand-made collection and reviews the match by method and path', async () => {
    const { mock, collectionId } = await setup(false)
    expect(await screen.findByText('This collection is not linked to an OpenAPI document.')).toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'Link a spec…' }))
    await fireEvent.click(screen.getByRole('radio', { name: 'Paste' }))
    await fireEvent.input(screen.getByLabelText('Document text'), { target: { value: V1 } })
    await fireEvent.click(screen.getByRole('button', { name: 'Link and review' }))

    expect(await screen.findByRole('heading', { name: 'Changed here and in the spec (1)' })).toBeInTheDocument()
    expect(choice('GET /pets/{id}').value).toBe('keep')
    expect(within(choice('GET /pets/{id}')).getByRole('option', { name: 'Take spec' })).toBeInTheDocument()
    expect(screen.getByText('One pet')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Added (2)' })).toBeInTheDocument()
    expect(await mock.getOpenApiLink(collectionId)).toMatchObject({ title: 'Pet API', sourceKind: 'text' })

    await fireEvent.change(choice('GET /pets/{id}'), { target: { value: 'apply' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(await screen.findByTestId('openapi-result')).toHaveTextContent('2 added, 1 updated, 0 deleted, 0 kept.')
    await waitFor(() => expect(app.requestsOf(collectionId).find((r) => r.name === 'One pet')!.url).toBe('{{baseUrl}}/pets/:id'))
    const one = app.requestsOf(collectionId).find((r) => r.name === 'One pet')!
    expect(JSON.parse(one.documentJson).openapi).toMatchObject({ key: 'GET /pets/{id}' })
  })

  it('asks to review again when the collection changed after the review', async () => {
    const { mock, collectionId } = await setup()
    await screen.findByTestId('openapi-link')
    await fireEvent.click(screen.getByRole('button', { name: 'Update from source' }))
    await fireEvent.input(screen.getByLabelText('Document text'), { target: { value: V2 } })
    await fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    await screen.findByRole('heading', { name: 'Added (1)' })
    const r = app.requestsOf(collectionId)[0]!
    await mock.renameRequest(r.id, 'Renamed meanwhile')
    await fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The collection changed; review the update again')
    await fireEvent.click(screen.getByRole('button', { name: 'Review again' }))
    await waitFor(() => expect(mock.calls.filter((c) => c.method === 'planOpenApiUpdate')).toHaveLength(2))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled())
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Added (1)' })).toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(await screen.findByTestId('openapi-result')).toHaveTextContent('1 added, 1 updated')
  })

  it('read-only workspaces can review but not apply', async () => {
    const { mock } = await setup()
    sync.statuses = { [app.workspaceId!]: { ...(await mock.getSyncStatus(app.workspaceId!)), linked: true, readOnly: true, remoteName: 'Team' } }
    await screen.findByTestId('openapi-link')
    await fireEvent.click(screen.getByRole('button', { name: 'Update from source' }))
    await fireEvent.input(screen.getByLabelText('Document text'), { target: { value: V2 } })
    await fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    await screen.findByRole('heading', { name: 'Added (1)' })
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
    expect(screen.getByTestId('openapi-apply-summary')).toHaveTextContent('read-only')
  })

  it('unlinks after confirming, and opens the export dialog', async () => {
    const { mock, collectionId } = await setup()
    await screen.findByTestId('openapi-link')
    await fireEvent.click(screen.getByRole('button', { name: 'Unlink' }))
    const confirm = screen.getByRole('dialog', { name: 'Unlink the document?' })
    await fireEvent.click(within(confirm).getByRole('button', { name: 'Unlink' }))
    expect(await screen.findByText('This collection is not linked to an OpenAPI document.')).toBeInTheDocument()
    expect(await mock.getOpenApiLink(collectionId)).toBeNull()
    await fireEvent.click(screen.getByRole('button', { name: 'Export as OpenAPI…' }))
    expect(ui.openApiFor).toBeNull()
    expect(ui.exportCollectionId).toBe(collectionId)
  })

  it('reports a URL that cannot be fetched', async () => {
    await setup()
    await screen.findByTestId('openapi-link')
    await fireEvent.click(screen.getByRole('button', { name: 'Update from source' }))
    await fireEvent.click(screen.getByRole('radio', { name: 'From URL' }))
    await fireEvent.input(screen.getByPlaceholderText('https://api.example.com/openapi.yaml'), { target: { value: 'https://pets.example.com/openapi.yaml' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not download the document')
  })
})

describe('review helpers', () => {
  it('groups changes, defaults and summarises choices', () => {
    const base = { editedHere: false, name: 'x', requestId: null, folder: null, summary: '' }
    const plan = {
      planId: 'p', collectionId: 'c', title: 't', specVersion: '1', previousSpecVersion: null, notes: [], warnings: [], text: '', source: { kind: 'text' as const, value: null },
      changes: [
        { ...base, key: 'GET /a', kind: 'added' as const, defaultChoice: 'apply' as const },
        { ...base, key: 'GET /b', kind: 'changed' as const, editedHere: true, defaultChoice: 'keep' as const },
        { ...base, key: 'GET /c', kind: 'unchanged' as const, defaultChoice: 'keep' as const },
      ],
    }
    expect(reviewGroups(plan).map((g) => [g.id, g.changes.length])).toEqual([['added', 1], ['edited', 1]])
    expect(defaultChoices(plan)).toEqual({ 'GET /a': 'apply', 'GET /b': 'keep' })
    expect(applySummary(plan, { 'GET /b': 'apply' })).toBe('1 to add, 1 to update')
    expect(applySummary(plan, { 'GET /a': 'skip' })).toBe('No request changes')
  })
})
