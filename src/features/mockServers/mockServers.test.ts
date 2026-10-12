import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../app/state.svelte'
import { toast } from '../../app/toast.svelte'
import { ui } from '../../app/ui.svelte'
import type { MockServerLogEntry, StartMockServerInput } from '../../../shared/types'
import { createMockBackend } from '../../dev/mockBackend'
import { MOCK_SETTINGS_KEY, loadMockSettings } from '../../lib/mockServers'
import StatusBar from '../layout/StatusBar.svelte'
import MockServerDialog from './MockServerDialog.svelte'
import MockServersHost from './MockServersHost.svelte'
import { mockServers } from './mockServers.svelte'

let mock: ReturnType<typeof createMockBackend>
let ids: { col: string; empty: string; user: string; me: string }

const doc = (responses: unknown[]) => JSON.stringify({ responses })

beforeEach(async () => {
  localStorage.clear()
  toast.items = []
  ui.mockServerFor = null
  mockServers.reset()
  mock = createMockBackend({ latencyMs: 0, seed: false })
  window.slinger = mock
  window.__slingerMock = mock
  await app.init()
  const ws = app.workspaceId!
  const col = await mock.createCollection(ws, 'Users API')
  const empty = await mock.createCollection(ws, 'Empty')
  const user = await mock.createRequest({
    workspaceId: ws,
    collectionId: col.id,
    folderId: null,
    name: 'Get user',
    method: 'GET',
    url: '{{baseUrl}}/users/:id',
    documentJson: doc([
      { name: 'Found', code: 200, status: 'OK', header: [{ key: 'Content-Type', value: 'application/json' }], body: '{"id":1}' },
      { name: 'Missing', code: 404, status: 'Not Found', body: '{}' },
    ]),
  })
  const me = await mock.createRequest({
    workspaceId: ws,
    collectionId: col.id,
    folderId: null,
    name: 'Me',
    method: 'GET',
    url: '{{baseUrl}}/users/me',
    documentJson: doc([{ name: 'Me', code: 200, body: '{"me":true}' }]),
  })
  await app.reloadCollections()
  ids = { col: col.id, empty: empty.id, user: user.id, me: me.id }
})
afterEach(() => {
  cleanup()
  mockServers.reset()
})

