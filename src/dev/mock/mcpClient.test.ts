import { beforeEach, describe, expect, it } from 'vitest'
import type { McpCallInput, McpClientEvent, McpConnectInput } from '../../../shared/types'
import { createMockBackend } from '../mockBackend'

let api: ReturnType<typeof createMockBackend>
let events: McpClientEvent[]
let wsId: string

beforeEach(async () => {
  api = createMockBackend({ latencyMs: 0, seed: false })
  events = []
  api.onMcpClientEvent((e) => events.push(e))
  wsId = (await api.createWorkspace('W')).id
})

const http = (overrides: Partial<McpConnectInput> = {}): McpConnectInput => ({
  workspaceId: wsId,
  transport: 'http',
  url: 'http://localhost:3001/mcp',
  headers: [{ key: 'Authorization', value: 'Bearer secret' }],
  origin: 'user',
  ...overrides,
})

const stdio = (overrides: Partial<McpConnectInput> = {}): McpConnectInput => ({
  workspaceId: wsId,
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-everything'],
  cwd: '',
  origin: 'user',
  ...overrides,
})

let runCount = 0
const call = (sessionId: string, overrides: Partial<McpCallInput> = {}): McpCallInput => ({
  sessionId,
  operation: 'tools/call',
  name: 'echo',
  arguments: { text: 'hi' },
  requestRunId: `run-${++runCount}`,
  workspaceId: wsId,
  historyUrl: '{{baseUrl}}/mcp',
  ...overrides,
})

const rejection = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    expect(e).toMatchObject({ name: 'IpcError' })
    return e as { code: string; message: string; details?: Record<string, unknown> }
  }
  throw new Error('expected rejection')
}

const of = (sessionId: string) => events.filter((e) => e.sessionId === sessionId)
const methods = (sessionId: string) =>
  of(sessionId).map((e) => {
    const p = e.payload as { method?: string; id?: number; text?: string; message?: string }
    return `${e.type} ${p.method ?? (p.id !== undefined ? `#${p.id}` : (p.text ?? p.message ?? ''))}`.trim()
  })

