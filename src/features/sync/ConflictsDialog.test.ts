import { cleanup, render, screen, waitFor, within } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../app/state.svelte'
import { ui } from '../../app/ui.svelte'
import ConflictsDialog from './ConflictsDialog.svelte'
import { sync } from './syncStore.svelte'
import { flush, selectWorkspaceByName, setupSync, signInMock, teardownSync, type Backend } from './testUtils'

let b: Backend
let ws: string

async function openWithScenario() {
  const out = await b.cloud.scenario('conflicts')
  ws = await selectWorkspaceByName('Personal')
  await sync.refreshStatuses()
  ui.conflictsOpen = true
  render(ConflictsDialog)
  await screen.findByText('6 open')
  return out
}
const listItem = (name: RegExp | string) => screen.getByRole('button', { name })

beforeEach(async () => {
  b = await setupSync()
})
afterEach(() => {
  cleanup()
  teardownSync()
})

describe('ConflictsDialog', () => {
  it('groups conflicts by kind and shows the first one with a side-by-side diff', async () => {
    await openWithScenario()
    for (const title of [/Changed in both places \(2\)/, /Deleted in the cloud \(1\)/, /Deleted here \(1\)/, /Version number clash \(1\)/, /Rejected by the cloud \(1\)/]) {
      expect(screen.getByRole('heading', { name: title })).toBeInTheDocument()
    }
    // duplicate_key is informational and hidden until "Show resolved"
    expect(screen.queryByRole('heading', { name: /Renamed automatically/ })).toBeNull()
    const card = screen.getByTestId('conflict-card')
    expect(within(card).getByRole('heading', { level: 3 }).textContent).toBe('Demo API (mine)')
    expect(within(card).getByLabelText('Location').textContent).toBe('Demo API (mine)')
  })

  it('shows mine vs cloud for a request and highlights only the differing field', async () => {
    const user = userEvent.setup()
    await openWithScenario()
    await user.click(listItem(/^Get user/))
    const card = await screen.findByLabelText(/Get user/, { selector: 'article' })
    const rows = within(card).getAllByTestId('diff-row')
    const changed = rows.filter((r) => r.dataset.changed)
    expect(changed).toHaveLength(1)
    expect(changed[0].textContent).toContain('https://mine.example.test/users/{{userId}}')
    expect(changed[0].textContent).toContain('https://theirs.example.test/users/{{userId}}')
    expect(within(card).getByRole('button', { name: 'Keep mine' })).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: 'Use cloud version' })).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: 'Keep both' })).toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: /Choose per part/ })).toBeNull() // one conflicting group only
  })

  it('resolves keep mine: sends the payload, updates the list and the status, moves focus on', async () => {
    const user = userEvent.setup()
    await openWithScenario()
    const calls = b.calls
    await user.click(listItem(/^Get user/))
    await user.click(within(await screen.findByTestId('conflict-card')).getByRole('button', { name: 'Keep mine' }))
    await waitFor(() => expect(screen.getByText('5 open')).toBeInTheDocument())
    const resolve = calls.filter((c) => c.method === 'resolveSyncConflict').at(-1)!
    expect(resolve.args[0]).toMatchObject({ resolution: 'keep_local' })
    expect(resolve.args[0]).not.toHaveProperty('fieldChoices')
    expect(sync.current?.openConflicts).toBe(5)
    expect(screen.queryByRole('button', { name: /^Get user/ })).toBeNull()
    await waitFor(() => expect(document.activeElement?.hasAttribute('data-cid')).toBe(true))
  })

  it('is keyboard operable: arrows move through the list in visual order, Space selects', async () => {
    const user = userEvent.setup()
    await openWithScenario()
    const first = listItem(/^Demo API \(mine\)/)
    first.focus()
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(listItem(/^Get user/))
    expect(document.activeElement?.getAttribute('aria-current')).toBe('true')
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(listItem(/^Create user/))
    await user.keyboard('{End}')
    expect(document.activeElement).toBe(listItem(/^Basic auth check/))
    await user.keyboard('{Home}')
    expect(document.activeElement).toBe(first)
    await user.keyboard(' ')
    expect(screen.getByLabelText('Select Demo API (mine)')).toBeChecked()
    expect(screen.getByText('1 selected')).toBeInTheDocument()
    // Tab reaches the resolution buttons of the focused conflict
    await user.tab()
    await user.tab()
    expect(document.activeElement?.closest('[role=group]')?.getAttribute('aria-label')).toMatch(/Resolve this conflict|Conflicts by kind|Bulk/)
  })

  it('bulk: keep cloud for everything selected asks first, applies to all allowed ones', async () => {
    const user = userEvent.setup()
    await openWithScenario()
    await user.click(screen.getByLabelText('All'))
    expect(screen.getByText('6 selected')).toBeInTheDocument()
    await user.click(within(screen.getByRole('group', { name: 'Bulk actions' })).getByRole('button', { name: 'Use cloud' }))
    const confirm = await screen.findByRole('dialog', { name: /Resolve 6 conflicts/ })
    expect(confirm.textContent).toContain('CLOUD version for 6 conflicts')
    await user.click(within(confirm).getByRole('button', { name: 'Use cloud version' }))
    await waitFor(() => expect(screen.getByTestId('no-conflicts')).toBeInTheDocument())
    expect(sync.current?.openConflicts).toBe(0)
  })

  it('bulk keep mine skips conflicts that do not allow it and says so', async () => {
    const user = userEvent.setup()
    await openWithScenario()
    await user.click(screen.getByLabelText('All'))
    await user.click(within(screen.getByRole('group', { name: 'Bulk actions' })).getByRole('button', { name: 'Keep mine' }))
    const confirm = await screen.findByRole('dialog', { name: /Resolve 4 conflicts/ })
    expect(confirm.textContent).toContain('2 selected conflicts cannot be resolved this way and will be skipped')
    await user.click(within(confirm).getByRole('button', { name: 'Keep mine' }))
    await waitFor(() => expect(screen.getByText('2 open')).toBeInTheDocument())
  })

  it('immutable clash: the copy needs a valid new version', async () => {
    const user = userEvent.setup()
    await openWithScenario()
    await user.click(listItem(/^Demo API v1\.0\.0/))
    const dup = await screen.findByRole('button', { name: 'Keep mine as a new version' })
    expect(dup).toBeDisabled()
    const input = screen.getByLabelText(/New version number/)
    await user.type(input, 'nope')
    expect(dup).toBeDisabled()
    expect(screen.getByLabelText(/New version number/)).toHaveAttribute('aria-invalid', 'true')
    await user.clear(input)
    await user.type(input, '1.0.1')
    expect(dup).toBeEnabled()
    await user.click(dup)
    await waitFor(() => expect(b.calls.some((c) => c.method === 'resolveSyncConflict' && (c.args[0] as { newVersion?: string }).newVersion === '1.0.1')).toBe(true))
  })

  it('shows the server error inline and keeps the conflict', async () => {
    const user = userEvent.setup()
    await openWithScenario()
    await user.click(listItem(/^Get user/))
    b.failNext('resolveSyncConflict', { code: 'internal_error', message: 'The cloud said no' })
    await user.click(within(await screen.findByTestId('conflict-card')).getByRole('button', { name: 'Keep mine' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The cloud said no')
    expect(screen.getByText('6 open')).toBeInTheDocument()
  })

  it('remote_deleted offers restore / delete-here with danger styling and explanations', async () => {
    const user = userEvent.setup()
    await openWithScenario()
    await user.click(listItem(/^Create user/))
    expect(await screen.findByRole('button', { name: 'Restore in the cloud' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete here too' })).toBeInTheDocument()
    expect(screen.getAllByText(/deleted/i).length).toBeGreaterThan(0)
  })

  it('show resolved lists informational conflicts without actions', async () => {
    const user = userEvent.setup()
    await openWithScenario()
    await user.click(screen.getByLabelText('Show resolved'))
    await user.click(await screen.findByRole('button', { name: /^baseUrl/ }))
    const card = await screen.findByTestId('conflict-card')
    expect(within(card).getByRole('status')).toHaveTextContent('Resolved automatically')
    expect(within(card).queryByRole('group', { name: 'Resolve this conflict' })).toBeNull()
  })

  it('empty state', async () => {
    ws = app.workspaceId!
    await signInMock(b)
    await sync.publish(ws)
    await b.cloud.runCycle(ws)
    ui.conflictsOpen = true
    render(ConflictsDialog)
    expect(await screen.findByTestId('no-conflicts')).toBeInTheDocument()
    expect(screen.getByText('Nothing to resolve.')).toBeInTheDocument()
  })
})

describe('merge per group', () => {
  it('needs a choice for every conflicting part, then sends fieldChoices', async () => {
    const user = userEvent.setup()
    ws = app.workspaceId!
    await signInMock(b)
    await sync.publish(ws)
    await b.cloud.runCycle(ws)
    const rid = (await b.getSyncStatus(ws)).remoteWorkspaceId!
    const col = app.collections.find((c) => c.name === 'Demo API')!
    const folders = await b.listFolders(col.id)
    const users = folders.find((f) => f.name === 'Users')!
    await b.renameFolder(users.id, 'Users (mine)')
    await b.moveFolder({ folderId: users.id, targetParentFolderId: folders.find((f) => f.name === 'Auth')!.id, targetIndex: 0 })
    b.cloud.remoteEdit(rid, 'folder', users.id, { name: 'Users (theirs)', parent_folder_id: folders.find((f) => f.name === 'Files')!.id })
    await b.syncNow(ws)
    await flush()
    await sync.refreshStatuses()
    ui.conflictsOpen = true
    render(ConflictsDialog)
    const start = await screen.findByRole('button', { name: 'Choose per part…' })
    await user.click(start)
    const apply = screen.getByRole('button', { name: 'Apply choices' })
    expect(apply).toBeDisabled()
    const groups = screen.getAllByRole('group').filter((g) => g.tagName === 'FIELDSET')
    expect(groups).toHaveLength(2)
    await user.click(within(groups[0]).getByRole('radio', { name: 'Keep cloud' }))
    expect(apply).toBeDisabled()
    await user.click(within(groups[1]).getByRole('radio', { name: 'Keep mine' }))
    expect(apply).toBeEnabled()
    await user.click(apply)
    await waitFor(() => expect(b.calls.some((c) => c.method === 'resolveSyncConflict')).toBe(true))
    const call = b.calls.filter((c) => c.method === 'resolveSyncConflict').at(-1)!.args[0] as { resolution: string; fieldChoices: Record<string, string> }
    expect(call.resolution).toBe('merge')
    expect(Object.values(call.fieldChoices).sort()).toEqual(['local', 'remote'])
  })
})
