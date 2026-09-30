/** Status bar: sync states, environment, activity, the active tab's response summary, and showing/hiding it. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import App from '../../app/App.svelte'
import { runMenuCommand } from '../../app/menuCommands'
import { settings } from '../../app/settings.svelte'
import { app } from '../../app/state.svelte'
import { ui } from '../../app/ui.svelte'
import { tabsStore } from '../requests/tabs.svelte'
import type { RowStatus, RunRow, RunState } from '../runner/runner'
import { RunSession, runsStore } from '../runner/runs.svelte'
import { sync } from '../sync/syncStore.svelte'
import { flush, setupSync, signInMock, teardownSync, type Backend } from '../sync/testUtils'
import StatusBar from './StatusBar.svelte'

let b: Backend
let ws: string
beforeEach(async () => {
  b = await setupSync()
  ws = app.workspaceId!
  ui.envEditor = { open: false }
  runsStore.sessions = []
})
afterEach(() => {
  cleanup()
  teardownSync()
  runsStore.sessions = []
  ui.runner = null
  ui.envEditor = { open: false }
  settings.setShowStatusBar(true)
})

const syncItem = () => screen.getByTestId('status-sync')

describe('status bar: cloud sync', () => {
  it('shows "Local only" for an unlinked workspace; clicking opens the Cloud dialog', async () => {
    render(StatusBar)
    expect(syncItem()).toHaveTextContent('Local only')
    expect(syncItem().dataset.kind).toBe('unlinked')
    await fireEvent.click(syncItem())
    expect(ui.cloudOpen).toBe(true)
  })

  it('follows synced, pending, offline and conflict states; with conflicts it opens the conflict center', async () => {
    render(StatusBar)
    await signInMock(b)
    await sync.publish(ws)
    await b.cloud.runCycle(ws)
    await flush()
    await waitFor(() => expect(syncItem().dataset.kind).toBe('idle'))
    expect(syncItem()).toHaveTextContent('Synced')
    expect(syncItem().getAttribute('aria-label')).toMatch(/^Cloud sync: Synced\. .*Last synced/)

    b.cloud.setOffline(true)
    await sync.syncNow(ws)
    await waitFor(() => expect(syncItem().dataset.kind).toBe('offline'))
    expect(syncItem()).toHaveTextContent('Offline')
    b.cloud.setOffline(false)
    await sync.syncNow(ws)

    b.cloud.injectConflict({ workspaceId: ws, kind: 'rejected' })
    await waitFor(() => expect(syncItem().dataset.kind).toBe('conflicts'))
    expect(syncItem()).toHaveTextContent('1 conflict')
    await fireEvent.click(syncItem())
    expect(ui.conflictsOpen).toBe(true)
    expect(ui.cloudOpen).toBe(false)
  })
})

describe('status bar: environment and activity', () => {
  it('names the active environment and opens the Environments dialog on it', async () => {
    render(StatusBar)
    const env = app.environments.find((e) => e.id === app.activeEnvironmentId)!
    expect(env).toBeTruthy()
    expect(screen.getByTestId('status-env')).toHaveTextContent(env.name)
    await fireEvent.click(screen.getByTestId('status-env'))
    expect(ui.envEditor).toEqual({ open: true, environmentId: env.id })

    await app.setActiveEnvironment(null)
    await waitFor(() => expect(screen.getByTestId('status-env')).toHaveTextContent('No environment'))
  })

  it('reports sends and a running collection', async () => {
    render(StatusBar)
    expect(screen.getByTestId('status-activity')).toHaveTextContent('')
    const a = tabsStore.newTab()
    const c = tabsStore.newTab()
    a.sending = true
    await waitFor(() => expect(screen.getByTestId('status-activity')).toHaveTextContent('Sending…'))
    c.sending = true
    await waitFor(() => expect(screen.getByTestId('status-activity')).toHaveTextContent('Sending 2 requests…'))
    a.sending = false
    c.sending = false
    await waitFor(() => expect(screen.getByTestId('status-activity')).toHaveTextContent(''))
  })
})

/** A run as the runs store holds it, without running anything. */
function fakeRun(label: string, collectionId: string, statuses: RowStatus[], phase: RunState['phase'], unseen = false): RunSession {
  const s = new RunSession(ws, { collectionId, folderId: null }, label, null, null)
  const rows = statuses.map((status) => ({ status, tests: [], scriptErrors: [] }) as unknown as RunRow)
  s.state = { phase, rows, completed: statuses.filter((x) => x !== 'pending' && x !== 'running').length, startedAt: 0, finishedAt: phase === 'done' ? 1 : null, stopped: false }
  s.unseen = unseen
  return s
}

