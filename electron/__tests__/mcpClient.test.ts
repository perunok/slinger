import { randomUUID } from 'node:crypto'
import { createServer, type Server as HttpServer, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  ErrorCode,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { McpCallInput, McpClientEvent, McpConnectInput } from '../../shared/types'
import { openDatabase } from '../db/database'
import { createIpcApi } from '../ipc/api'
import { commandFingerprint, IDLE_MS, MAX_LIST_ITEMS, MAX_SESSIONS, McpClientService, STDERR_CAP_BYTES, TRUSTED_COMMANDS_KEY } from '../mcpClient/service'
import { InlineExecutor } from '../scripts/inline'
import { createCore, type Core } from '../services/core'
import { MemorySecretStore } from '../services/secrets'
import { getSetting } from '../sync/store'
import { MIGRATIONS_DIR, NIL_UUID } from './helpers'

// The MCP client (electron/mcpClient) against real SDK servers: Streamable HTTP and SSE on 127.0.0.1, and a stdio child
// process (fixtures/mcp-stdio-server.mjs). Calls go through the IPC layer (validation included) like the window's.

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-stdio-server.mjs', import.meta.url))

// ---------------------------------------------------------------------------------------------------------------------
// Test servers

/** The demo server: tools, resources, a resource template, a prompt, logging. One instance per session. */
function demoServer(log: { aborted: string[] }): McpServer {
  const server = new McpServer({ name: 'demo', version: '1.2.3', title: 'Demo server' }, { capabilities: { logging: {} }, instructions: 'Use echo.' })
  server.registerTool('echo', { description: 'Echoes text', inputSchema: { text: z.string() } }, async ({ text }) => ({
    content: [{ type: 'text', text }],
  }))
  server.registerTool(
    'add',
    { inputSchema: { a: z.number(), b: z.number() }, outputSchema: { sum: z.number() } },
    async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }], structuredContent: { sum: a + b } }),
  )
  server.registerTool('fail', { description: 'Always fails' }, async () => ({ content: [{ type: 'text', text: 'it broke' }], isError: true }))
  server.registerTool('slow', { inputSchema: { ms: z.number() } }, async ({ ms }, extra) => {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      extra.signal.addEventListener('abort', () => {
        clearTimeout(timer)
        log.aborted.push(String(extra.requestId))
        resolve()
      })
    })
    return { content: [{ type: 'text', text: 'done' }] }
  })
  server.registerTool('notify', {}, async (extra) => {
    await extra.sendNotification({ method: 'notifications/message', params: { level: 'info', data: 'hello log' } })
    const progressToken = extra._meta?.progressToken
    if (progressToken !== undefined) {
      await extra.sendNotification({ method: 'notifications/progress', params: { progressToken, progress: 1, total: 2 } })
    }
    return { content: [{ type: 'text', text: 'notified' }] }
  })
  server.registerResource('readme', 'demo://readme', { mimeType: 'text/plain' }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'Read me' }],
  }))
  server.registerResource('user', new ResourceTemplate('demo://users/{id}', { list: undefined }), {}, async (uri, { id }) => ({
    contents: [{ uri: uri.href, text: `user ${String(id)}` }],
  }))
  server.registerPrompt('greet', { argsSchema: { name: z.string() } }, ({ name }) => ({
    messages: [{ role: 'user', content: { type: 'text', text: `Hello ${name}` } }],
  }))
  return server
}

/** Low-level server: 1500 paginated tools, 250 paginated prompts, a tools/call that fails with a JSON-RPC error. */
function pagedServer(): Server {
  const server = new Server({ name: 'paged', version: '1' }, { capabilities: { tools: {}, prompts: {} } })
  const page = <T>(all: T[], cursor: string | undefined, size: number) => {
    const start = cursor ? Number(cursor) : 0
    const next = start + size
    return { items: all.slice(start, next), nextCursor: next < all.length ? String(next) : undefined }
  }
  const tools = Array.from({ length: 1500 }, (_, i) => ({ name: `tool${i}`, inputSchema: { type: 'object' as const } }))
  const prompts = Array.from({ length: 250 }, (_, i) => ({ name: `prompt${i}` }))
  server.setRequestHandler(ListToolsRequestSchema, async (req) => {
    const p = page(tools, req.params?.cursor, 400)
    return { tools: p.items, nextCursor: p.nextCursor }
  })
  server.setRequestHandler(ListPromptsRequestSchema, async (req) => {
    const p = page(prompts, req.params?.cursor, 100)
    return { prompts: p.items, nextCursor: p.nextCursor }
  })
  server.setRequestHandler(CallToolRequestSchema, async () => {
    throw new McpError(ErrorCode.InvalidParams, 'Bad things', { hint: 'try again' })
  })
  return server
}

