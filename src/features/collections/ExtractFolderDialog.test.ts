import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../app/state.svelte'
import { toast } from '../../app/toast.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import { parseScriptsJson, runnableCode } from '../../lib/scripts'
import ExtractFolderDialog from './ExtractFolderDialog.svelte'

const scripts = (code: string) => JSON.stringify([{ listen: 'prerequest', script: { type: 'text/javascript', exec: [code] } }])
let mock: ReturnType<typeof createMockBackend>
let ids: { col: string; drive: string; sub: string; create: string; get: string }

beforeEach(async () => {
  localStorage.clear()
  toast.items = []
  mock = createMockBackend({ latencyMs: 0, seed: false })
  window.slinger = mock
  window.__slingerMock = mock
  await app.init()
  const ws = app.workspaceId!
  const col = await mock.createCollection(ws, 'Big')
  await mock.setCollectionScripts(col.id, scripts('collectionScript()'))
  await mock.replaceCollectionVariables(col.id, [{ key: 'baseUrl', value: 'https://api.test', enabled: true }])
  const drive = await mock.createFolder({ workspaceId: ws, collectionId: col.id, name: 'Drive Automation' })
  await mock.setFolderScripts(drive.id, scripts('folderScript()'))
  const sub = await mock.createFolder({ workspaceId: ws, collectionId: col.id, parentFolderId: drive.id, name: 'Customers' })
  const req = (name: string, folderId: string) => mock.createRequest({ workspaceId: ws, collectionId: col.id, folderId, name, method: 'GET', url: 'https://x', documentJson: '{}' })
  const create = await req('Create Customer', drive.id)
  const get = await req('Get Customer', sub.id)
  await app.reloadCollections()
  ids = { col: col.id, drive: drive.id, sub: sub.id, create: create.id, get: get.id }
})
afterEach(cleanup)

describe('ExtractFolderDialog', () => {
  it('explains what happens, extracts with the variables and the inherited scripts, and reports it', async () => {
    const onclose = vi.fn()
    const ondone = vi.fn()
    render(ExtractFolderDialog, { folderId: ids.drive, onclose, ondone })
    expect(screen.getByTestId('extract-summary')).toHaveTextContent('"Drive Automation" becomes a collection of its own with its 2 requests and 1 subfolder, and leaves "Big".')
    expect(screen.getByLabelText('Collection name')).toHaveValue('Drive Automation')
    expect(screen.getByRole('checkbox', { name: 'Copy the collection variables of "Big" (1)' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: "Keep the scripts that ran before this folder's" })).toBeChecked()

    await fireEvent.click(screen.getByRole('button', { name: 'Extract' }))
    await waitFor(() => expect(onclose).toHaveBeenCalled())
    const created = app.collections.find((c) => c.name === 'Drive Automation')!
    expect(ondone).toHaveBeenCalledWith(created.id)
    expect(app.requestsOf(created.id).map((r) => r.id).sort()).toEqual([ids.create, ids.get].sort())
    expect(app.foldersOf(created.id).map((f) => f.name)).toEqual(['Customers'])
    expect(app.foldersOf(ids.col)).toEqual([])
    expect(app.collectionVariables[created.id]?.map((v) => v.key)).toEqual(['baseUrl'])
    expect(runnableCode(parseScriptsJson(created.scriptsJson), 'prerequest')).toBe(
      '// ---- From collection "Big" ----\ncollectionScript()\n\n// ---- From folder "Drive Automation" ----\nfolderScript()',
    )
    expect(toast.items.map((t) => [t.title, t.detail])).toEqual([['"Drive Automation" is now a collection', '2 requests moved out of "Big".']])
  })

  it('unticked options: a new name, no variables, only the folder\'s own scripts', async () => {
    render(ExtractFolderDialog, { folderId: ids.drive, onclose: () => {} })
    await fireEvent.input(screen.getByLabelText('Collection name'), { target: { value: 'Drive' } })
    await fireEvent.click(screen.getByRole('checkbox', { name: /Copy the collection variables/ }))
    await fireEvent.click(screen.getByRole('checkbox', { name: /Keep the scripts/ }))
    await fireEvent.click(screen.getByRole('button', { name: 'Extract' }))
    await waitFor(() => expect(app.collections.some((c) => c.name === 'Drive')).toBe(true))
    const created = app.collections.find((c) => c.name === 'Drive')!
    expect(app.collectionVariables[created.id] ?? []).toEqual([])
    expect(runnableCode(parseScriptsJson(created.scriptsJson), 'prerequest')).toBe('folderScript()')
  })

  it('an empty name cannot be submitted; options without anything to copy are not offered', async () => {
    render(ExtractFolderDialog, { folderId: ids.sub, onclose: () => {} })
    // "Customers" inherits the collection's and "Drive Automation"'s scripts.
    expect(screen.getByRole('checkbox', { name: /Keep the scripts/ })).toBeInTheDocument()
    await fireEvent.input(screen.getByLabelText('Collection name'), { target: { value: '  ' } })
    expect(screen.getByRole('button', { name: 'Extract' })).toBeDisabled()
    cleanup()
    const plain = await mock.createCollection(app.workspaceId!, 'Plain')
    const f = await mock.createFolder({ workspaceId: app.workspaceId!, collectionId: plain.id, name: 'F' })
    await app.reloadCollections()
    render(ExtractFolderDialog, { folderId: f.id, onclose: () => {} })
    expect(screen.queryByRole('checkbox')).toBeNull()
  })
})