describe('connect and list', () => {
  it('connects over http and logs the initialize handshake', async () => {
    const info = await api.mcpClientConnect(http())
    expect(info).toMatchObject({
      sessionId: 'mock-mcp-session-1',
      serverInfo: { name: 'demo-mcp-server', version: '1.0.0', title: 'Demo MCP server' },
      protocolVersion: '2025-11-25',
      capabilities: { tools: { listChanged: true }, logging: {} },
    })
    expect(info.instructions).toContain('# Demo MCP server')
    expect(info.connectMs).toBeGreaterThan(0)
    expect(methods(info.sessionId)).toEqual(['send initialize', 'receive #0', 'send notifications/initialized'])
    expect(of(info.sessionId)[0].payload).toMatchObject({ jsonrpc: '2.0', id: 0, params: { clientInfo: { name: 'slinger' }, capabilities: {} } })
    // Header values never appear in the message log.
    expect(JSON.stringify(events)).not.toContain('secret')
    expect(api.mcpClient.sessions()).toEqual([info.sessionId])
  })

  it('lists tools with JSON Schemas, resources, templates and prompts', async () => {
    const { sessionId } = await api.mcpClientConnect(http())
    const tools = await api.mcpClientList(sessionId, 'tools')
    expect(tools.truncated).toBe(false)
    expect(tools.items.map((t) => t.name)).toEqual(['echo', 'add', 'get_weather', 'create_user', 'content_types', 'fail', 'slow'])
    expect(tools.items.find((t) => t.name === 'get_weather')).toMatchObject({
      inputSchema: { type: 'object', properties: { city: { type: 'string', enum: ['Berlin', 'London', 'Tokyo', 'New York'] } }, required: ['city'] },
    })
    expect(tools.items.find((t) => t.name === 'add')?.outputSchema).toBeTruthy()
    expect((await api.mcpClientList(sessionId, 'resources')).items.map((r) => r.uri)).toEqual(['demo://readme', 'demo://logo.png'])
    expect((await api.mcpClientList(sessionId, 'resourceTemplates')).items).toEqual([expect.objectContaining({ uriTemplate: 'demo://users/{id}' })])
    expect((await api.mcpClientList(sessionId, 'prompts')).items).toEqual([expect.objectContaining({ name: 'greet' })])
    expect(methods(sessionId).slice(3)).toEqual([
      'send tools/list', 'receive #1',
      'send resources/list', 'receive #2',
      'send resources/templates/list', 'receive #3',
      'send prompts/list', 'receive #4',
    ])
  })

  it('rejects an unknown session, a bad URL and an unreachable host', async () => {
    expect(await rejection(api.mcpClientList('nope', 'tools'))).toMatchObject({ code: 'not_found' })
    expect(await rejection(api.mcpClientCall(call('nope')))).toMatchObject({ code: 'not_found' })
    expect(await rejection(api.mcpClientConnect(http({ url: 'ftp://x/mcp' })))).toMatchObject({ code: 'invalid_input' })
    expect(await rejection(api.mcpClientConnect(http({ url: 'http://down.invalid/mcp' })))).toMatchObject({ code: 'network_error' })
  })

  it('rejects unresolved {{variables}} like main', async () => {
    const e = await rejection(api.mcpClientConnect(http({ url: 'http://{{host}}/mcp' })))
    expect(e).toMatchObject({ code: 'invalid_input', message: 'Unresolved variable in URL: define it in the active environment' })
    expect(await rejection(api.mcpClientConnect(http({ headers: [{ key: 'X', value: '{{token}}' }] })))).toMatchObject({ code: 'invalid_input' })
    const { sessionId } = await api.mcpClientConnect(http())
    expect(await rejection(api.mcpClientCall(call(sessionId, { arguments: { text: { deep: ['{{x}}'] } } })))).toMatchObject({ code: 'invalid_input' })
  })

  it('closes the oldest session beyond 20', async () => {
    const first = await api.mcpClientConnect(http())
    for (let i = 0; i < 20; i++) await api.mcpClientConnect(http())
    expect(api.mcpClient.sessions()).toHaveLength(20)
    expect(api.mcpClient.sessions()).not.toContain(first.sessionId)
    expect(of(first.sessionId).at(-1)).toMatchObject({ type: 'closed', payload: { message: 'Connection closed' } })
  })
})

