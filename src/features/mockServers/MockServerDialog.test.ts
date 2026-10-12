import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MOCK_LOG_BODY_LIMIT } from '../../../shared/types'
import { app } from '../../app/state.svelte'
import { toast } from '../../app/toast.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import { loadMockSettings } from '../../lib/mockServers'
import MockServerDialog from './MockServerDialog.svelte'
import { mockServers } from './mockServers.svelte'

let mock: ReturnType<typeof createMockBackend>
let ids: { col: string; user: string; create: string }

const doc = (responses: unknown[]) => JSON.stringify({ responses })
const TOKEN = 'Bearer eyJhbGciOiJIUzI1NiJ9.secret-payload.signature'

beforeEach(async () => {
  localStorage.clear()
  toast.items = []
  mockServers.reset()
  mock = createMockBackend({ latencyMs: 0, seed: false })
  window.slinger = mock
  window.__slingerMock = mock
  await app.init()
  const ws = app.workspaceId!
  const col = await mock.createCollection(ws, 'Users API')
  const user = await mock.createRequest({
    workspaceId: ws,
    collectionId: col.id,
    folderId: null,
    name: 'Get user',
    method: 'GET',
    url: '{{baseUrl}}/users/:id',
    documentJson: doc([{ name: 'Found', code: 200, status: 'OK', header: [{ key: 'Content-Type', value: 'application/json' }, { key: 'Set-Cookie', value: 'session=abcdef123456' }], body: '{"id":1}' }]),
  })
  const create = await mock.createRequest({
    workspaceId: ws,
    collectionId: col.id,
    folderId: null,
    name: 'Create user',
    method: 'POST',
    url: '{{baseUrl}}/users',
    documentJson: doc([{ name: 'Created', code: 201, status: 'Created', body: '{"id":2}' }]),
  })
  await app.reloadCollections()
  ids = { col: col.id, user: user.id, create: create.id }
  mockServers.init()
  await mockServers.ready
})
afterEach(() => {
  cleanup()
  mockServers.reset()
})

function open(onopenexample: (requestId: string, index: number) => void = () => {}) {
  return render(MockServerDialog, { collectionId: ids.col, onclose: () => {}, onopenexample })
}

async function startOn(port: string) {
  await fireEvent.input(screen.getByLabelText('Port'), { target: { value: port } })
  await fireEvent.click(screen.getByTestId('mock-start'))
  await waitFor(() => expect(screen.getByTestId('mock-url')).toBeInTheDocument())
}