describe('mockServers store', () => {
  it('starts with the collection examples, remembers the port, logs pushed requests and stops', async () => {
    const off = mockServers.init()
    expect(await mockServers.start(ids.col, 5050)).toBe(true)
    expect(mockServers.running(ids.col)).toMatchObject({ port: 5050, url: 'http://127.0.0.1:5050', exampleCount: 3 })
    expect(loadMockSettings(localStorage)).toEqual({
      collections: { [ids.col]: { port: 5050, options: { cors: 'local', delayMs: 0 }, startWithSlinger: true } },
      running: [{ collectionId: ids.col, workspaceId: app.workspaceId }],
    })
    const sent = mock.calls.find((c) => c.method === 'startMockServer')!.args[0] as StartMockServerInput
    expect(sent).toMatchObject({ collectionName: 'Users API', port: 5050, options: { cors: 'local', delayMs: 0 } })
    expect(sent.examples.map((e) => [e.name, e.url])).toEqual([
      ['Found', '{{baseUrl}}/users/:id'],
      ['Missing', '{{baseUrl}}/users/:id'],
      ['Me', '{{baseUrl}}/users/me'],
    ])

    expect(mock.mockServers.hit(ids.col, { path: '/users/me' }).entry.match?.name).toBe('Me')
    expect(mock.mockServers.hit(ids.col, { path: '/users/7', headers: { 'X-Mock-Response-Name': 'Missing' } }).status).toBe(404)
    expect(mock.mockServers.hit(ids.col, { method: 'POST', path: '/users' }).entry.match).toBeNull()
    expect(mockServers.logs[ids.col]!.map((e) => [e.path, e.status, e.match?.name ?? null])).toEqual([
      ['/users/me', 200, 'Me'],
      ['/users/7', 404, 'Missing'],
      ['/users', 404, null],
    ])
    expect(mockServers.running(ids.col)!.requestCount).toBe(3)

    await mockServers.stop(ids.col)
    expect(mockServers.running(ids.col)).toBeNull()
    // Stopped by the user: it does not start again with Slinger.
    expect(loadMockSettings(localStorage).running).toEqual([])
    // The log stays readable after a stop.
    expect(mockServers.logs[ids.col]).toHaveLength(3)
    await mockServers.clearLog(ids.col)
    expect(mockServers.logs[ids.col]).toEqual([])
    off()
  })

  it('suggests the remembered port, else the first one no other mock server uses', async () => {
    mockServers.init()
    expect(mockServers.suggestedPort(ids.col)).toBe(4010)
    await mockServers.start(ids.empty, 4010)
    expect(mockServers.suggestedPort(ids.col)).toBe(4011)
    localStorage.setItem(MOCK_SETTINGS_KEY, JSON.stringify({ ports: { [ids.col]: 6000 } }))
    expect(mockServers.suggestedPort(ids.col)).toBe(6000)
  })

  it('reports a busy port and keeps nothing running', async () => {
    mockServers.init()
    mock.mockServers.occupyPort(4010)
    expect(await mockServers.start(ids.col, 4010)).toBe(false)
    expect(mockServers.errors[ids.col]).toMatch(/Port 4010 is already in use/)
    expect(mockServers.running(ids.col)).toBeNull()
  })

  it('pushes edited examples to a running server', async () => {
    mockServers.init()
    await mockServers.start(ids.col, 4010)
    const r = app.requestById(ids.me)!
    await mock.updateRequest({ requestId: r.id, name: r.name, method: r.method, url: r.url, expectedVersion: r.version, documentJson: doc([{ name: 'Me v2', code: 200 }]) })
    await app.reloadCollection(ids.col)
    await mockServers.refreshExamples()
    expect(mock.calls.filter((c) => c.method === 'updateMockServer')).toHaveLength(1)
    expect(mock.mockServers.hit(ids.col, { path: '/users/me' }).entry.match?.name).toBe('Me v2')
    // Nothing changed: nothing is sent again.
    await mockServers.refreshExamples()
    expect(mock.calls.filter((c) => c.method === 'updateMockServer')).toHaveLength(1)
  })

  it('follows servers stopped elsewhere and shows why', async () => {
    mockServers.init()
    await mockServers.start(ids.col, 4010)
    mock.mockServers.crash(ids.col, 'boom')
    expect(mockServers.running(ids.col)).toBeNull()
    expect(toast.items.map((t) => [t.title, t.detail])).toEqual([['Mock server stopped', 'boom']])
  })

  it('picks up servers that were already running (renderer reload)', async () => {
    await mock.startMockServer({ workspaceId: app.workspaceId!, collectionId: ids.col, collectionName: 'Users API', port: 4321, examples: [] })
    mockServers.init()
    await waitFor(() => expect(mockServers.running(ids.col)?.port).toBe(4321))
  })
})