describe('tools', () => {
  it('calls echo, logs request, server log and response, and writes History', async () => {
    const { sessionId } = await api.mcpClientConnect(http())
    const outcome = await api.mcpClientCall(call(sessionId, { requestId: 'req-1', requestName: 'Echo it', historySource: 'mcp' }))
    expect(outcome).toMatchObject({ ok: true, isError: false, error: null, result: { content: [{ type: 'text', text: 'hi' }] } })
    expect(outcome.durationMs).toBeGreaterThan(0)
    expect(methods(sessionId).slice(3)).toEqual(['send tools/call', 'notification notifications/message', 'receive #1'])
    expect(of(sessionId)[3].payload).toEqual({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } })
    expect(of(sessionId)[4].payload).toEqual({ method: 'notifications/message', params: { level: 'info', logger: 'demo-mcp-server', data: 'Tool echo called' } })
    const [row] = await api.listHistory(wsId)
    expect(row).toMatchObject({
      method: 'MCP',
      url: '{{baseUrl}}/mcp',
      requestId: 'req-1',
      requestName: 'Echo it',
      statusCode: null,
      ok: true,
      errorMessage: null,
      kind: 'send',
      source: 'mcp',
      detail: 'tools/call echo',
    })
  })

  it('returns structured content and deterministic data', async () => {
    const { sessionId } = await api.mcpClientConnect(http())
    expect((await api.mcpClientCall(call(sessionId, { name: 'add', arguments: { a: 2, b: 3.5 } }))).result).toEqual({
      content: [{ type: 'text', text: '5.5' }],
      structuredContent: { sum: 5.5 },
    })
    const weather = await api.mcpClientCall(call(sessionId, { name: 'get_weather', arguments: { city: 'Tokyo', units: 'imperial' } }))
    expect(weather.result?.structuredContent).toEqual({ city: 'Tokyo', temperature: 75, units: 'imperial', conditions: 'Sunny', humidity: 55 })
    const user = await api.mcpClientCall(
      call(sessionId, { name: 'create_user', arguments: { name: 'Ana', email: 'ana@example.com', tags: ['a'], address: { city: 'Ljubljana' } } }),
    )
    expect(user.result?.structuredContent).toMatchObject({ id: 1001, role: 'viewer', newsletter: false, address: { city: 'Ljubljana' } })
  })

  it('returns one block of every content type', async () => {
    const { sessionId } = await api.mcpClientConnect(http())
    const outcome = await api.mcpClientCall(call(sessionId, { name: 'content_types', arguments: {} }))
    const content = outcome.result?.content as Array<{ type: string; data?: string; mimeType?: string }>
    expect(content.map((b) => b.type)).toEqual(['text', 'image', 'audio', 'resource_link', 'resource', 'resource'])
    expect(atob(content[2].data ?? '').slice(0, 4)).toBe('RIFF')
    expect(atob(content[1].data ?? '').slice(1, 4)).toBe('PNG')
  })

  it('reports tool errors, invalid arguments and unknown tools as isError results', async () => {
    const { sessionId } = await api.mcpClientConnect(http())
    const failed = await api.mcpClientCall(call(sessionId, { name: 'fail', arguments: {} }))
    expect(failed).toMatchObject({ ok: false, isError: true, error: null, result: { isError: true } })
    expect(of(sessionId).some((e) => e.type === 'notification' && (e.payload as { params: { level: string } }).params.level === 'error')).toBe(true)
    expect((await api.listHistory(wsId))[0]).toMatchObject({ ok: false, errorMessage: 'The tool returned an error', detail: 'tools/call fail' })

    const invalid = await api.mcpClientCall(call(sessionId, { name: 'add', arguments: { a: 'x', b: 1 } }))
    expect(invalid).toMatchObject({ ok: false, isError: true })
    expect(JSON.stringify(invalid.result)).toContain('Invalid arguments for tool add: a: Expected number, received string')
    const missing = await api.mcpClientCall(call(sessionId, { name: 'get_weather', arguments: { city: 'Paris' } }))
    expect(JSON.stringify(missing.result)).toContain("city: Invalid enum value. Expected 'Berlin' | 'London' | 'Tokyo' | 'New York'")
    const unknown = await api.mcpClientCall(call(sessionId, { name: 'nope', arguments: {} }))
    expect(JSON.stringify(unknown.result)).toContain('Tool nope not found')
  })

  it('cancels slow and tells the server', async () => {
    const { sessionId } = await api.mcpClientConnect(http())
    const pending = api.mcpClientCall(call(sessionId, { name: 'slow', arguments: { ms: 60_000 }, requestRunId: 'slow-1' }))
    await api.mcpClientCancel('slow-1')
    const outcome = await pending
    expect(outcome).toMatchObject({ ok: false, isError: false, result: null, error: { code: null, message: 'Request cancelled' } })
    expect(of(sessionId).at(-1)).toMatchObject({
      type: 'send',
      payload: { method: 'notifications/cancelled', params: { requestId: 1, reason: 'Request cancelled' } },
    })
    expect((await api.listHistory(wsId))[0]).toMatchObject({ ok: false, errorMessage: 'Request cancelled', detail: 'tools/call slow' })
    await api.mcpClientCancel('slow-1') // already done: no-op
  })

  it('times out slow and finishes a short wait', async () => {
    const { sessionId } = await api.mcpClientConnect(http())
    const timedOut = await api.mcpClientCall(call(sessionId, { name: 'slow', arguments: { ms: 60_000 }, timeoutMs: 20 }))
    expect(timedOut.error).toMatchObject({ code: -32001, message: 'Request timed out after 20 ms' })
    const done = await api.mcpClientCall(call(sessionId, { name: 'slow', arguments: { ms: 5 } }))
    expect(done).toMatchObject({ ok: true, result: { content: [{ type: 'text', text: 'Waited 5 ms' }] } })
  })
})

