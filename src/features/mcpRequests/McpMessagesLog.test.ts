import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpClientEvent } from '../../../shared/types'
import McpMessagesLog, { logRows, messageRows } from './McpMessagesLog.svelte'

afterEach(cleanup)

let t = Date.UTC(2026, 0, 1, 10, 0, 0)
const ev = (type: McpClientEvent['type'], payload: unknown): McpClientEvent => ({ sessionId: 's1', at: t++, type, payload })

const EVENTS: McpClientEvent[] = [
  ev('send', { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
  ev('receive', { jsonrpc: '2.0', id: 0, result: { serverInfo: { name: 'demo' } } }),
  ev('send', { jsonrpc: '2.0', method: 'notifications/initialized' }),
  ev('send', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } }),
  ev('notification', { method: 'notifications/message', params: { level: 'warning', logger: 'demo', data: 'disk almost full' } }),
  ev('receive', { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'hi' }] } }),
  ev('send', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nope' } }),
  ev('receive', { jsonrpc: '2.0', id: 2, error: { code: -32602, message: 'Unknown tool: nope' } }),
  ev('stderr', { text: 'server listening\n' }),
  ev('closed', { message: 'The server closed the connection.' }),
]

const rows = () => screen.queryAllByTestId('mcp-log-row')

describe('messageRows / logRows', () => {
  it('labels responses with the method of their request and classifies events', () => {
    const r = messageRows(EVENTS)
    expect(r.map((x) => [x.dir, x.category, x.title, x.detail])).toEqual([
      ['out', 'rpc', 'initialize', '#0'],
      ['in', 'rpc', 'initialize', '#0 result'],
      ['out', 'notification', 'notifications/initialized', 'notification'],
      ['out', 'rpc', 'tools/call', '#1'],
      ['in', 'notification', 'notifications/message', 'warning'],
      ['in', 'rpc', 'tools/call', '#1 result'],
      ['out', 'rpc', 'tools/call', '#2'],
      ['in', 'rpc', 'tools/call', '#2 error -32602 Unknown tool: nope'],
      ['none', 'stderr', 'stderr', 'server listening'],
      ['none', 'connection', 'Connection closed', 'The server closed the connection.'],
    ])
    expect(r[7].tone).toBe('danger')
  })

  it('keeps one row when a notification arrives both as a raw message and as a notification event', () => {
    const raw = ev('receive', { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: { n: 1 } } })
    const note = ev('notification', { method: 'notifications/message', params: { level: 'info', data: { n: 1 } } })
    expect(messageRows([raw, note]).map((x) => x.event)).toEqual([raw])
    expect(logRows([raw, note]).map((x) => x.event)).toEqual([note])
    // Without the twin the raw message is a log line too.
    expect(logRows([raw]).map((x) => [x.title, x.detail])).toEqual([['info', '{"n":1}']])
  })

  it('logs only server log messages and stderr', () => {
    expect(logRows(EVENTS).map((x) => [x.title, x.detail, x.tone])).toEqual([
      ['warning', '[demo] disk almost full', 'warning'],
      ['stderr', 'server listening', 'muted'],
    ])
  })
})

describe('McpMessagesLog', () => {
  it('shows the empty state', () => {
    render(McpMessagesLog, { props: { events: [], mode: 'messages' } })
    expect(screen.getByText(/No messages yet/)).toBeInTheDocument()
    cleanup()
    render(McpMessagesLog, { props: { events: [], mode: 'logs' } })
    expect(screen.getByText('No server logs yet.')).toBeInTheDocument()
  })

  it('renders every event with direction, method and time, and expands one to its JSON', async () => {
    render(McpMessagesLog, { props: { events: EVENTS, mode: 'messages' } })
    expect(rows()).toHaveLength(EVENTS.length)
    expect(screen.getByTestId('mcp-messages-count')).toHaveTextContent('10 messages')
    const first = rows()[0]
    expect(first).toHaveTextContent('Sent')
    expect(first).toHaveTextContent('initialize')
    expect(first).toHaveTextContent(/\d\d:\d\d:\d\d\.\d{3}/)
    expect(rows()[1]).toHaveTextContent('Received')
    const toggle = within(rows()[3]).getAllByRole('button')[0]
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(rows()[3].querySelector('pre')).toBeNull()
    await fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(rows()[3].querySelector('pre')!.textContent).toContain('"name": "echo"')
    await fireEvent.click(toggle)
    expect(rows()[3].querySelector('pre')).toBeNull()
  })

  it('filters by category and by text', async () => {
    render(McpMessagesLog, { props: { events: EVENTS, mode: 'messages' } })
    const select = screen.getByLabelText('Show')
    await fireEvent.change(select, { target: { value: 'notification' } })
    expect(rows().map((r) => r.dataset.type)).toEqual(['send', 'notification'])
    await fireEvent.change(select, { target: { value: 'stderr' } })
    expect(rows().map((r) => r.dataset.type)).toEqual(['stderr'])
    await fireEvent.change(select, { target: { value: 'connection' } })
    expect(rows().map((r) => r.dataset.type)).toEqual(['closed'])
    await fireEvent.change(select, { target: { value: 'all' } })
    // Text matches the method, the summary, or anything in the message JSON.
    await fireEvent.input(screen.getByLabelText('Filter messages'), { target: { value: 'ECHO' } })
    expect(rows()).toHaveLength(1)
    expect(screen.getByTestId('mcp-messages-count')).toHaveTextContent('1 of 10 messages')
    await fireEvent.input(screen.getByLabelText('Filter messages'), { target: { value: 'zzz' } })
    expect(screen.getByText('No messages match the filter.')).toBeInTheDocument()
  })

  it('Logs shows the server log and stderr, filterable by source', async () => {
    render(McpMessagesLog, { props: { events: EVENTS, mode: 'logs' } })
    expect(rows()).toHaveLength(2)
    expect(rows()[0]).toHaveTextContent('warning')
    expect(rows()[0]).toHaveTextContent('[demo] disk almost full')
    expect(rows()[1]).toHaveTextContent('server listening')
    await fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'stderr' } })
    expect(rows().map((r) => r.dataset.type)).toEqual(['stderr'])
  })

  it('Clear calls back and is disabled when there is nothing to clear', async () => {
    const onclear = vi.fn()
    render(McpMessagesLog, { props: { events: EVENTS, mode: 'messages', onclear } })
    await fireEvent.click(screen.getByRole('button', { name: 'Clear messages' }))
    expect(onclear).toHaveBeenCalledOnce()
    cleanup()
    render(McpMessagesLog, { props: { events: [], mode: 'logs', onclear } })
    expect(screen.getByRole('button', { name: 'Clear logs' })).toBeDisabled()
  })
})