describe('mockServers store: options, events and the running list', () => {
  const runningIds = () => loadMockSettings(localStorage).running.map((r) => r.collectionId)

  it('remembers options before a start, starts with them, and applies changes live', async () => {
    mockServers.init()
    expect(await mockServers.setOptions(ids.col, { cors: 'any', delayMs: 300 })).toBe(true)
    expect(mock.calls.some((c) => c.method === 'setMockServerOptions')).toBe(false)
    expect(mockServers.optionsFor(ids.col)).toEqual({ cors: 'any', delayMs: 300 })
    await mockServers.start(ids.col, 4010)
    const sent = mock.calls.find((c) => c.method === 'startMockServer')!.args[0] as StartMockServerInput
    expect(sent.options).toEqual({ cors: 'any', delayMs: 300 })
    expect(mockServers.running(ids.col)!.options).toEqual({ cors: 'any', delayMs: 300 })

    expect(await mockServers.setOptions(ids.col, { cors: 'local', delayMs: 99999 })).toBe(true)
    // Clamped to the maximum before it is sent.
    expect(mock.calls.find((c) => c.method === 'setMockServerOptions')!.args).toEqual([ids.col, { cors: 'local', delayMs: 60000 }])
    expect(mockServers.running(ids.col)!.options).toEqual({ cors: 'local', delayMs: 60000 })
    expect(mock.mockServers.hit(ids.col, { path: '/users/me' }).entry.response.delayMs).toBe(60000)
    expect(loadMockSettings(localStorage).collections[ids.col]!.options).toEqual({ cors: 'local', delayMs: 60000 })

    mockServers.setStartWithSlinger(ids.col, false)
    expect(mockServers.settingsFor(ids.col).startWithSlinger).toBe(false)
    expect(loadMockSettings(localStorage).collections[ids.col]!.startWithSlinger).toBe(false)
  })

  it('follows updated events from elsewhere (options, name)', async () => {
    mockServers.init()
    await mockServers.start(ids.col, 4010)
    mock.mockServers.hit(ids.col, { path: '/users/me' })
    await mock.setMockServerOptions(ids.col, { cors: 'any', delayMs: 5 })
    expect(mockServers.running(ids.col)).toMatchObject({ options: { cors: 'any', delayMs: 5 }, requestCount: 1 })
    expect(mockServers.settingsFor(ids.col).options).toEqual({ cors: 'any', delayMs: 5 })
  })

  it('sends the new name after a rename', async () => {
    mockServers.init()
    await mockServers.start(ids.col, 4010)
    await mock.renameCollection(ids.col, 'People API')
    await app.reloadCollections()
    await mockServers.refreshExamples()
    const update = mock.calls.filter((c) => c.method === 'updateMockServer')
    expect(update).toHaveLength(1)
    expect(update[0]!.args[2]).toBe('People API')
    expect(mockServers.running(ids.col)!.collectionName).toBe('People API')
    // An edit without a rename sends no name.
    const r = app.requestById(ids.me)!
    await mock.updateRequest({ requestId: r.id, name: r.name, method: r.method, url: r.url, expectedVersion: r.version, documentJson: doc([{ name: 'v2', code: 200 }]) })
    await app.reloadCollection(ids.col)
    await mockServers.refreshExamples()
    const again = mock.calls.filter((c) => c.method === 'updateMockServer')
    expect(again).toHaveLength(2)
    expect(again[1]!.args).toHaveLength(2)
  })

  it('keeps the running list on quit, drops it on a stop by the user or a failure, ignores a replace', async () => {
    mockServers.init()
    await mockServers.start(ids.col, 4010)
    await mockServers.start(ids.empty, 4011)
    expect(runningIds().sort()).toEqual([ids.col, ids.empty].sort())

    // Moving to another port: still running, still listed.
    await mockServers.start(ids.col, 4020)
    expect(mockServers.running(ids.col)?.port).toBe(4020)
    expect(runningIds()).toContain(ids.col)
    expect(loadMockSettings(localStorage).collections[ids.col]!.port).toBe(4020)

    mock.mockServers.crash(ids.empty, 'boom')
    expect(runningIds()).toEqual([ids.col])

    mock.mockServers.quit()
    expect(mockServers.list).toEqual([])
    expect(runningIds()).toEqual([ids.col])
    // No toast for a quit.
    expect(toast.items.map((t) => t.detail)).toEqual(['boom'])
  })

  it('a stop from the tray (stopped by user) leaves the running list', async () => {
    mockServers.init()
    await mockServers.start(ids.col, 4010)
    await mock.stopMockServer(ids.col)
    expect(mockServers.running(ids.col)).toBeNull()
    expect(runningIds()).toEqual([])
  })

  it('deleting the collection forgets it', async () => {
    mockServers.init()
    await mockServers.setOptions(ids.col, { cors: 'any', delayMs: 0 })
    await mockServers.start(ids.col, 4010)
    await mockServers.stopIfRunning(ids.col)
    expect(loadMockSettings(localStorage)).toEqual({ collections: {}, running: [] })
  })
})