describe('resources and prompts', () => {
  it('reads text, blob and template resources; an unknown URI is a protocol error', async () => {
    const { sessionId } = await api.mcpClientConnect(http())
    const readme = await api.mcpClientCall(call(sessionId, { operation: 'resources/read', name: undefined, arguments: undefined, uri: 'demo://readme' }))
    expect(readme.result).toMatchObject({ contents: [{ uri: 'demo://readme', mimeType: 'text/markdown', text: expect.stringContaining('# Demo') }] })
    const logo = await api.mcpClientCall(call(sessionId, { operation: 'resources/read', uri: 'demo://logo.png' }))
    expect(logo.result).toMatchObject({ contents: [{ mimeType: 'image/png', blob: expect.any(String) }] })
    const user = await api.mcpClientCall(call(sessionId, { operation: 'resources/read', uri: 'demo://users/42' }))
    expect(JSON.parse((user.result?.contents as Array<{ text: string }>)[0].text)).toEqual({ id: '42', name: 'Douglas Adams' })
    expect((await api.listHistory(wsId))[0].detail).toBe('resources/read')
    await api.mcpClientCall(call(sessionId, { operation: 'resources/read', uri: 'demo://users/42', historyDetail: 'resources/read demo://users/{{id}}' }))
    expect((await api.listHistory(wsId))[0].detail).toBe('resources/read demo://users/{{id}}')

    const missing = await api.mcpClientCall(call(sessionId, { operation: 'resources/read', uri: 'demo://nope' }))
    expect(missing).toMatchObject({ ok: false, isError: false, result: null, error: { code: -32602, message: 'Resource demo://nope not found' } })
    expect(of(sessionId).at(-1)).toMatchObject({ type: 'receive', payload: { error: { code: -32602 } } })
  })

  it('gets a prompt; a missing required argument is a protocol error', async () => {
    const { sessionId } = await api.mcpClientConnect(http())
    const greet = await api.mcpClientCall(call(sessionId, { operation: 'prompts/get', name: 'greet', arguments: { name: 'Ana', style: 'formal' } }))
    expect(greet.result).toEqual({
      description: 'A greeting',
      messages: [{ role: 'user', content: { type: 'text', text: 'Please greet Ana in a formal way.' } }],
    })
    expect((await api.listHistory(wsId))[0].detail).toBe('prompts/get greet')
    const missing = await api.mcpClientCall(call(sessionId, { operation: 'prompts/get', name: 'greet', arguments: {} }))
    expect(missing).toMatchObject({ ok: false, error: { code: -32602 } })
  })

  it('writes no History row for an unknown workspace', async () => {
    const { sessionId } = await api.mcpClientConnect(http())
    await api.mcpClientCall(call(sessionId, { workspaceId: '00000000-0000-4000-8000-000000000000' }))
    expect(await api.listHistory(wsId)).toEqual([])
  })
})

