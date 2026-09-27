/** Status bar: sync states, environment, activity, the active tab's response summary, and showing/hiding it. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { activity } from '../../app/activity.svelte'
import App from '../../app/App.svelte'
import { runMenuCommand } from '../../app/menuCommands'
import { settings } from '../../app/settings.svelte'
import { app } from '../../app/state.svelte'
import { ui } from '../../app/ui.svelte'
import { tabsStore } from '../requests/tabs.svelte'
import { sync } from '../sync/syncStore.svelte'
import { flush, setupSync, signInMock, teardownSync, type Backend } from '../sync/testUtils'
import StatusBar from './StatusBar.svelte'

let b: Backend
let ws: string
beforeEach(async () => {
  b = await setupSync()
  ws = app.workspaceId!
  ui.envEditor = { open: false }
  activity.runner = null
})
afterEach(() => {
  cleanup()
  teardownSync()
  activity.runner = null
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
    activity.runner = { label: 'Demo API', done: 3, total: 10 }
    await waitFor(() => expect(screen.getByTestId('status-activity')).toHaveTextContent('Running Demo API… 3/10'))
    activity.runner = null
    a.sending = false
    c.sending = false
    await waitFor(() => expect(screen.getByTestId('status-activity')).toHaveTextContent(''))
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
