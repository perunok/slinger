import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HttpResponseData, McpCallOutcome, McpClientEvent } from '../../../shared/types'
import { createMockBackend } from '../../dev/mockBackend'
import { scopeStore } from '../../app/scope.svelte'
import McpResultPane, { mcpErrorHeading, mcpOperationOf, mcpResultOf, mcpStatusOf } from './McpResultPane.svelte'

// The pane reads the message log through connections.svelte.ts; a plain fake keeps these tests about the pane.
const fake = vi.hoisted(() => ({ events: new Map<string, McpClientEvent[]>(), cleared: [] as string[], subscribed: 0 }))
vi.mock('./connections.svelte', () => ({
  mcpConnections: {
    subscribe: () => void fake.subscribed++,
    events: (id: string | null) => (id ? (fake.events.get(id) ?? []) : []),
    clearEvents: (id: string) => {
      fake.cleared.push(id)
      fake.events.delete(id)
    },
  },
}))

afterEach(cleanup)
beforeEach(() => {
  window.slinger = createMockBackend({ latencyMs: 0 })
  fake.events.clear()
  fake.cleared = []
})

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

/** The synthetic response executeDraft builds for an MCP call (spec section 6). */
function mcpResponse(operation: string, name: string | null, outcome: Partial<McpCallOutcome>): HttpResponseData {
  const o: McpCallOutcome = { ok: true, isError: false, result: null, error: null, durationMs: 42, ...outcome }
  const bodyText = JSON.stringify(o.result, null, 2)
  return {
    status: o.ok ? 200 : 500,
    statusText: o.ok ? 'OK' : 'Tool error',
    durationMs: 42,
    headers: [{ key: 'Content-Type', value: 'application/json' }],
    bodyText,
    bodyBase64: null,
    bodyByteLength: bodyText.length,
    mcp: { ...o, operation, name },
  }
}
const editorText = () => document.querySelector('.cm-content')?.textContent ?? ''
const tab = (name: string) => screen.getByRole('tab', { name: new RegExp(`^${name}`) })
const blocks = () => screen.getAllByTestId('mcp-block')

describe('result helpers', () => {
  it('reads the result, operation and status', () => {
    const res = mcpResponse('tools/call', 'echo', { result: { content: [] } })
    expect(mcpResultOf(res)).toEqual({ content: [] })
    expect(mcpResultOf({ ...res, mcp: undefined })).toEqual({ content: [] })
    expect(mcpResultOf(null)).toBeNull()
    expect(mcpOperationOf(res, { content: [] })).toBe('tools/call')
    expect(mcpOperationOf(null, { contents: [] })).toBe('resources/read')
    expect(mcpOperationOf(null, { messages: [] })).toBe('prompts/get')
    expect(mcpStatusOf(res, null)).toBe('ok')
    expect(mcpStatusOf(mcpResponse('tools/call', 'fail', { ok: false, isError: true }), null)).toBe('tool-error')
    expect(mcpStatusOf(mcpResponse('tools/call', 'x', { ok: false, error: { code: -1, message: 'no' } }), null)).toBe('error')
    expect(mcpStatusOf(null, 'boom')).toBe('error')
    expect(mcpStatusOf(null, null)).toBeNull()
    // The latest run failed: its error wins over an earlier run's response.
    expect(mcpStatusOf(res, 'boom')).toBe('error')
  })

  it('names who failed: the server, the call, or nothing ran', () => {
    expect(mcpErrorHeading({ code: -32602, message: 'Unknown tool' }, false)).toBe('The server returned an error')
    expect(mcpErrorHeading({ code: -32001, message: 'Request timed out', data: { timedOut: true } }, false)).toBe('The call failed')
    expect(mcpErrorHeading({ code: null, message: 'socket hang up' }, false)).toBe('The call failed')
    expect(mcpErrorHeading(null, false)).toBe('The request did not run')
  })
})