describe('MockServerDialog options', () => {
  it('edits CORS, delay and start-with-Slinger before the start and while it runs', async () => {
    open()
    const cors = screen.getByLabelText('Allow any website (CORS)') as HTMLInputElement
    const delay = screen.getByLabelText('Delay (ms)') as HTMLInputElement
    const again = screen.getByLabelText('Start again when Slinger starts') as HTMLInputElement
    expect(cors.checked).toBe(false)
    expect(delay.value).toBe('0')
    expect(again.checked).toBe(true)
    expect(screen.getByRole('button', { name: 'About CORS' })).toBeInTheDocument()

    // Before the start: remembered only.
    await fireEvent.click(cors)
    await fireEvent.input(delay, { target: { value: '250' } })
    await fireEvent.change(delay)
    await fireEvent.click(again)
    expect(loadMockSettings(localStorage).collections[ids.col]).toEqual({ port: null, options: { cors: 'any', delayMs: 250 }, startWithSlinger: false })
    expect(mock.calls.some((c) => c.method === 'setMockServerOptions')).toBe(false)

    await startOn('4500')
    expect(mock.calls.find((c) => c.method === 'startMockServer')!.args[0]).toMatchObject({ options: { cors: 'any', delayMs: 250 } })
    expect((screen.getByLabelText('Allow any website (CORS)') as HTMLInputElement).checked).toBe(true)

    // While running: applied live.
    await fireEvent.click(screen.getByLabelText('Allow any website (CORS)'))
    await waitFor(() => expect(mockServers.running(ids.col)!.options.cors).toBe('local'))
    await fireEvent.input(delay, { target: { value: '1500' } })
    await fireEvent.keyDown(delay, { key: 'Enter' })
    await waitFor(() => expect(mockServers.running(ids.col)!.options).toEqual({ cors: 'local', delayMs: 1500 }))
    expect(mock.calls.filter((c) => c.method === 'setMockServerOptions').map((c) => c.args[1])).toEqual([
      { cors: 'local', delayMs: 250 },
      { cors: 'local', delayMs: 1500 },
    ])
  })

  it('refuses a delay out of range', async () => {
    open()
    const delay = screen.getByLabelText('Delay (ms)')
    await fireEvent.input(delay, { target: { value: '70000' } })
    await fireEvent.change(delay)
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a delay between 0 and 60000 ms.')
    expect(delay).toHaveAttribute('aria-invalid', 'true')
    expect(mockServers.optionsFor(ids.col).delayMs).toBe(0)
    await fireEvent.input(delay, { target: { value: '10' } })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('MockServerDialog request inspector', () => {
  it('shows a request and its answer, with credentials shortened', async () => {
    const onopenexample = vi.fn()
    open(onopenexample)
    await startOn('4501')
    mock.mockServers.hit(ids.col, {
      path: '/users/7?expand=roles&q=a%20b',
      headers: { Host: '127.0.0.1:4501', Authorization: TOKEN, 'X-Session-Token': 'tok_1234567890', Accept: 'application/json' },
    })
    await waitFor(() => expect(screen.getAllByTestId('mock-log-row')).toHaveLength(1))
    expect(screen.queryByTestId('mock-request-details')).toBeNull()
    await fireEvent.click(screen.getByTestId('mock-log-row'))
    const details = screen.getByTestId('mock-request-details')
    expect(screen.getByTestId('mock-log-row')).toHaveAttribute('aria-selected', 'true')

    expect(within(details).getByTestId('mock-request-line')).toHaveTextContent('GET /users/7?expand=roles&q=a%20b')
    const query = within(details).getByRole('table', { name: 'Query parameters' })
    expect([...query.querySelectorAll('tr')].map((r) => r.textContent)).toEqual(['expandroles', 'qa b'])

    const headers = within(details).getByRole('table', { name: 'Request headers' })
    expect(headers).toHaveTextContent(`Bearer… (${TOKEN.length} characters)`)
    expect(headers).toHaveTextContent('tok_12… (14 characters)')
    expect(headers).toHaveTextContent('application/json')
    expect(details.textContent).not.toContain('secret-payload')
    expect(details.textContent).not.toContain('tok_1234567890')
    expect(within(details).getByText('No body')).toBeInTheDocument()

    expect(within(details).getByTestId('mock-response-status')).toHaveTextContent('200 OK')
    const response = within(details).getByRole('table', { name: 'Response headers' })
    expect(response).toHaveTextContent('application/json')
    expect(response).toHaveTextContent('sessio… (20 characters)')
    expect(response.textContent).not.toContain('abcdef123456')
    expect(within(details).getByTestId('mock-response-timing')).toHaveTextContent('Delay none · took 0 ms')
    await fireEvent.click(within(details).getByRole('button', { name: 'Get user › Found' }))
    expect(onopenexample).toHaveBeenCalledWith(ids.user, 0)

    // Clicking the row again closes the details.
    await fireEvent.click(screen.getByTestId('mock-log-row'))
    expect(screen.queryByTestId('mock-request-details')).toBeNull()
  })

  it('pretty-prints JSON bodies, notes binary and truncated ones, and explains misses', async () => {
    open()
    await startOn('4502')
    await mockServers.setOptions(ids.col, { cors: 'local', delayMs: 40 })
    mock.mockServers.hit(ids.col, { method: 'POST', path: '/users', headers: { 'content-type': 'application/json' }, body: '{"name":"Ann","tags":["a"]}' })
    mock.mockServers.hit(ids.col, { method: 'POST', path: '/users', body: new Uint8Array([0xff, 0xfe, 0x00, 0x01]) })
    mock.mockServers.hit(ids.col, { method: 'POST', path: '/users', body: 'x'.repeat(MOCK_LOG_BODY_LIMIT + 10) })
    mock.mockServers.hit(ids.col, { method: 'DELETE', path: '/nothing' })
    await waitFor(() => expect(screen.getAllByTestId('mock-log-row')).toHaveLength(4))
    // Newest first.
    const rows = () => screen.getAllByTestId('mock-log-row')
    const show = async (i: number) => {
      await fireEvent.click(rows()[i]!)
      return screen.getByTestId('mock-request-details')
    }

    let d = await show(3)
    expect(within(d).getByTestId('mock-request-body').textContent).toBe('{\n  "name": "Ann",\n  "tags": [\n    "a"\n  ]\n}')
    expect(within(d).getByTestId('mock-response-status')).toHaveTextContent('201 Created')
    expect(within(d).getByTestId('mock-response-timing')).toHaveTextContent('Delay 40 ms · took 40 ms')

    d = await show(2)
    expect(within(d).getByTestId('mock-request-binary')).toHaveTextContent('Binary body (4 B), shown as base64.')
    expect(within(d).getByTestId('mock-request-body')).toHaveTextContent('//4AAQ==')

    d = await show(1)
    expect(within(d).getByTestId('mock-request-truncated')).toHaveTextContent('Truncated: the log keeps the first 64.0 KB of 64.0 KB')
    expect(within(d).getByTestId('mock-request-body').textContent).toHaveLength(MOCK_LOG_BODY_LIMIT)

    d = await show(0)
    expect(within(d).getByTestId('mock-response-status')).toHaveTextContent('404 Not Found')
    expect(within(d).getByTestId('mock-request-reason')).toHaveTextContent('No saved example matches DELETE /nothing.')
  })

  it('shows CORS preflights and refused requests', async () => {
    open()
    await startOn('4503')
    mock.mockServers.hit(ids.col, { method: 'OPTIONS', path: '/users', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST' } })
    mock.mockServers.hit(ids.col, { method: 'OPTIONS', path: '/users', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } })
    await waitFor(() => expect(screen.getAllByTestId('mock-log-row')).toHaveLength(2))
    const [refused, preflight] = screen.getAllByTestId('mock-log-row')
    expect(preflight).toHaveTextContent('CORS preflight')
    expect(preflight).toHaveTextContent('204')
    expect(refused).toHaveTextContent('refused')
    expect(refused).toHaveTextContent('403')

    await fireEvent.click(preflight!)
    let d = screen.getByTestId('mock-request-details')
    expect(within(d).getByTestId('mock-request-reason')).toHaveTextContent('A CORS preflight')
    expect(within(d).getByTestId('mock-request-reason')).toHaveTextContent('http://localhost:5173')
    expect(within(d).getByRole('table', { name: 'Response headers' })).toHaveTextContent('access-control-allow-originhttp://localhost:5173')

    await fireEvent.click(refused!)
    d = screen.getByTestId('mock-request-details')
    expect(within(d).getByTestId('mock-request-reason')).toHaveTextContent('Refused a CORS preflight from https://evil.example')
  })

  it('is keyboard accessible: Enter/Space select, arrows move', async () => {
    open()
    await startOn('4504')
    mock.mockServers.hit(ids.col, { path: '/users/1' })
    mock.mockServers.hit(ids.col, { path: '/users/2' })
    await waitFor(() => expect(screen.getAllByTestId('mock-log-row')).toHaveLength(2))
    const [newest, oldest] = screen.getAllByTestId('mock-log-row')
    expect(newest).toHaveAttribute('tabindex', '0')
    newest!.focus()
    await fireEvent.keyDown(newest!, { key: 'Enter' })
    expect(screen.getByTestId('mock-request-line')).toHaveTextContent('GET /users/2')
    await fireEvent.keyDown(newest!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(oldest)
    expect(screen.getByTestId('mock-request-line')).toHaveTextContent('GET /users/1')
    await fireEvent.keyDown(oldest!, { key: ' ' })
    expect(screen.queryByTestId('mock-request-details')).toBeNull()
  })
})
