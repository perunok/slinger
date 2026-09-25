import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../app/state.svelte'
import { toast } from '../../app/toast.svelte'
import { ui } from '../../app/ui.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import ExportCollectionDialog from './ExportCollectionDialog.svelte'

async function setup(versions: string[] = []) {
  const mock = createMockBackend({ latencyMs: 0, seed: false })
  window.slinger = mock
  await app.init()
  toast.clear()
  const ws = app.workspaceId!
  const col = await mock.createCollection(ws, 'My Demo API')
  const f = await mock.createFolder({ workspaceId: ws, collectionId: col.id, name: 'Users' })
  await mock.createRequest({ workspaceId: ws, collectionId: col.id, folderId: f.id, name: 'List users', method: 'GET', url: 'https://x.test/users', documentJson: '{}' })
  await mock.createRequest({ workspaceId: ws, collectionId: col.id, name: 'Health', method: 'GET', url: 'https://x.test/health', documentJson: '{}' })
  for (const version of versions) await mock.createCollectionVersion({ collectionId: col.id, version, notes: `notes ${version}` })
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

  const saveButton = async () => {
    const button = await screen.findByRole('button', { name: 'Save to file' })
    await waitFor(() => expect(button).toBeEnabled())
    return button
  }

  it('saves under the real collection name (no versions: no version suffix) and closes', async () => {
    const mock = await setup()
    expect(await screen.findByText(/no versions yet/)).toBeInTheDocument()
    await fireEvent.click(await saveButton())
    await waitFor(() => expect(ui.exportCollectionId).toBeNull())
    const call = mock.calls.find((c) => c.method === 'writeExportFile')!
    expect(mock.calls.find((c) => c.method === 'defaultExportPath')!.args[0]).toBe('My Demo API.slinger_collection.json')
    expect(call.args[0]).toBe('My Demo API.slinger_collection.json')
    const json = JSON.parse(call.args[1] as string)
    expect(json.info.name).toBe('My Demo API')
    expect(json.info.version).toBeUndefined()
    expect(json.info._slinger).toMatchObject({ formatVersion: 1, app: 'Slinger 0.0.0-dev', includesSnapshots: true, versions: [] })
    expect(json.item.map((i: { name: string }) => i.name)).toEqual(['Users', 'Health'])
    expect(json.item[0].item[0].name).toBe('List users')
    expect(toast.items.some((t) => t.kind === 'success' && t.detail?.includes('My Demo API.slinger_collection.json'))).toBe(true)
  })

  it('carries the version history with snapshots by default and names the file after the latest version', async () => {
    const mock = await setup(['1.0.0', '1.2.0', '1.10.0-rc.1'])
    await waitFor(() => expect(screen.getByTestId('export-file-name')).toHaveTextContent('My Demo API v1.10.0-rc.1.slinger_collection.json'))
    expect(await screen.findByText(/3 versions, latest/)).toBeInTheDocument()
    expect(screen.getByTestId('export-snapshot-size')).toHaveTextContent(/Snapshots add about \d/)
    await fireEvent.click(await saveButton())
    await waitFor(() => expect(ui.exportCollectionId).toBeNull())
    const call = mock.calls.find((c) => c.method === 'writeExportFile')!
    expect(call.args[0]).toBe('My Demo API v1.10.0-rc.1.slinger_collection.json')
    const json = JSON.parse(call.args[1] as string)
    expect(json.info.version).toBe('1.10.0-rc.1')
    expect(json.info._slinger.versions.map((v: { version: string }) => v.version)).toEqual(['1.0.0', '1.2.0', '1.10.0-rc.1'])
    expect(json.info._slinger.versions[0].notes).toBe('notes 1.0.0')
    expect(json.info._slinger.versions[0].snapshot.requests.map((r: { name: string }) => r.name).sort()).toEqual(['Health', 'List users'])
  })

  it('unticking "Include version history snapshots" keeps only the version list', async () => {
    const mock = await setup(['1.0.0'])
    await fireEvent.click(await screen.findByLabelText(/Include version history snapshots/))
    expect(screen.getByTestId('export-snapshot-size')).toHaveTextContent(/Only the version list/)
    await fireEvent.click(await saveButton())
    await waitFor(() => expect(ui.exportCollectionId).toBeNull())
    const json = JSON.parse(mock.calls.find((c) => c.method === 'writeExportFile')!.args[1] as string)
    expect(json.info._slinger.includesSnapshots).toBe(false)
    expect(json.info._slinger.versions).toHaveLength(1)
    expect(json.info._slinger.versions[0]).not.toHaveProperty('snapshot')
  })

  it('shows write errors inline and stays open', async () => {
    const mock = await setup()
    mock.failNext('writeExportFile', { code: 'io_error', message: 'Permission denied' })
    await fireEvent.click(await saveButton())
    expect(await screen.findByRole('alert')).toHaveTextContent('Permission denied')
    expect(ui.exportCollectionId).not.toBeNull()
  })

  it('copies to the clipboard', async () => {
    await setup()
    const writeText = vi.fn(async (_text: string) => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const button = await screen.findByRole('button', { name: 'Copy to clipboard' })
    await waitFor(() => expect(button).toBeEnabled())
    await fireEvent.click(button)
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(JSON.parse(writeText.mock.calls[0][0]).info.name).toBe('My Demo API')
  })
})