describe('McpResultPane', () => {
  it('shows the empty state before anything connected or ran', () => {
    render(McpResultPane, { response: null, error: null, sessionId: null })
    expect(screen.getByTestId('mcp-result-empty')).toHaveTextContent('Connect and run a tool, read a resource or get a prompt')
    expect(screen.queryByRole('tab')).toBeNull()
  })

  it('shows the tabs once connected, before a run', () => {
    render(McpResultPane, { response: null, error: null, sessionId: 's1' })
    expect(tab('Result')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('mcp-result-none')).toHaveTextContent('Nothing has run on this connection yet')
    expect(screen.queryByTestId('mcp-status-chip')).toBeNull()
    expect(fake.subscribed).toBeGreaterThan(0)
  })

  it('renders a tool result: status, duration, content blocks and structured content', () => {
    const res = mcpResponse('tools/call', 'add', {
      result: {
        content: [
          { type: 'text', text: 'The sum is 5' },
          { type: 'image', data: PNG, mimeType: 'image/png' },
        ],
        structuredContent: { sum: 5 },
      },
    })
    render(McpResultPane, { response: res, error: null, sessionId: 's1' })
    expect(screen.getByTestId('mcp-status-chip')).toHaveTextContent('OK')
    expect(screen.getByTestId('mcp-time-chip')).toHaveTextContent('42 ms')
    expect(screen.getByText('tools/call add')).toBeInTheDocument()
    expect(blocks().map((b) => b.dataset.kind)).toEqual(['text', 'image'])
    expect(blocks()[0]).toHaveTextContent('The sum is 5')
    expect(screen.getByRole('img')).toHaveAttribute('src', `data:image/png;base64,${PNG}`)
    const structured = screen.getByTestId('mcp-structured')
    expect(structured).toHaveTextContent('Structured content')
    expect(structured.querySelector('.cm-content')!.textContent).toContain('"sum": 5')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('says when a tool returned no content', () => {
    render(McpResultPane, { response: mcpResponse('tools/call', 'noop', { result: { content: [] } }), error: null, sessionId: 's1' })
    expect(screen.getByTestId('mcp-blocks-empty')).toHaveTextContent('The tool returned no content.')
    expect(screen.queryByTestId('mcp-structured')).toBeNull()
  })

  it('marks a tool result with isError and still shows its content', () => {
    const res = mcpResponse('tools/call', 'fail', { ok: false, isError: true, result: { content: [{ type: 'text', text: 'It broke' }], isError: true } })
    render(McpResultPane, { response: res, error: null, sessionId: 's1' })
    expect(screen.getByTestId('mcp-status-chip')).toHaveTextContent('Tool error')
    expect(screen.getByTestId('mcp-tool-error')).toHaveTextContent('The tool reported an error')
    expect(blocks()[0]).toHaveTextContent('It broke')
    expect(screen.queryByTestId('mcp-error')).toBeNull()
  })

  it('shows a run that failed (error prop) without a response', async () => {
    render(McpResultPane, { response: null, error: 'MCP error -32602: Unknown tool: nope', sessionId: 's1' })
    expect(screen.getByTestId('mcp-status-chip')).toHaveTextContent('Error')
    expect(screen.queryByTestId('mcp-time-chip')).toBeNull()
    const alert = screen.getByTestId('mcp-error')
    expect(alert).toHaveTextContent('The request did not run')
    expect(alert).toHaveTextContent('Unknown tool: nope')
    expect(screen.queryByTestId('mcp-result-none')).toBeNull()
    await fireEvent.click(tab('JSON'))
    expect(screen.getByText('There is no result: the run failed.')).toBeInTheDocument()
  })

  it('a failed run after a successful one shows the error, not the stale result', () => {
    const stale = mcpResponse('tools/call', 'echo', { result: { content: [{ type: 'text', text: 'old result' }] } })
    render(McpResultPane, { response: stale, error: 'Could not connect to the MCP server: refused', sessionId: 's1' })
    expect(screen.getByTestId('mcp-status-chip')).toHaveTextContent('Error')
    expect(screen.getByTestId('mcp-error')).toHaveTextContent('Could not connect to the MCP server: refused')
    expect(screen.queryByText('old result')).toBeNull()
    expect(screen.queryByTestId('mcp-time-chip')).toBeNull()
  })

  it('shows the JSON-RPC code and data of a failed call (errorDetail)', () => {
    render(McpResultPane, {
      response: null,
      error: 'Unknown tool: nope',
      errorDetail: { code: -32602, message: 'Unknown tool: nope', data: { hint: 'list tools' } },
      sessionId: 's1',
    })
    const alert = screen.getByTestId('mcp-error')
    expect(alert).toHaveTextContent('The server returned an error')
    expect(alert).toHaveTextContent('JSON-RPC error -32602')
    expect(alert).toHaveTextContent('"hint": "list tools"')
  })

  it('offers to create unresolved variables and shows the run warnings', async () => {
    const create = vi.fn()
    scopeStore.createVariable = create
    render(McpResultPane, { response: null, error: 'Unresolved variable: {{host}}.', unresolved: ['host'], sessionId: null })
    await fireEvent.click(screen.getByRole('button', { name: 'Create host' }))
    expect(create).toHaveBeenCalledWith('host')
    cleanup()
    const res = mcpResponse('tools/call', 'echo', { result: { content: [] } })
    render(McpResultPane, { response: res, error: null, sessionId: 's1', warnings: ['Auth type "hawk" is not supported; sent without authorization.'] })
    expect(screen.getByTestId('mcp-warnings')).toHaveTextContent('Auth type "hawk" is not supported')
  })

  it('shows the scripts\' tests and console output in their own views', async () => {
    const res = mcpResponse('tools/call', 'echo', { result: { content: [] } })
    const scripts = {
      tests: [
        { name: 'status is 200', status: 'passed' as const, error: null, source: 'Tests' },
        { name: 'has sum', status: 'failed' as const, error: 'expected 5', source: 'Tests' },
      ],
      console: [{ level: 'log' as const, message: 'hello from the test', timestamp: 1_700_000_000_000, source: 'Tests' }],
      errors: [],
      scriptCount: 1,
    }
    const onviewchange = vi.fn()
    render(McpResultPane, { response: res, error: null, sessionId: 's1', scripts, onviewchange })
    expect(screen.getByTestId('mcpres-tests-badge')).toHaveTextContent('1/2')
    await fireEvent.click(tab('Tests'))
    expect(onviewchange).toHaveBeenCalledWith('tests')
    expect(screen.getByTestId('tests-view')).toHaveTextContent('has sum')
    await fireEvent.click(tab('Console'))
    expect(screen.getByText('hello from the test')).toBeInTheDocument()
    cleanup()
    // Without script results, a stored Tests view falls back to the result.
    render(McpResultPane, { response: res, error: null, sessionId: 's1', view: 'tests' })
    expect(screen.queryByRole('tab', { name: /^Tests/ })).toBeNull()
    expect(tab('Result')).toHaveAttribute('aria-selected', 'true')
  })

  it('shows a protocol error carried in the response', () => {
    const res = mcpResponse('tools/call', 'nope', { ok: false, error: { code: -32602, message: 'Unknown tool: nope', data: { hint: 'list tools' } } })
    render(McpResultPane, { response: { ...res, bodyText: null }, error: null, sessionId: 's1' })
    const alert = screen.getByTestId('mcp-error')
    expect(alert).toHaveTextContent('The server returned an error')
    expect(alert).toHaveTextContent('Unknown tool: nope')
    expect(alert).toHaveTextContent('JSON-RPC error -32602')
    expect(alert).toHaveTextContent('"hint": "list tools"')
  })

  it('renders resource contents (text and blob)', () => {
    const res = mcpResponse('resources/read', 'demo://readme', {
      result: {
        contents: [
          { uri: 'demo://readme', mimeType: 'text/markdown', text: '# Demo server' },
          { uri: 'demo://logo.png', mimeType: 'image/png', blob: PNG },
        ],
      },
    })
    render(McpResultPane, { response: res, error: null, sessionId: 's1' })
    expect(blocks().map((b) => b.dataset.kind)).toEqual(['resource', 'resource'])
    expect(blocks()[0]).toHaveTextContent('# Demo server')
    expect(within(blocks()[1]).getByRole('img')).toHaveAttribute('src', `data:image/png;base64,${PNG}`)
  })

  it('renders prompt messages with their roles', () => {
    const res = mcpResponse('prompts/get', 'greet', {
      result: {
        description: 'A friendly greeting',
        messages: [
          { role: 'user', content: { type: 'text', text: 'Say hello to Ann' } },
          { role: 'assistant', content: { type: 'resource', resource: { uri: 'demo://readme', text: 'Hello' } } },
        ],
      },
    })
    render(McpResultPane, { response: res, error: null, sessionId: 's1' })
    expect(screen.getByTestId('mcp-prompt-description')).toHaveTextContent('A friendly greeting')
    const msgs = screen.getAllByTestId('mcp-prompt-message')
    expect(msgs).toHaveLength(2)
    expect(msgs[0]).toHaveTextContent('user')
    expect(msgs[0]).toHaveTextContent('Say hello to Ann')
    expect(msgs[1]).toHaveTextContent('assistant')
    expect(within(msgs[1]).getByTestId('mcp-block')).toHaveAttribute('data-kind', 'resource')
  })

  it('JSON shows the raw result read-only and reports the tab change', async () => {
    const onviewchange = vi.fn()
    const res = mcpResponse('tools/call', 'echo', { result: { content: [{ type: 'text', text: 'hi' }] } })
    render(McpResultPane, { response: res, error: null, sessionId: 's1', onviewchange })
    await fireEvent.click(tab('JSON'))
    expect(onviewchange).toHaveBeenCalledWith('json')
    expect(tab('JSON')).toHaveAttribute('aria-selected', 'true')
    expect(editorText()).toContain('"text": "hi"')
  })

  it('opens on the view it is given', () => {
    render(McpResultPane, { response: null, error: null, sessionId: 's1', view: 'logs' })
    expect(tab('Logs')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('mcp-logs-log')).toBeInTheDocument()
  })

  it('Messages and Logs show the session log from the connections registry; Clear empties it', async () => {
    let at = 1_700_000_000_000
    const e = (type: McpClientEvent['type'], payload: unknown): McpClientEvent => ({ sessionId: 's1', at: at++, type, payload })
    fake.events.set('s1', [
      e('send', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo' } }),
      e('notification', { method: 'notifications/message', params: { level: 'info', data: 'working' } }),
      e('receive', { jsonrpc: '2.0', id: 1, result: { content: [] } }),
      e('stderr', { text: 'debug output' }),
    ])
    fake.events.set('other', [e('send', { jsonrpc: '2.0', id: 9, method: 'ping' })])
    render(McpResultPane, { response: null, error: null, sessionId: 's1' })
    expect(screen.getByTestId('mcpres-messages-badge')).toHaveTextContent('4')
    expect(screen.getByTestId('mcpres-logs-badge')).toHaveTextContent('2')
    await fireEvent.click(tab('Messages'))
    const log = screen.getByTestId('mcp-messages-log')
    expect(within(log).getAllByTestId('mcp-log-row')).toHaveLength(4)
    expect(log).not.toHaveTextContent('ping')
    await fireEvent.click(tab('Logs'))
    const logs = screen.getByTestId('mcp-logs-log')
    expect(within(logs).getAllByTestId('mcp-log-row').map((r) => r.textContent)).toEqual([expect.stringContaining('working'), expect.stringContaining('debug output')])
    expect(within(logs).queryByRole('button', { name: /Clear/ })).toBeNull()
    await fireEvent.click(tab('Messages'))
    await fireEvent.click(screen.getByRole('button', { name: 'Clear messages' }))
    expect(fake.cleared).toEqual(['s1'])
  })
})
