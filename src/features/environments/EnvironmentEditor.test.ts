import { cleanup, render, screen, within } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../app/state.svelte'
import { ui } from '../../app/ui.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import EnvironmentEditor from './EnvironmentEditor.svelte'

const SECRET = 'sk_live_demo_123'
let backend: ReturnType<typeof createMockBackend>

/** Everything a user (or an attacker reading the DOM) could see: markup plus live input values. */
function domDump(): string {
  const values = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')].map((e) => e.value)
  return document.body.innerHTML + '\n' + values.join('\n')
}

async function localVars() {
  const local = app.environments.find((e) => e.name === 'Local')!
  return backend.listEnvironmentVariables(local.id)
}

beforeEach(async () => {
  localStorage.clear()
  backend = createMockBackend({ latencyMs: 0 })
  window.slinger = backend
  window.__slingerMock = backend
  await app.init()
  await app.setActiveEnvironment(app.environments.find((e) => e.name === 'Local')!.id)
  ui.envEditor = { open: true }
})
afterEach(() => {
  cleanup()
  ui.envEditor = { open: false }
})

const openEditor = async () => {
  render(EnvironmentEditor)
  await screen.findByLabelText('Variable name: baseUrl')
}
const status = () => screen.getByTestId('save-status')
const settled = () => vi.waitFor(() => expect(status()).toHaveTextContent('All changes saved'), { timeout: 3000 })