describe('stdio trust', () => {
  it('refuses a command until it is allowed, for every origin', async () => {
    const e = await rejection(api.mcpClientConnect(stdio()))
    expect(e).toMatchObject({
      code: 'invalid_input',
      message: 'This command has not been allowed on this device yet.',
      details: { reason: 'untrusted_command', command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'], cwd: '', env: [] },
    })
    await api.mcpClientTrustCommand({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'], cwd: '', env: [] })
    expect(api.mcpClient.trusted()).toEqual([expect.objectContaining({ command: 'npx', cwd: '' })])

    const info = await api.mcpClientConnect(stdio({ origin: 'runner' }))
    expect(of(info.sessionId).at(-1)).toMatchObject({ type: 'stderr', payload: { text: expect.stringContaining('running on stdio') } })
    // Another cwd or other args are another command.
    expect(await rejection(api.mcpClientConnect(stdio({ cwd: '/tmp' })))).toMatchObject({ details: { reason: 'untrusted_command' } })
    expect(await rejection(api.mcpClientConnect(stdio({ args: ['-y'], origin: 'mcp' })))).toMatchObject({ details: { reason: 'untrusted_command' } })
    // So is extra environment (NODE_OPTIONS and the like change what runs).
    expect(await rejection(api.mcpClientConnect(stdio({ env: [{ key: 'NODE_OPTIONS', value: '--require=x' }] })))).toMatchObject({
      details: { reason: 'untrusted_command', env: [{ key: 'NODE_OPTIONS', value: '--require=x' }] },
    })

    api.mcpClient.clearTrusted()
    expect(await rejection(api.mcpClientConnect(stdio()))).toMatchObject({ details: { reason: 'untrusted_command' } })
  })

  it('allowing the same command twice keeps one entry; reset forgets everything', async () => {
    const cmd = { command: 'node', args: ['server.js'], cwd: '/srv', env: [] }
    await api.mcpClientTrustCommand(cmd)
    await api.mcpClientTrustCommand(cmd)
    expect(api.mcpClient.trusted()).toHaveLength(1)
    await api.mcpClientConnect(stdio(cmd))
    api.reset()
    expect(api.mcpClient.trusted()).toEqual([])
    expect(api.mcpClient.sessions()).toEqual([])
    expect((await api.mcpClientConnect(http({ workspaceId: (await api.createWorkspace('X')).id }))).sessionId).toBe('mock-mcp-session-1')
  })
})

describe('closing', () => {
  it('disconnect closes the session and ends its running calls', async () => {
    const { sessionId } = await api.mcpClientConnect(http())
    const pending = api.mcpClientCall(call(sessionId, { name: 'slow', arguments: { ms: 60_000 } }))
    await api.mcpClientDisconnect(sessionId)
    expect(await pending).toMatchObject({ ok: false, error: { code: -32000, message: 'Connection closed' } })
    expect(of(sessionId).at(-1)).toMatchObject({ type: 'closed', payload: { message: 'Connection closed' } })
    expect(await rejection(api.mcpClientCall(call(sessionId)))).toMatchObject({ code: 'not_found' })
    await api.mcpClientDisconnect(sessionId) // unknown: no-op
  })

  it('controls push notifications and drop sessions', async () => {
    const a = await api.mcpClientConnect(http())
    const b = await api.mcpClientConnect(http())
    api.mcpClient.notify('notifications/tools/list_changed')
    api.mcpClient.notify('notifications/message', { level: 'warning', data: 'hm' }, b.sessionId)
    expect(methods(a.sessionId).at(-1)).toBe('notification notifications/tools/list_changed')
    expect(of(b.sessionId).at(-1)?.payload).toEqual({ method: 'notifications/message', params: { level: 'warning', data: 'hm' } })
    api.mcpClient.dropSession(a.sessionId, 'Server exited')
    expect(of(a.sessionId).at(-1)).toMatchObject({ type: 'closed', payload: { message: 'Server exited' } })
    expect(api.mcpClient.sessions()).toEqual([b.sessionId])
  })

  it('unsubscribes listeners', async () => {
    const seen: McpClientEvent[] = []
    const off = api.onMcpClientEvent((e) => seen.push(e))
    off()
    await api.mcpClientConnect(http())
    expect(seen).toEqual([])
  })
})