describe('start with Slinger', () => {
  const remember = (settings: unknown) => localStorage.setItem(MOCK_SETTINGS_KEY, JSON.stringify(settings))
  const options = { cors: 'any', delayMs: 100 }

  it('starts what was running when Slinger quit, also in another workspace, with its port and options', async () => {
    const other = await mock.createWorkspace('Other')
    const otherCol = await mock.createCollection(other.id, 'Elsewhere')
    await mock.createRequest({
      workspaceId: other.id,
      collectionId: otherCol.id,
      folderId: null,
      name: 'Ping',
      method: 'GET',
      url: '/ping',
      documentJson: doc([{ name: 'Pong', code: 200, body: 'pong' }]),
    })
    remember({
      v: 2,
      collections: {
        [ids.col]: { port: 4600, options, startWithSlinger: true },
        [otherCol.id]: { port: 4601, options: { cors: 'local', delayMs: 0 }, startWithSlinger: true },
      },
      running: [
        { collectionId: ids.col, workspaceId: app.workspaceId },
        { collectionId: otherCol.id, workspaceId: other.id },
      ],
    })
    mockServers.init()
    await mockServers.ready
    expect(mockServers.running(ids.col)).toMatchObject({ port: 4600, options, collectionName: 'Users API', exampleCount: 3 })
    expect(mockServers.running(otherCol.id)).toMatchObject({ port: 4601, workspaceId: other.id, collectionName: 'Elsewhere', exampleCount: 1 })
    expect(mock.mockServers.hit(otherCol.id, { path: '/ping' }).body).toBe('pong')
    expect(toast.items).toEqual([])
    expect(loadMockSettings(localStorage).running).toHaveLength(2)

    // Live reload does not resend an unchanged collection that was started this way.
    await mockServers.refreshExamples()
    expect(mock.calls.filter((c) => c.method === 'updateMockServer')).toHaveLength(0)

    // A second init (renderer reload) does not start them twice.
    const starts = mock.calls.filter((c) => c.method === 'startMockServer').length
    mockServers.init()
    await mockServers.ready
    expect(mock.calls.filter((c) => c.method === 'startMockServer')).toHaveLength(starts)
  })

  it('a full quit and relaunch starts it again', async () => {
    mockServers.init()
    await mockServers.setOptions(ids.col, { cors: 'any', delayMs: 100 })
    await mockServers.start(ids.col, 4700)
    mock.mockServers.quit()
    mockServers.reset()
    mockServers.init()
    await mockServers.ready
    expect(mockServers.running(ids.col)).toMatchObject({ port: 4700, options })
  })

  it('skips servers switched off, drops gone collections quietly, and names the ones that fail', async () => {
    mock.mockServers.occupyPort(4801)
    remember({
      v: 2,
      collections: {
        [ids.col]: { port: 4800, options, startWithSlinger: false },
        [ids.empty]: { port: 4801, options, startWithSlinger: true },
        gone: { port: 4802, options, startWithSlinger: true },
      },
      running: [
        { collectionId: ids.col, workspaceId: app.workspaceId },
        { collectionId: ids.empty, workspaceId: app.workspaceId },
        { collectionId: 'gone', workspaceId: app.workspaceId },
        { collectionId: 'lost', workspaceId: 'no-such-workspace' },
      ],
    })
    mockServers.init()
    await mockServers.ready
    expect(mockServers.list).toEqual([])
    expect(toast.items.map((t) => [t.title, t.detail])).toEqual([['Could not start the mock server of “Empty”', expect.stringMatching(/Port 4801 is already in use/)]])
    expect(loadMockSettings(localStorage).running).toEqual([])
    // What is remembered about each collection stays.
    expect(loadMockSettings(localStorage).collections[ids.col]!.port).toBe(4800)
  })
})