describe('EnvironmentEditor', () => {
  it('lists environments, marks the active one and shows the variables', async () => {
    await openEditor()
    const list = screen.getByRole('list', { name: 'Environments' })
    expect(within(list).getByText('Local')).toBeInTheDocument()
    expect(within(list).getByText('Staging')).toBeInTheDocument()
    expect(within(list).getByText('Active')).toBeInTheDocument()
    expect(screen.getByLabelText('Variable name: userId')).toBeInTheDocument()
    expect(status()).toHaveTextContent('All changes saved')
  })

  it('never puts secret plaintext in the DOM until Reveal, and removes it on Hide', async () => {
    const user = userEvent.setup()
    await openEditor()
    expect(domDump()).not.toContain(SECRET)
    const secret = screen.getByLabelText('Secret value: apiToken') as HTMLInputElement
    expect(secret.type).toBe('password')
    expect(secret.placeholder).toContain('(unchanged)')

    await user.click(screen.getByRole('button', { name: 'Reveal secret apiToken' }))
    await vi.waitFor(() => expect((screen.getByLabelText('Secret value: apiToken') as HTMLInputElement).value).toBe(SECRET))
    expect(domDump()).toContain(SECRET)

    await user.click(screen.getByRole('button', { name: 'Hide secret apiToken' }))
    expect(domDump()).not.toContain(SECRET)
    expect((screen.getByLabelText('Secret value: apiToken') as HTMLInputElement).value).toBe('')
  })

  it('keeps secrets out of bulk mode', async () => {
    const user = userEvent.setup()
    await openEditor()
    await user.click(screen.getByRole('button', { name: 'Bulk edit' }))
    const ta = screen.getByLabelText('Bulk edit variables') as HTMLTextAreaElement
    expect(ta.value).toContain('userId=42')
    expect(ta.value).not.toContain('apiToken')
    expect(domDump()).not.toContain(SECRET)
    expect(screen.getByTestId('bulk-secret-note')).toHaveTextContent('1 secret variable')
  })

  it('autosaves a new row once, then updates it (no duplicate create)', async () => {
    const user = userEvent.setup()
    await openEditor()
    const before = (await localVars()).length
    await user.type(screen.getByLabelText('Variable name (new)'), 'region')
    expect(status()).toHaveTextContent(/unsaved|Saving/)
    await settled()
    let vars = await localVars()
    expect(vars).toHaveLength(before + 1)
    expect(vars.find((v) => v.key === 'region')).toBeTruthy()

    await user.type(screen.getByLabelText('Variable name: region'), '2')
    await settled()
    vars = await localVars()
    expect(vars).toHaveLength(before + 1)
    expect(vars.find((v) => v.key === 'region2')).toBeTruthy()
    // a fresh blank row is always available
    expect(screen.getByLabelText('Variable name (new)')).toBeInTheDocument()
  })

  it('saves a replaced secret and keeps it masked', async () => {
    const user = userEvent.setup()
    await openEditor()
    await user.type(screen.getByLabelText('Secret value: apiToken'), 'sk_new_999')
    await settled()
    const tok = (await localVars()).find((v) => v.key === 'apiToken')!
    expect(await backend.revealEnvironmentVariable(tok.id)).toBe('sk_new_999')
    expect(domDump()).not.toContain('sk_new_999')
    expect((screen.getByLabelText('Secret value: apiToken') as HTMLInputElement).placeholder).toContain('(unchanged)')
  })

  it('warns about duplicate keys, highlights both rows and does not save them', async () => {
    const user = userEvent.setup()
    await openEditor()
    await user.type(screen.getByLabelText('Variable name (new)'), 'userId')
    expect(await screen.findByTestId('duplicate-banner')).toHaveTextContent('userId')
    expect(document.querySelectorAll('[data-duplicate]')).toHaveLength(2)
    await vi.waitFor(() => expect(status()).toHaveTextContent('1 unsaved change'))
    await new Promise((r) => setTimeout(r, 900))
    expect((await localVars()).filter((v) => v.key === 'userId')).toHaveLength(1)
    expect(status()).toHaveTextContent('1 unsaved change')
  })

  it('validates key characters inline', async () => {
    const user = userEvent.setup()
    await openEditor()
    await user.type(screen.getByLabelText('Variable name (new)'), '$bad')
    expect(await screen.findByTestId('row-issue')).toHaveTextContent('reserved')
  })

  it('flushes pending edits when switching environment', async () => {
    const user = userEvent.setup()
    await openEditor()
    await user.type(screen.getByLabelText('Variable name (new)'), 'pending_one')
    await user.click(within(screen.getByRole('list', { name: 'Environments' })).getByText('Staging'))
    await screen.findByLabelText('Variable name: baseUrl')
    await vi.waitFor(() => expect(screen.getByRole('heading', { name: 'Staging' })).toBeInTheDocument())
    expect((await localVars()).some((v) => v.key === 'pending_one')).toBe(true)
    expect(screen.queryByLabelText('Variable name: userId')).not.toBeInTheDocument()
  })

  it('shows a failed save, keeps the row unsaved and retries', async () => {
    const user = userEvent.setup()
    await openEditor()
    window.__slingerMock!.failNext('upsertEnvironmentVariable', { message: 'disk full' })
    await user.type(screen.getByLabelText('Variable name (new)'), 'flaky')
    await vi.waitFor(() => expect(status()).toHaveTextContent('Error — retry'), { timeout: 3000 })
    expect(screen.getByRole('alert')).toHaveTextContent('disk full')
    expect((await localVars()).some((v) => v.key === 'flaky')).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await settled()
    expect((await localVars()).some((v) => v.key === 'flaky')).toBe(true)
  })

  it('keeps the dialog open when closing with a failing save', async () => {
    const user = userEvent.setup()
    await openEditor()
    window.__slingerMock!.failNext('upsertEnvironmentVariable', { message: 'disk full' })
    await user.type(screen.getByLabelText('Variable name (new)'), 'x1')
    await user.click(screen.getByRole('button', { name: 'Close' }))
    await vi.waitFor(() => expect(screen.getByText(/could not be saved/)).toBeInTheDocument())
    expect(ui.envEditor.open).toBe(true)
    await user.click(screen.getByRole('button', { name: /Discard unsaved/ }))
    expect(ui.envEditor.open).toBe(false)
  })

  it('deletes a variable through the backend', async () => {
    const user = userEvent.setup()
    await openEditor()
    await user.click(screen.getByRole('button', { name: 'Delete variable userId' }))
    await settled()
    await vi.waitFor(async () => expect((await localVars()).some((v) => v.key === 'userId')).toBe(false))
    expect(screen.queryByLabelText('Variable name: userId')).not.toBeInTheDocument()
  })

  it('adds a pre-named row from ui.envEditor.newVariable and focuses its value', async () => {
    ui.envEditor = { open: true, newVariable: 'fresh' }
    render(EnvironmentEditor)
    await screen.findByLabelText('Variable name: fresh')
    await settled()
    expect((await localVars()).some((v) => v.key === 'fresh')).toBe(true)
    expect(ui.envEditor.newVariable).toBeUndefined()
    const row = screen.getByLabelText('Variable name: fresh').closest('[data-testid="env-row"]')!
    await vi.waitFor(() => expect(row.contains(document.activeElement)).toBe(true))
    expect(document.activeElement).not.toBe(screen.getByLabelText('Variable name: fresh'))
  })

  it('creates and renames environments with inline errors, duplicates without secrets', async () => {
    const user = userEvent.setup()
    await openEditor()
    await user.click(screen.getByRole('button', { name: 'New environment' }))
    await user.type(await screen.findByLabelText('Environment name'), 'staging')
    await user.click(screen.getByRole('button', { name: 'Create' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('already exists')
    await user.clear(screen.getByLabelText('Environment name'))
    await user.type(screen.getByLabelText('Environment name'), 'Prod')
    await user.click(screen.getByRole('button', { name: 'Create' }))
    await vi.waitFor(() => expect(app.environments.map((e) => e.name)).toContain('Prod'))

    await user.click(within(screen.getByRole('list', { name: 'Environments' })).getByText('Local'))
    await screen.findByLabelText('Variable name: baseUrl')
    await user.click(screen.getByRole('button', { name: 'Duplicate environment' }))
    await vi.waitFor(() => expect(app.environments.map((e) => e.name)).toContain('Local copy'))
    const copy = app.environments.find((e) => e.name === 'Local copy')!
    const vars = await backend.listEnvironmentVariables(copy.id)
    expect(vars.some((v) => v.isSecret)).toBe(false)
    expect(vars.map((v) => v.key)).toContain('userId')
  })
  it('validates duplicate names while typing and keeps the dialog open on a backend duplicate_name', async () => {
    const user = userEvent.setup()
    await openEditor()
    await user.click(screen.getByRole('button', { name: 'New environment' }))
    const input = await screen.findByLabelText('Environment name')
    await user.type(input, '  STAGING ')
    expect(await screen.findByRole('alert')).toHaveTextContent('An environment named "Staging" already exists.')
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
    await user.type(input, '2')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    // Renaming to its own name with a different case is fine.
    await user.click(screen.getByRole('button', { name: 'Rename environment' }))
    const rename = await screen.findByLabelText('Environment name')
    await user.clear(rename)
    await user.type(rename, 'LOCAL')
    expect(screen.queryByRole('alert')).toBeNull()

    // Another device created "Remote" behind the renderer's back: the backend rejects, the dialog stays open.
    await backend.createEnvironment(app.workspaceId!, 'Remote')
    await user.clear(rename)
    await user.type(rename, 'remote')
    expect(screen.queryByRole('alert')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Rename' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('An environment named "Remote" already exists.')
    expect(screen.getByLabelText('Environment name')).toBeInTheDocument()
    expect(app.environments.find((e) => e.name === 'Local')).toBeTruthy()
  })
})