/** Declares resources but implements only resources/list (no resources/templates/list), like many low-level servers. */
function noTemplatesServer(): Server {
  const server = new Server({ name: 'no-templates', version: '1' }, { capabilities: { resources: {} } })
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: 'demo://only', name: 'only' }] }))
  return server
}

interface TestServer {
  url: string
  /** Authorization headers the server received. */
  auth: Array<string | undefined>
  /** Streamable HTTP sessions ended with DELETE. */
  deleted: string[]
  aborted: string[]
  close(): Promise<void>
}

async function startServer(): Promise<TestServer> {
  const streamable = new Map<string, StreamableHTTPServerTransport>()
  const sse = new Map<string, SSEServerTransport>()
  const sockets = new Set<Socket>()
  const hanging: ServerResponse[] = []
  const state = { auth: [] as Array<string | undefined>, deleted: [] as string[], aborted: [] as string[] }
  const http: HttpServer = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname
      state.auth.push(req.headers.authorization)
      if (path === '/mcp' || path === '/paged' || path === '/notemplates') {
        const sid = req.headers['mcp-session-id']
        if (req.method === 'DELETE' && typeof sid === 'string') state.deleted.push(sid)
        let transport = typeof sid === 'string' ? streamable.get(sid) : undefined
        if (!transport) {
          if (sid) return void res.writeHead(404).end()
          const t = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized: (id) => void streamable.set(id, t) })
          await (path === '/mcp' ? demoServer(state) : path === '/paged' ? pagedServer() : noTemplatesServer()).connect(t)
          transport = t
        }
        await transport.handleRequest(req, res)
      } else if (path === '/sse' && req.method === 'GET') {
        const t = new SSEServerTransport('/messages', res)
        sse.set(t.sessionId, t)
        await demoServer(state).connect(t)
      } else if (path === '/messages' && req.method === 'POST') {
        const t = sse.get(new URL(req.url ?? '/', 'http://localhost').searchParams.get('sessionId') ?? '')
        if (!t) return void res.writeHead(404).end()
        await t.handlePostMessage(req, res)
      } else if (path === '/hang') {
        hanging.push(res) // never answers
      } else {
        res.writeHead(404).end()
      }
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500).end()
    })
  })
  http.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const { port } = http.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    ...state,
    async close() {
      for (const s of sockets) s.destroy()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Environment

let core: Core
let api: ReturnType<typeof createIpcApi>
let events: McpClientEvent[]
let clock: number
let server: TestServer
let workspaceId: string

beforeEach(async () => {
  const db = openDatabase(':memory:')
  events = []
  clock = 1_700_000_000_000
  core = createCore({
    db,
    secrets: new MemorySecretStore(),
    migrationsDir: MIGRATIONS_DIR,
    scriptExecutor: new InlineExecutor(),
    mcpClient: { emit: (e) => void events.push(e), now: () => clock, appVersion: '9.9.9' },
  })
  api = createIpcApi(core, {
    appVersion: '0.0.0-test',
    openExternal: async () => {},
    chooseDirectory: async () => null,
    pickFile: async () => null,
  })
  workspaceId = (await api.createWorkspace('MCP')).id
  server = await startServer()
})
afterEach(async () => {
  await core.mcpClient.closeAll()
  await server.close()
  core.db.close()
})

const service = () => core.mcpClient as McpClientService

const http = (over: Partial<McpConnectInput> = {}): McpConnectInput => ({
  workspaceId,
  transport: 'http',
  url: `${server.url}/mcp`,
  headers: [{ key: 'Authorization', value: 'Bearer s3cret-token' }],
  origin: 'user',
  ...over,
})
const stdio = (over: Partial<McpConnectInput> = {}): McpConnectInput => ({
  workspaceId,
  transport: 'stdio',
  command: process.execPath,
  args: [FIXTURE],
  env: [{ key: 'FIXTURE_GREETING', value: 'hi' }],
  cwd: '',
  origin: 'user',
  ...over,
})
const trust = (input: McpConnectInput) =>
  api.mcpClientTrustCommand({ command: input.command!, args: input.args ?? [], cwd: input.cwd ?? '', env: input.env ?? [] })
let runs = 0
const call = (sessionId: string, over: Partial<McpCallInput> = {}): McpCallInput => ({
  sessionId,
  operation: 'tools/call',
  name: 'echo',
  arguments: { text: 'hello' },
  requestRunId: `run-${++runs}`,
  workspaceId,
  historyUrl: '{{base}}/mcp',
  ...over,
})
const text = (result: Record<string, unknown> | null) => (result?.content as Array<{ text?: string }> | undefined)?.[0]?.text
const ofSession = (sessionId: string, type?: McpClientEvent['type']) => events.filter((e) => e.sessionId === sessionId && (!type || e.type === type))
const until = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 10))
  }
}

