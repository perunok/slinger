import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../app/state.svelte'
import { toast } from '../../app/toast.svelte'
import { ui } from '../../app/ui.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import ExportCollectionDialog from './ExportCollectionDialog.svelte'

async function setup() {
  const mock = createMockBackend({ latencyMs: 0, seed: false })
  window.slinger = mock
  await app.init()
  toast.clear()
  const ws = app.workspaceId!
  const col = await mock.createCollection(ws, 'My Demo API')
  const f = await mock.createFolder({ workspaceId: ws, collectionId: col.id, name: 'Users' })
  await mock.createRequest({ workspaceId: ws, collectionId: col.id, folderId: f.id, name: 'List users', method: 'GET', url: 'https://x.test/users', documentJson: '{}' })
  await mock.createRequest({ workspaceId: ws, collectionId: col.id, name: 'Health', method: 'GET', url: 'https://x.test/health', documentJson: '{}' })
  await app.reloadCollections()
  ui.exportCollectionId = col.id
  render(ExportCollectionDialog)
  return mock
}

beforeEach(() => {
  ui.exportCollectionId = null
})

describe('ExportCollectionDialog', () => {
  it('previews Postman v2.1 JSON and warns about unsaved tabs', async () => {
    await setup()
    const pre = await screen.findByLabelText('Export preview')
    expect(pre.textContent).toContain('"name": "My Demo API"')
    expect(pre.textContent).toContain('collection/v2.1.0')
    expect(screen.getByText(/1 folder, 2 requests/)).toBeInTheDocument()
    expect(screen.getByText(/Unsaved edits in open tabs are not included/)).toBeInTheDocument()
  })

  it('saves to a slugified file name and closes', async () => {
    const mock = await setup()
    await fireEvent.click(await screen.findByRole('button', { name: 'Save to file' }))
    await waitFor(() => expect(ui.exportCollectionId).toBeNull())
    const call = mock.calls.find((c) => c.method === 'writeExportFile')!
    expect(mock.calls.find((c) => c.method === 'defaultExportPath')!.args[0]).toBe('my-demo-api.postman_collection.json')
    expect(call.args[0]).toBe('my-demo-api.postman_collection.json')
    const json = JSON.parse(call.args[1] as string)
    expect(json.info.name).toBe('My Demo API')
    expect(json.item.map((i: { name: string }) => i.name)).toEqual(['Users', 'Health'])
    expect(json.item[0].item[0].name).toBe('List users')
    expect(toast.items.some((t) => t.kind === 'success' && t.detail?.includes('my-demo-api'))).toBe(true)
  })

  it('shows write errors inline and stays open', async () => {
    const mock = await setup()
    mock.failNext('writeExportFile', { code: 'io_error', message: 'Permission denied' })
    await fireEvent.click(await screen.findByRole('button', { name: 'Save to file' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Permission denied')
    expect(ui.exportCollectionId).not.toBeNull()
  })

  it('copies to the clipboard', async () => {
    await setup()
    const writeText = vi.fn(async (_text: string) => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await fireEvent.click(await screen.findByRole('button', { name: 'Copy to clipboard' }))
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(JSON.parse(writeText.mock.calls[0][0]).info.name).toBe('My Demo API')
  })
})
