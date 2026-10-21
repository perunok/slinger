import { cleanup, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../app/state.svelte'
import { sync } from '../sync/syncStore.svelte'
import { flush, setupSync, signInMock, teardownSync, type Backend } from '../sync/testUtils'
import WorkspaceSwitcher from './WorkspaceSwitcher.svelte'
import WorkspacesDialog from './WorkspacesDialog.svelte'

let b: Backend
beforeEach(async () => {
  b = await setupSync()
})
afterEach(() => {
  cleanup()
  teardownSync()
})

const options = () => within(screen.getByLabelText('Workspace')).getAllByRole('option').map((o) => o.textContent)

async function publishPersonal() {
  const id = app.workspaceId!
  await signInMock(b)
  await sync.publish(id)
  await b.cloud.runCycle(id)
  await flush()
  return { id, rid: (await b.getSyncStatus(id)).remoteWorkspaceId! }
}

describe('team label in the workspace switcher', () => {
  it('marks a workspace downloaded from the cloud', async () => {
    render(WorkspaceSwitcher)
    expect(options()).toContain('Team Sandbox (team)')
    expect(options()).toContain('Personal')
  })

  it('marks a published workspace only once it has other members', async () => {
    const { id, rid } = await publishPersonal()
    render(WorkspaceSwitcher)
    const name = app.workspaces.find((w) => w.id === id)!.name
    expect(options()).toContain(name) // only you: still personal
    b.cloud.setMembers(rid, [
      { name: 'Ana Silva', email: 'ana@example.com', role: 'owner' },
      { name: 'Bo Tran', email: 'bo@example.com', role: 'editor' },
    ])
    await waitFor(() => expect(options()).toContain(`${name} (team)`))
    b.cloud.setMembers(rid, [{ name: 'Ana Silva', email: 'ana@example.com', role: 'owner' }])
    await waitFor(() => expect(options()).toContain(name))
  })
})

describe('team badge in the workspaces dialog', () => {
  const rowOf = (name: string) => screen.getAllByRole('listitem').find((li) => li.textContent?.includes(name))!

  it('shows "team" for a downloaded workspace without a count, and the count once known', async () => {
    render(WorkspacesDialog)
    const sandbox = rowOf('Team Sandbox')
    expect(within(sandbox).getByTestId('team-badge')).toHaveTextContent(/^team$/)
    expect(within(rowOf('Personal')).queryByTestId('team-badge')).toBeNull()
  })

  it('shows "team · N members" for a shared published workspace', async () => {
    const { id, rid } = await publishPersonal()
    const name = app.workspaces.find((w) => w.id === id)!.name
    render(WorkspacesDialog)
    expect(within(rowOf(name)).queryByTestId('team-badge')).toBeNull()
    b.cloud.setMembers(rid, [
      { name: 'Ana Silva', email: 'ana@example.com', role: 'owner' },
      { name: 'Bo Tran', email: 'bo@example.com', role: 'editor' },
      { name: 'Cy Ford', email: 'cy@example.com', role: 'viewer' },
    ])
    await waitFor(() => expect(within(rowOf(name)).getByTestId('team-badge')).toHaveTextContent('team · 3 members'))
  })
})