// ---------------------------------------------------------------------------------------------------------------------

describe('connect', () => {
  it('returns the server info and sends the headers', async () => {
    const info = await api.mcpClientConnect(http())
    expect(info.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(info.serverInfo).toEqual({ name: 'demo', version: '1.2.3', title: 'Demo server' })
    expect(info.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(info.capabilities).toMatchObject({ tools: {}, resources: {}, prompts: {}, logging: {} })
    expect(info.instructions).toBe('Use echo.')
    expect(info.connectMs).toBeGreaterThanOrEqual(0)
    expect(server.auth).toContain('Bearer s3cret-token')
    // The initialize handshake is in the message log, as sent and received.
    const sent = ofSession(info.sessionId, 'send').map((e) => (e.payload as { method?: string }).method)
    expect(sent).toEqual(expect.arrayContaining(['initialize', 'notifications/initialized']))
    const init = ofSession(info.sessionId, 'send').find((e) => (e.payload as { method?: string }).method === 'initialize')!
    expect(init.payload).toMatchObject({ params: { clientInfo: { name: 'slinger', version: '9.9.9' }, capabilities: {} } })
    expect(ofSession(info.sessionId, 'receive')[0].payload).toMatchObject({ result: { serverInfo: { name: 'demo' } } })
    expect(ofSession(info.sessionId)[0].at).toBe(clock)
    // Header values never reach the events.
    expect(JSON.stringify(events)).not.toContain('s3cret-token')
  })

  it('connects over SSE (legacy)', async () => {
    const info = await api.mcpClientConnect(http({ transport: 'sse', url: `${server.url}/sse` }))
    expect(info.serverInfo.name).toBe('demo')
    const out = await api.mcpClientCall(call(info.sessionId))
    expect(out).toMatchObject({ ok: true, isError: false, error: null })
    expect(text(out.result)).toBe('hello')
    expect(server.auth.filter((a) => a === 'Bearer s3cret-token').length).toBeGreaterThan(1)
  })

  it('fails with network_error when nothing answers', async () => {
    const closed = await startServer()
    await closed.close()
    await expect(api.mcpClientConnect(http({ url: `${closed.url}/mcp` }))).rejects.toMatchObject({
      code: 'network_error',
      message: expect.stringContaining('Could not connect to the MCP server'),
    })
    await expect(api.mcpClientConnect(http({ url: `${server.url}/hang`, timeoutMs: 200 }))).rejects.toMatchObject({
      code: 'network_error',
      message: 'The MCP server did not answer within 200 ms',
    })
  })

  it('rejects unresolved {{variables}} in what it would send', async () => {
    const invalid = { code: 'invalid_input' }
    await expect(api.mcpClientConnect(http({ url: '{{base}}/mcp' }))).rejects.toMatchObject(invalid)
    await expect(api.mcpClientConnect(http({ headers: [{ key: 'Authorization', value: 'Bearer {{token}}' }] }))).rejects.toMatchObject(invalid)
    await expect(api.mcpClientConnect(stdio({ args: ['{{script}}'] }))).rejects.toMatchObject(invalid)
    const { sessionId } = await api.mcpClientConnect(http())
    await expect(api.mcpClientCall(call(sessionId, { arguments: { text: '{{name}}' } }))).rejects.toMatchObject(invalid)
    await expect(api.mcpClientCall(call(sessionId, { operation: 'resources/read', name: undefined, uri: 'demo://{{x}}' }))).rejects.toMatchObject(invalid)
    expect(server.auth).not.toContain('Bearer {{token}}')
  })
})

describe('list', () => {
  it('lists tools, resources, resource templates and prompts', async () => {
    const { sessionId } = await api.mcpClientConnect(http())
    const tools = await api.mcpClientList(sessionId, 'tools')
    expect(tools.kind).toBe('tools')
    expect(tools.truncated).toBe(false)
    expect(tools.items.map((t) => t.name).sort()).toEqual(['add', 'echo', 'fail', 'notify', 'slow'])
    expect(tools.items.find((t) => t.name === 'echo')).toMatchObject({ description: 'Echoes text', inputSchema: { type: 'object' } })
    expect((await api.mcpClientList(sessionId, 'resources')).items).toMatchObject([{ uri: 'demo://readme', name: 'readme' }])
    expect((await api.mcpClientList(sessionId, 'resourceTemplates')).items).toMatchObject([{ uriTemplate: 'demo://users/{id}' }])
    expect((await api.mcpClientList(sessionId, 'prompts')).items).toMatchObject([{ name: 'greet', arguments: [{ name: 'name', required: true }] }])
  })

  it('follows nextCursor up to 1000 items and skips kinds the server does not offer', async () => {
    const { sessionId } = await api.mcpClientConnect(http({ url: `${server.url}/paged` }))
    const tools = await api.mcpClientList(sessionId, 'tools')
    expect(tools.items).toHaveLength(MAX_LIST_ITEMS)
    expect(tools.truncated).toBe(true)
    expect(tools.items[999].name).toBe('tool999')
    const prompts = await api.mcpClientList(sessionId, 'prompts')
    expect(prompts).toMatchObject({ truncated: false })
    expect(prompts.items.map((p) => p.name)).toEqual(Array.from({ length: 250 }, (_, i) => `prompt${i}`))
    // No resources capability: empty, without asking the server.
    expect(await api.mcpClientList(sessionId, 'resources')).toEqual({ kind: 'resources', items: [], truncated: false })
    expect(ofSession(sessionId, 'send').some((e) => (e.payload as { method?: string }).method === 'resources/list')).toBe(false)
  })

  it('gives an empty list for a list the server declares but does not implement', async () => {
    const { sessionId } = await api.mcpClientConnect(http({ url: `${server.url}/notemplates` }))
    expect((await api.mcpClientList(sessionId, 'resources')).items).toMatchObject([{ uri: 'demo://only' }])
    expect(await api.mcpClientList(sessionId, 'resourceTemplates')).toEqual({ kind: 'resourceTemplates', items: [], truncated: false })
  })

  it('rejects an unknown session', async () => {
    await expect(api.mcpClientList('nope', 'tools')).rejects.toMatchObject({ code: 'not_found' })
    await expect(api.mcpClientCall(call('nope'))).rejects.toMatchObject({ code: 'not_found' })
    await expect(api.mcpClientDisconnect('nope')).resolves.toBeUndefined()
    await expect(api.mcpClientCancel('nope')).resolves.toBeUndefined()
  })
})

describe('call', () => {
  it('calls a tool', async () => {
    const { sessionId } = await api.mcpClientConnect(http())
    await api.mcpClientList(sessionId, 'tools')
    const echo = await api.mcpClientCall(call(sessionId))
    expect(echo).toMatchObject({ ok: true, isError: false, error: null })
    expect(echo.result).toMatchObject({ content: [{ type: 'text', text: 'hello' }] })
    expect(echo.durationMs).toBeGreaterThanOrEqual(0)
    const add = await api.mcpClientCall(call(sessionId, { name: 'add', arguments: { a: 2, b: 3 } }))
    expect(add).toMatchObject({ ok: true, result: { structuredContent: { sum: 5 } } })
    // The request and its response are in the message log.
    const sent = ofSession(sessionId, 'send').find((e) => (e.payload as { params?: { name?: string } }).params?.name === 'add')!
    expect(sent.payload).toMatchObject({ jsonrpc: '2.0', method: 'tools/call', params: { arguments: { a: 2, b: 3 } } })
    const id = (sent.payload as { id: number }).id
    expect(ofSession(sessionId, 'receive').find((e) => (e.payload as { id?: number }).id === id)!.payload).toMatchObject({
      result: { structuredContent: { sum: 5 } },
    })
  })

  it('reports a tool result with isError', async () => {
    const { sessionId } = await api.mcpClientConnect(http())
    const out = await api.mcpClientCall(call(sessionId, { name: 'fail', arguments: {} }))
    expect(out).toMatchObject({ ok: false, isError: true, error: null })
    expect(text(out.result)).toBe('it broke')
    // McpServer turns an unknown tool into an isError result too.
    expect(await api.mcpClientCall(call(sessionId, { name: 'missing' }))).toMatchObject({ ok: false, isError: true })
  })

  it('reports JSON-RPC errors without rejecting', async () => {
    const paged = await api.mcpClientConnect(http({ url: `${server.url}/paged` }))
    expect(await api.mcpClientCall(call(paged.sessionId, { name: 'tool1' }))).toMatchObject({
      ok: false,
      isError: false,
      result: null,
      error: { code: ErrorCode.InvalidParams, message: 'Bad things', data: { hint: 'try again' } },
    })
    const demo = await api.mcpClientConnect(http())
    expect(await api.mcpClientCall(call(demo.sessionId, { operation: 'prompts/get', name: 'nope', arguments: {} }))).toMatchObject({
      ok: false,
      error: { code: ErrorCode.InvalidParams, message: expect.stringContaining('Prompt nope not found') },
    })
  })

  it('reads a resource and a templated one', async () => {
    const { sessionId } = await api.mcpClientConnect(http())
    const readme = await api.mcpClientCall(call(sessionId, { operation: 'resources/read', name: undefined, arguments: undefined, uri: 'demo://readme' }))
    expect(readme).toMatchObject({ ok: true, result: { contents: [{ uri: 'demo://readme', mimeType: 'text/plain', text: 'Read me' }] } })
    const user = await api.mcpClientCall(call(sessionId, { operation: 'resources/read', name: undefined, arguments: undefined, uri: 'demo://users/7' }))
    expect(user).toMatchObject({ ok: true, result: { contents: [{ text: 'user 7' }] } })
  })

  it('gets a prompt', async () => {
    const { sessionId } = await api.mcpClientConnect(http())
    const out = await api.mcpClientCall(call(sessionId, { operation: 'prompts/get', name: 'greet', arguments: { name: 'Ada' } }))
    expect(out).toMatchObject({ ok: true, isError: false, result: { messages: [{ role: 'user', content: { type: 'text', text: 'Hello Ada' } }] } })
  })

  it('turns server logs and progress into notification events', async () => {
    const { sessionId } = await api.mcpClientConnect(http())
    expect(await api.mcpClientCall(call(sessionId, { name: 'notify', arguments: {} }))).toMatchObject({ ok: true })
    const notes = ofSession(sessionId, 'notification').map((e) => e.payload)
    expect(notes).toEqual(
      expect.arrayContaining([
        { method: 'notifications/message', params: { level: 'info', data: 'hello log' } },
        { method: 'notifications/progress', params: expect.objectContaining({ progress: 1, total: 2 }) },
      ]),
    )
    // Notifications are not logged twice as plain receives.
    expect(ofSession(sessionId, 'receive').some((e) => (e.payload as { method?: string }).method === 'notifications/message')).toBe(false)
  })

  it('cancels a call by its requestRunId', async () => {
    const { sessionId } = await api.mcpClientConnect(http())
    const input = call(sessionId, { name: 'slow', arguments: { ms: 10_000 } })
    const pending = api.mcpClientCall(input)
    await until(() => ofSession(sessionId, 'send').some((e) => (e.payload as { method?: string }).method === 'tools/call'))
    await expect(api.mcpClientCall({ ...input })).rejects.toMatchObject({ code: 'invalid_input' })
    await api.mcpClientCancel(input.requestRunId)
    const out = await pending
    expect(out).toMatchObject({ ok: false, isError: false, result: null, error: { code: null, message: 'Request cancelled', data: { cancelled: true } } })
    expect(out.durationMs).toBeLessThan(5000)
    // The server is told (notifications/cancelled) and its handler sees the abort.
    expect(ofSession(sessionId, 'send').some((e) => (e.payload as { method?: string }).method === 'notifications/cancelled')).toBe(true)
    await until(() => server.aborted.length === 1)
    // The session stays usable and the run id is free again.
    expect(await api.mcpClientCall({ ...input, name: 'echo', arguments: { text: 'again' } })).toMatchObject({ ok: true })
  })

  it('times out', async () => {
    const { sessionId } = await api.mcpClientConnect(http())
    const out = await api.mcpClientCall(call(sessionId, { name: 'slow', arguments: { ms: 5000 }, timeoutMs: 100 }))
    expect(out).toMatchObject({
      ok: false,
      error: { code: ErrorCode.RequestTimeout, message: 'Request timed out after 100 ms', data: { timedOut: true } },
    })
  })
})

describe('history', () => {
  it('records each call as an MCP row with the operation as detail', async () => {
    const { sessionId } = await api.mcpClientConnect(http())
    await api.mcpClientCall(call(sessionId, { requestName: 'Echo it', historySource: 'mcp' }))
    await api.mcpClientCall(call(sessionId, { name: 'fail', arguments: {} }))
    await api.mcpClientCall(
      call(sessionId, {
        operation: 'resources/read',
        name: undefined,
        arguments: undefined,
        uri: 'demo://readme',
        historyUrl: 'x'.repeat(5000),
        historyDetail: 'resources/read demo://{{doc}}',
      }),
    )
    await api.mcpClientCall(call(sessionId, { operation: 'prompts/get', name: 'nope', arguments: {} }))
    const rows = await api.listHistory(workspaceId)
    expect(rows).toHaveLength(4)
    const [prompt, read, fail, echo] = rows
    expect(echo).toMatchObject({
      kind: 'send',
      method: 'MCP',
      url: '{{base}}/mcp',
      statusCode: null,
      ok: true,
      errorMessage: null,
      requestId: null,
      requestName: 'Echo it',
      source: 'mcp',
      detail: 'tools/call echo',
    })
    expect(fail).toMatchObject({ method: 'MCP', ok: false, errorMessage: 'The tool returned an error', source: null, detail: 'tools/call fail' })
    // The display form, not the resolved URI (which may hold a secret).
    expect(read).toMatchObject({ ok: true, detail: 'resources/read demo://{{doc}}' })
    expect(read.url).toHaveLength(2000)
    expect(prompt).toMatchObject({ ok: false, errorMessage: expect.stringContaining('Prompt nope not found'), detail: 'prompts/get nope' })
  })

  it('never records a resolved resource URI, and hides secret values the scripts read', async () => {
    const { sessionId } = await api.mcpClientConnect(http())
    await api.mcpClientCall(call(sessionId, { operation: 'resources/read', name: undefined, arguments: undefined, uri: 'demo://readme' }))
    expect((await api.listHistory(workspaceId))[0]).toMatchObject({ detail: 'resources/read' })

    const redacting = new McpClientService({
      db: core.db,
      emit: () => {},
      redact: (sid, text) => (sid === 'script-session' ? text.replaceAll('hunter2', '{{pw}}') : text),
    })
    try {
      const info = await redacting.connect(http())
      await redacting.call(
        call(info.sessionId, {
          operation: 'resources/read',
          name: undefined,
          arguments: undefined,
          uri: 'demo://missing',
          historyUrl: 'http://u:hunter2@host/mcp',
          historyDetail: 'resources/read demo://hunter2',
          scriptSessionId: 'script-session',
        }),
      )
    } finally {
      await redacting.closeAll()
    }
    const row = (await api.listHistory(workspaceId))[0]
    expect(row).toMatchObject({ url: 'http://u:{{pw}}@host/mcp', detail: 'resources/read demo://{{pw}}', ok: false })
    expect(JSON.stringify(row)).not.toContain('hunter2')
  })

  it('links the saved request and skips an unknown workspace', async () => {
    const collection = await api.createCollection(workspaceId, 'Col')
    const request = await api.createRequest({ workspaceId, collectionId: collection.id, name: 'MCP req', method: 'MCP', url: 'http://x/mcp', documentJson: '{}' })
    const { sessionId } = await api.mcpClientConnect(http())
    await api.mcpClientCall(call(sessionId, { requestId: request.id }))
    expect((await api.listHistory(workspaceId))[0]).toMatchObject({ requestId: request.id })
    // The call itself still works when there is nowhere to record it.
    expect(await api.mcpClientCall(call(sessionId, { workspaceId: NIL_UUID }))).toMatchObject({ ok: true })
    expect(await api.listHistory(workspaceId)).toHaveLength(1)
  })
})

describe('stdio', () => {
  it('rejects a command the user has not allowed, for every origin', async () => {
    for (const origin of ['user', 'runner', 'workflow', 'mcp'] as const) {
      await expect(api.mcpClientConnect(stdio({ origin }))).rejects.toMatchObject({
        code: 'invalid_input',
        message: 'This command has not been allowed on this device yet.',
        details: { reason: 'untrusted_command', command: process.execPath, args: [FIXTURE], cwd: '', env: [{ key: 'FIXTURE_GREETING', value: 'hi' }] },
      })
    }
    expect(events).toEqual([])
  })

  it('runs an allowed command: env, default cwd, stderr lines', async () => {
    await trust(stdio())
    const info = await api.mcpClientConnect(stdio({ origin: 'runner' }))
    expect(info.serverInfo).toMatchObject({ name: 'stdio-fixture', version: '2.0.0' })
    expect(info.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    const out = await api.mcpClientCall(call(info.sessionId, { arguments: { text: 'x' } }))
    expect(text(out.result)).toBe('hi: x')
    expect(text((await api.mcpClientCall(call(info.sessionId, { name: 'cwd', arguments: {} }))).result)).toBe(homedir())
    await api.mcpClientCall(call(info.sessionId, { name: 'shout', arguments: { text: 'loud' } }))
    await until(() => ofSession(info.sessionId, 'stderr').length >= 3)
    expect(ofSession(info.sessionId, 'stderr').map((e) => e.payload)).toEqual([
      { text: 'fixture started' },
      { text: 'shout loud' },
      { text: 'partial line completed' },
    ])
    // Allowed means exactly this command, these arguments and this folder.
    await expect(api.mcpClientConnect(stdio({ args: [FIXTURE, '--other'] }))).rejects.toMatchObject({ details: { reason: 'untrusted_command' } })
    await expect(api.mcpClientConnect(stdio({ cwd: '/tmp' }))).rejects.toMatchObject({ details: { reason: 'untrusted_command' } })
  })

  it('allows exactly this environment: a new or changed variable needs a new Allow', async () => {
    await trust(stdio())
    const injected = stdio({ env: [{ key: 'FIXTURE_GREETING', value: 'hi' }, { key: 'NODE_OPTIONS', value: '--import=data:text/javascript,0' }] })
    await expect(api.mcpClientConnect(injected)).rejects.toMatchObject({
      code: 'invalid_input',
      details: { reason: 'untrusted_command', env: [{ key: 'FIXTURE_GREETING', value: 'hi' }, { key: 'NODE_OPTIONS', value: '--import=data:text/javascript,0' }] },
    })
    await expect(api.mcpClientConnect(stdio({ env: [{ key: 'FIXTURE_GREETING', value: 'bye' }] }))).rejects.toMatchObject({
      details: { reason: 'untrusted_command' },
    })
    await expect(api.mcpClientConnect(stdio({ env: [] }))).rejects.toMatchObject({ details: { reason: 'untrusted_command' } })
    expect(events).toEqual([])
    // The order of the rows does not matter; what the child gets does.
    expect(commandFingerprint('x', [], '', [{ key: 'A', value: '1' }, { key: 'B', value: '2' }])).toBe(
      commandFingerprint('x', [], '', [{ key: 'B', value: '2' }, { key: 'A', value: '1' }]),
    )
    expect(commandFingerprint('x', [], '', [{ key: 'A', value: '1' }, { key: 'A', value: '2' }])).toBe(commandFingerprint('x', [], '', [{ key: 'A', value: '2' }]))
  })

  it('keeps only fingerprints of the allowed commands in app_settings, once each', async () => {
    const input = stdio({ args: [FIXTURE, '--api-key', 'sk-live-secret'], env: [{ key: 'TOKEN', value: 'env-secret' }] })
    await trust(input)
    clock += 5000
    await trust(input)
    const raw = getSetting(core.db, TRUSTED_COMMANDS_KEY)!
    expect(JSON.parse(raw)).toEqual([
      { fingerprint: commandFingerprint(process.execPath, [FIXTURE, '--api-key', 'sk-live-secret'], '', [{ key: 'TOKEN', value: 'env-secret' }]), at: Math.floor(clock / 1000) },
    ])
    // Resolved arguments and environment values may be secrets: none is stored.
    for (const value of ['sk-live-secret', 'env-secret', FIXTURE, 'TOKEN']) expect(raw).not.toContain(value)
  })

  it('caps stderr at 64 KB per session', async () => {
    await trust(stdio())
    const { sessionId } = await api.mcpClientConnect(stdio())
    await api.mcpClientCall(call(sessionId, { name: 'spam', arguments: {} }))
    await until(() => ofSession(sessionId, 'stderr').some((e) => (e.payload as { text: string }).text.includes('is not shown')))
    const lines = ofSession(sessionId, 'stderr').map((e) => (e.payload as { text: string }).text)
    expect(lines.join('\n').length).toBeLessThanOrEqual(STDERR_CAP_BYTES)
    expect(lines.at(-1)).toBe('[stderr beyond 64 KB is not shown]')
    expect(lines).toContain(`0000 ${'x'.repeat(95)}`)
    // Still answering (stderr is drained, not left to fill the pipe).
    expect(await api.mcpClientCall(call(sessionId))).toMatchObject({ ok: true })
  })

  it('reports a server process that exits', async () => {
    await trust(stdio())
    const { sessionId } = await api.mcpClientConnect(stdio())
    expect(await api.mcpClientCall(call(sessionId, { name: 'exit', arguments: {} }))).toMatchObject({ ok: true })
    await until(() => ofSession(sessionId, 'closed').length > 0)
    expect(ofSession(sessionId, 'closed')).toMatchObject([{ payload: { message: 'The server process exited' } }])
    await expect(api.mcpClientList(sessionId, 'tools')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('fails to connect when the command does not exist', async () => {
    const missing = stdio({ command: '/nonexistent/slinger-mcp-server' })
    await trust(missing)
    await expect(api.mcpClientConnect(missing)).rejects.toMatchObject({ code: 'network_error', message: expect.stringContaining('ENOENT') })
  })
})

describe('session lifetime', () => {
  it('disconnect closes the session and ends it on the server', async () => {
    const { sessionId } = await api.mcpClientConnect(http())
    await api.mcpClientDisconnect(sessionId)
    expect(ofSession(sessionId, 'closed')).toMatchObject([{ payload: { message: 'Disconnected' } }])
    expect(server.deleted).toHaveLength(1)
    await expect(api.mcpClientCall(call(sessionId))).rejects.toMatchObject({ code: 'not_found' })
    await api.mcpClientDisconnect(sessionId)
    expect(ofSession(sessionId, 'closed')).toHaveLength(1)
  })

  it(`closes the least recently used session beyond ${MAX_SESSIONS}`, async () => {
    const ids: string[] = []
    for (let i = 0; i < MAX_SESSIONS; i++) {
      clock += 1000
      ids.push((await api.mcpClientConnect(http())).sessionId)
    }
    // Using the first one makes the second the oldest.
    clock += 1000
    await api.mcpClientList(ids[0], 'tools')
    clock += 1000
    const extra = (await api.mcpClientConnect(http())).sessionId
    await until(() => ofSession(ids[1], 'closed').length === 1)
    expect(ofSession(ids[1], 'closed')[0].payload).toEqual({ message: `Closed: more than ${MAX_SESSIONS} MCP connections were open` })
    await expect(api.mcpClientList(ids[1], 'tools')).rejects.toMatchObject({ code: 'not_found' })
    for (const id of [ids[0], ...ids.slice(2), extra]) await expect(api.mcpClientList(id, 'tools')).resolves.toMatchObject({ kind: 'tools' })
    expect(events.filter((e) => e.type === 'closed')).toHaveLength(1)
  })

  it('closes sessions idle for 15 minutes', async () => {
    const idle = (await api.mcpClientConnect(http())).sessionId
    const used = (await api.mcpClientConnect(http())).sessionId
    clock += IDLE_MS - 1000
    await api.mcpClientCall(call(used))
    clock += 1000
    await service().closeIdle()
    expect(ofSession(idle, 'closed')).toMatchObject([{ payload: { message: 'Closed after 15 minutes without use' } }])
    expect(ofSession(used, 'closed')).toEqual([])
    await expect(api.mcpClientList(used, 'tools')).resolves.toMatchObject({ kind: 'tools' })
  })

  it('closeAll stops every session, stdio children included', async () => {
    await trust(stdio())
    const a = await api.mcpClientConnect(http())
    const b = await api.mcpClientConnect(stdio())
    const pid = Number(text((await api.mcpClientCall(call(b.sessionId, { name: 'pid', arguments: {} }))).result))
    expect(() => process.kill(pid, 0)).not.toThrow()
    await core.mcpClient.closeAll()
    for (const id of [a.sessionId, b.sessionId]) {
      expect(ofSession(id, 'closed')).toMatchObject([{ payload: { message: 'Slinger is quitting' } }])
      await expect(api.mcpClientList(id, 'tools')).rejects.toMatchObject({ code: 'not_found' })
    }
    expect(() => process.kill(pid, 0)).toThrow()
  })
})
