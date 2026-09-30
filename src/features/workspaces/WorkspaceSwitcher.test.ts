import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../app/state.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import type { RunState } from '../runner/runner'
import { RunSession, runsStore } from '../runner/runs.svelte'
import WorkspaceSwitcher from './WorkspaceSwitcher.svelte'

let first: string
let second: string

beforeEach(async () => {
  localStorage.clear()
  const mock = createMockBackend({ latencyMs: 0, seed: false })
  window.slinger = mock
  window.__slingerMock = mock
  await app.init()
  first = app.workspaceId!
  second = (await mock.createWorkspace('Second')).id
  await app.refreshWorkspaces()
  runsStore.sessions = []
})
afterEach(() => {
  cleanup()
  runsStore.sessions = []
})

/** A run of the open workspace that is still going (nothing actually runs; `stop` just ends it). */
function runningRun(label: string): RunSession {
  const s = new RunSession(first, { collectionId: 'c1', folderId: null }, label, null, null)
  s.state = { phase: 'running', rows: [], completed: 0, startedAt: 0, finishedAt: null, stopped: false } as RunState
  s.run = { stop: () => (s.state = { ...s.state, phase: 'done', stopped: true }) } as unknown as RunSession['run']
  return s
}

const select = () => screen.getByLabelText('Workspace') as HTMLSelectElement

describe('WorkspaceSwitcher', () => {
  it('switches right away when nothing runs', async () => {
    render(WorkspaceSwitcher)
    await fireEvent.change(select(), { target: { value: second } })
    await waitFor(() => expect(app.workspaceId).toBe(second))
  })

  it('asks before stopping a run of the open workspace; Cancel keeps both', async () => {
    runsStore.sessions = [runningRun('Drive Automation')]
    render(WorkspaceSwitcher)
    await fireEvent.change(select(), { target: { value: second } })
    expect(await screen.findByText('The run of "Drive Automation" is still going. It needs this workspace, so switching stops it.')).toBeInTheDocument()
    expect(select().value).toBe(first)
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(app.workspaceId).toBe(first)
    expect(runsStore.sessions[0]!.running).toBe(true)
  })

  it('confirming stops the run and switches', async () => {
    runsStore.sessions = [runningRun('Drive Automation')]
    render(WorkspaceSwitcher)
    await fireEvent.change(select(), { target: { value: second } })
    await fireEvent.click(await screen.findByRole('button', { name: 'Stop run and switch' }))
    await waitFor(() => expect(app.workspaceId).toBe(second))
    expect(runsStore.sessions).toHaveLength(0)
  })
})