describe('MockServerDialog', () => {
  it('starts on the typed port, shows the base URL and the log, opens an example, and stops', async () => {
    mockServers.init()
    const onopenexample = vi.fn()
    render(MockServerDialog, { collectionId: ids.col, onclose: () => {}, onopenexample })
    expect(screen.getByRole('dialog', { name: 'Mock server · Users API' })).toBeInTheDocument()
    expect(screen.getByTestId('mock-summary')).toHaveTextContent('Not running · 3 saved examples to serve')
    const port = screen.getByLabelText('Port')
    expect(port).toHaveValue('4010')
    await fireEvent.input(port, { target: { value: '4999' } })
    await fireEvent.click(screen.getByTestId('mock-start'))
    await waitFor(() => expect(screen.getByTestId('mock-url')).toHaveTextContent('http://127.0.0.1:4999'))
    expect(screen.getByText('No requests yet.')).toBeInTheDocument()

    mock.mockServers.hit(ids.col, { path: '/users/42' })
    mock.mockServers.hit(ids.col, { path: '/nope' })
    await waitFor(() => expect(screen.getAllByTestId('mock-log-row')).toHaveLength(2))
    const [newest, oldest] = screen.getAllByTestId('mock-log-row')
    expect(newest).toHaveTextContent('/nope')
    expect(newest).toHaveTextContent('no match')
    expect(newest).toHaveTextContent('404')
    expect(oldest).toHaveTextContent('Get user › Found')
    expect(screen.getByTestId('mock-summary')).toHaveTextContent('serving 3 saved examples · 2 requests answered')
    await fireEvent.click(screen.getByRole('button', { name: 'Get user › Found' }))
    expect(onopenexample).toHaveBeenCalledWith(ids.user, 0)

    await fireEvent.click(screen.getByRole('button', { name: 'Clear log' }))
    await waitFor(() => expect(screen.queryAllByTestId('mock-log-row')).toHaveLength(0))
    await fireEvent.click(screen.getByTestId('mock-stop'))
    await waitFor(() => expect(screen.getByTestId('mock-start')).toBeInTheDocument())
  })

  it('validates the port and shows a busy port inline', async () => {
    mockServers.init()
    render(MockServerDialog, { collectionId: ids.col, onclose: () => {}, onopenexample: () => {} })
    const port = screen.getByLabelText('Port')
    await fireEvent.input(port, { target: { value: '80' } })
    await fireEvent.click(screen.getByTestId('mock-start'))
    expect(screen.getByRole('alert')).toHaveTextContent('Ports below 1024 need administrator rights')
    mock.mockServers.occupyPort(4010)
    await fireEvent.input(port, { target: { value: '4010' } })
    await fireEvent.click(screen.getByTestId('mock-start'))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Port 4010 is already in use'))
    expect(mockServers.running(ids.col)).toBeNull()
  })

  it('warns when the collection has no saved examples', () => {
    render(MockServerDialog, { collectionId: ids.empty, onclose: () => {}, onopenexample: () => {} })
    expect(screen.getByTestId('mock-no-examples')).toBeInTheDocument()
  })
})

describe('host and status bar', () => {
  it('the host opens the dialog from ui.mockServerFor; the status bar shows running servers and opens them', async () => {
    render(MockServersHost)
    render(StatusBar)
    expect(screen.queryByTestId('status-mocks')).toBeNull()
    ui.mockServerFor = ids.col
    await waitFor(() => expect(screen.getByTestId('mock-server-dialog')).toBeInTheDocument())
    await fireEvent.click(screen.getByTestId('mock-start'))
    await waitFor(() => expect(screen.getByTestId('status-mocks')).toHaveTextContent('Mock 127.0.0.1:4010'))
    ui.mockServerFor = null
    await waitFor(() => expect(screen.queryByTestId('mock-server-dialog')).toBeNull())
    await fireEvent.click(screen.getByTestId('status-mocks'))
    expect(ui.mockServerFor).toBe(ids.col)
  })
})