describe('status bar: collection runs', () => {
  it('shows a running collection and opens it on click', async () => {
    runsStore.sessions = [fakeRun('Demo API', 'c1', ['passed', 'passed', 'failed', 'running', 'pending'], 'running')]
    render(StatusBar)
    const btn = screen.getByTestId('status-runs')
    expect(btn).toHaveTextContent('Running Demo API… 3/5')
    await fireEvent.click(btn)
    expect(ui.runner).toEqual({ collectionId: 'c1', folderId: null })
  })

  it('a run finished in the background stays until opened, in red when something failed', async () => {
    const s = fakeRun('Payments', 'c2', ['passed', 'failed'], 'done', true)
    runsStore.sessions = [s]
    render(StatusBar)
    const btn = screen.getByTestId('status-runs')
    expect(btn).toHaveTextContent('Run finished: Payments')
    expect(btn.className).toContain('text-danger')
    await fireEvent.click(btn)
    expect(ui.runner).toEqual({ collectionId: 'c2', folderId: null })
    expect(s.unseen).toBe(false)
    await waitFor(() => expect(screen.queryByTestId('status-runs')).toBeNull())
    // Finished runs whose results were already seen (their dialog is open or was open) are not shown.
    runsStore.sessions = [fakeRun('Seen', 'c3', ['passed'], 'done', false)]
    await waitFor(() => expect(screen.queryByTestId('status-runs')).toBeNull())
  })

  it('with several runs, sums the progress and lets you pick one from a menu', async () => {
    runsStore.sessions = [
      fakeRun('Demo API', 'c1', ['passed', 'running'], 'running'),
      fakeRun('Payments', 'c2', ['passed', 'passed', 'pending'], 'running'),
      fakeRun('Old', 'c3', ['passed'], 'done', true),
    ]
    render(StatusBar)
    const btn = screen.getByTestId('status-runs')
    expect(btn).toHaveTextContent('2 runs… 3/5')
    await fireEvent.click(btn)
    const menu = await screen.findByRole('menu')
    const items = [...menu.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent?.trim())
    expect(items).toEqual(['Demo API: 1/2', 'Payments: 2/3', 'Old: 1 passed, 0 failed'])
    await fireEvent.click(screen.getByRole('menuitem', { name: /Payments/ }))
    expect(ui.runner).toEqual({ collectionId: 'c2', folderId: null })
  })
})

describe('status bar: last response', () => {
  it('summarises the active request tab’s response (status, time, size) and nothing for other tabs', async () => {
    render(StatusBar)
    const tab = tabsStore.newTab()
    expect(screen.queryByTestId('status-response')).toBeNull()
    tab.response = {
      data: { status: 404, statusText: 'Not Found', durationMs: 125, headers: [], bodyText: 'nope', bodyBase64: null, bodyByteLength: 2048 },
      elapsedMs: 130,
      receivedAt: Date.now(),
    }
    const summary = await screen.findByTestId('status-response')
    expect(summary).toHaveTextContent('404 Not Found')
    expect(summary).toHaveTextContent('125 ms')
    expect(summary).toHaveTextContent('2.0 KB')
    expect(summary.querySelector('.text-warning')).toHaveTextContent('404 Not Found')

    // While a new send is in flight the old summary goes away.
    tab.sending = true
    await waitFor(() => expect(screen.queryByTestId('status-response')).toBeNull())
    tab.sending = false

    // Another tab without a response shows nothing; a failed send says so.
    const other = tabsStore.newTab()
    await waitFor(() => expect(screen.queryByTestId('status-response')).toBeNull())
    other.error = { message: 'Could not connect', unresolved: [] }
    await waitFor(() => expect(screen.getByTestId('status-response')).toHaveTextContent('Not sent'))
    tabsStore.activate(tab.id)
    await waitFor(() => expect(screen.getByTestId('status-response')).toHaveTextContent('404 Not Found'))
  })
})

describe('showing and hiding the status bar', () => {
  it('is on by default and follows the setting, View > Toggle Status Bar and the menu command', async () => {
    render(App)
    await screen.findByTestId('status-bar')
    expect(screen.getByRole('contentinfo', { name: 'Status bar' })).toBeInTheDocument()
    expect(runMenuCommand('toggleStatusBar')).toBe(true)
    await waitFor(() => expect(screen.queryByTestId('status-bar')).toBeNull())
    expect(localStorage.getItem('slinger.statusBar')).toBe('false')
    settings.setShowStatusBar(true)
    await screen.findByTestId('status-bar')
  })
})
