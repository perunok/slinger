import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../app/state.svelte'
import { toast } from '../../app/toast.svelte'
import { ui } from '../../app/ui.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import { MOCK_PORTS_KEY } from '../../lib/mockServers'
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
    expect(JSON.parse(localStorage.getItem(MOCK_PORTS_KEY)!)).toEqual({ ports: { [ids.col]: 5050 } })
    const sent = mock.calls.find((c) => c.method === 'startMockServer')!.args[0] as { examples: { name: string; url: string }[] }
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
    localStorage.setItem(MOCK_PORTS_KEY, JSON.stringify({ ports: { [ids.col]: 6000 } }))
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
    await mock.startMockServer({ workspaceId: app.workspaceId!, collectionId: ids.col, port: 4321, examples: [] })
    mockServers.init()
    await waitFor(() => expect(mockServers.running(ids.col)?.port).toBe(4321))
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
