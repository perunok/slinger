/**
 * Mock of the MCP client half of SlingerIpcApi (MCP requests): every connect, whatever the URL or (allowed) command,
 * reaches an in-memory "Demo MCP server". It answers like an SDK `McpServer` would and pushes the events main pushes
 * (JSON-RPC send/receive for the message log, server log notifications, stderr for stdio, closed), so the MCP request UI
 * can be built and tested in the browser.
 *
 * Deterministic: no randomness (session ids and JSON-RPC ids are counters, the weather is a table). Only `slow` takes
 * time (cancellable, honours the call timeout); every other call answers at once. mcpClientCall/mcpClientCancel skip the
 * backend's latency (NO_LATENCY in mockBackend.ts): a run is registered synchronously so a cancel right after finds it.
 *
 * Like main: stdio commands are refused until allowed (mcpClientTrustCommand), `{{variables}}` left in the input are
 * rejected, tool and protocol failures are outcomes (`ok: false`, never a rejection), and each call writes a History row.
 * Server notifications reach listeners as `notification` events only (no duplicate `receive` event).
 * Connection failures can be tried with any host under `.invalid` (e.g. http://down.invalid/mcp).
 */
import type { SlingerIpcApi } from '../../../shared/ipc-contract'
import type {
  McpCallInput,
  McpCallOutcome,
  McpClientEvent,
  McpConnectInput,
  McpListKind,
  McpSessionInfo,
  McpTrustCommandInput,
} from '../../../shared/types'
import type { MockState } from './store'
import { bytesToBase64, clone, fail, nowSec, uuid } from './util'

export type McpClientMockApi = Pick<
  SlingerIpcApi,
  | 'mcpClientConnect'
  | 'mcpClientList'
  | 'mcpClientCall'
  | 'mcpClientCancel'
  | 'mcpClientDisconnect'
  | 'mcpClientTrustCommand'
  | 'onMcpClientEvent'
>

/** A stdio command allowed on this "device" (main keeps these in app_settings 'mcp-client.trusted'). */
export interface MockTrustedCommand extends McpTrustCommandInput {
  /** Unix seconds. */
  at: number
}

/** Test/dev controls (window.__slingerMock.mcpClient). */
export interface MockMcpClientControls {
  /** Back to the initial state (called by the backend's reset): no sessions, no allowed commands. */
  reset(): void
  /** The allowed stdio commands, oldest first. */
  trusted(): MockTrustedCommand[]
  /** Forgets every allowed command, so the next stdio connect is refused again. */
  clearTrusted(): void
  /** Ids of the open sessions, oldest first. */
  sessions(): string[]
  /**
   * The server sends a notification to every open session (or to one), e.g. `notify('notifications/tools/list_changed')`
   * or `notify('notifications/message', { level: 'warning', logger: 'demo', data: 'Disk almost full' })`.
   */
  notify(method: string, params?: Record<string, unknown>, sessionId?: string): void
  /** The server goes away: running calls fail with "Connection closed", a `closed` event, later calls get not_found. */
  dropSession(sessionId: string, message?: string): void
}

// --- The Demo MCP server -----------------------------------------------------------------------------------------

const PROTOCOL_VERSION = '2025-11-25'
const SERVER_INFO = { name: 'demo-mcp-server', version: '1.0.0', title: 'Demo MCP server' }
const CAPABILITIES: Record<string, unknown> = {
  tools: { listChanged: true },
  resources: { listChanged: true },
  prompts: { listChanged: true },
  logging: {},
}
const INSTRUCTIONS = [
  '# Demo MCP server',
  '',
  'An in-memory server for trying MCP requests in the browser mock.',
  '',
  '- **Tools**: `echo`, `add` (structured output), `get_weather`, `create_user` (every kind of form field),',
  '  `content_types` (one block of each content type), `fail` (always a tool error) and `slow` (cancellable).',
  '- **Resources**: `demo://readme`, `demo://logo.png` and the template `demo://users/{id}`.',
  '- **Prompts**: `greet`.',
].join('\n')
const CLIENT_INFO = { name: 'slinger', version: '0.0.0-dev' }
const LOGGER = 'demo-mcp-server'

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
/** 8 samples of silence: 8-bit mono 8 kHz PCM WAV. */
const WAV_SILENCE = (() => {
  const samples = 8
  const bytes = new Uint8Array(44 + samples)
  const view = new DataView(bytes.buffer)
  const ascii = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)))
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, 8000, true) // sample rate
  view.setUint32(28, 8000, true) // byte rate
  view.setUint16(32, 1, true) // block align
  view.setUint16(34, 8, true) // bits per sample
  ascii(36, 'data')
  view.setUint32(40, samples, true)
  bytes.fill(128, 44)
  return bytesToBase64(bytes)
})()

const README = [
  '# Demo MCP server',
  '',
  'This resource is Markdown served by the mock backend.',
  'Read `demo://users/42` to try the resource template.',
].join('\n')

const USERS: Record<string, string> = { '1': 'Ana Novak', '2': 'Ben Okafor', '42': 'Douglas Adams' }

const WEATHER: Record<string, { celsius: number; conditions: string; humidity: number }> = {
  Berlin: { celsius: 18, conditions: 'Partly cloudy', humidity: 62 },
  London: { celsius: 15, conditions: 'Light rain', humidity: 81 },
  Tokyo: { celsius: 24, conditions: 'Sunny', humidity: 55 },
  'New York': { celsius: 21, conditions: 'Clear', humidity: 48 },
}

type JsonSchema = Record<string, unknown>

/** What tools/list answers (SDK shape: name, title, description, inputSchema, outputSchema?, annotations?). */
export const DEMO_TOOLS: Array<Record<string, unknown>> = [
  {
    name: 'echo',
    title: 'Echo',
    description: 'Returns the text you send.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to send back' } },
      required: ['text'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'add',
    title: 'Add two numbers',
    description: 'Adds a and b. The sum also comes back as structured content.',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'number', description: 'First number' },
        b: { type: 'number', description: 'Second number' },
      },
      required: ['a', 'b'],
    },
    outputSchema: { type: 'object', properties: { sum: { type: 'number' } }, required: ['sum'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_weather',
    title: 'Get weather',
    description: 'Current weather for a city (canned data).',
    inputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', enum: Object.keys(WEATHER), description: 'City name' },
        units: { type: 'string', enum: ['metric', 'imperial'], default: 'metric', description: 'Temperature units' },
      },
      required: ['city'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string' },
        temperature: { type: 'number' },
        units: { type: 'string' },
        conditions: { type: 'string' },
        humidity: { type: 'number' },
      },
      required: ['city', 'temperature', 'units', 'conditions', 'humidity'],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'create_user',
    title: 'Create user',
    description: 'Pretends to create a user. Its input uses every kind of form field.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, description: 'Full name' },
        email: { type: 'string', format: 'email', description: 'Email address' },
        age: { type: 'integer', minimum: 0, maximum: 150 },
        role: { type: 'string', enum: ['viewer', 'editor', 'admin'], default: 'viewer' },
        newsletter: { type: 'boolean', default: false, description: 'Subscribe to the newsletter' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Free-form labels' },
        address: {
          type: 'object',
          description: 'Postal address',
          properties: {
            street: { type: 'string' },
            city: { type: 'string' },
            country: { type: 'string', default: 'DE' },
          },
          required: ['city'],
        },
        metadata: { anyOf: [{ type: 'string' }, { type: 'object' }], description: 'Anything else (JSON)' },
      },
      required: ['name', 'email'],
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'content_types',
    title: 'Content types',
    description: 'Returns one content block of every type: text, image, audio, resource link and embedded resources.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'fail',
    title: 'Fail',
    description: 'Always returns a tool error (isError: true).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'slow',
    title: 'Slow',
    description: 'Waits before answering: try Cancel or a short timeout.',
    inputSchema: {
      type: 'object',
      properties: { ms: { type: 'integer', minimum: 0, maximum: 600_000, default: 3000, description: 'How long to wait (ms)' } },
    },
  },
]

export const DEMO_RESOURCES: Array<Record<string, unknown>> = [
  { uri: 'demo://readme', name: 'readme', title: 'README', description: 'What this server offers', mimeType: 'text/markdown' },
  { uri: 'demo://logo.png', name: 'logo', title: 'Logo', description: 'A 1x1 PNG', mimeType: 'image/png' },
]

export const DEMO_RESOURCE_TEMPLATES: Array<Record<string, unknown>> = [
  { uriTemplate: 'demo://users/{id}', name: 'user', title: 'User by id', description: 'A user as JSON (try 1, 2 or 42)', mimeType: 'application/json' },
]

export const DEMO_PROMPTS: Array<Record<string, unknown>> = [
  {
    name: 'greet',
    title: 'Greeting',
    description: 'Asks the model to greet someone.',
    arguments: [
      { name: 'name', description: 'Who to greet', required: true },
      { name: 'style', description: 'formal or casual (default casual)', required: false },
    ],
  },
]

/** A JSON-RPC error the server answers with. */
class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

/** Why a running call ended early (the AbortSignal's reason). */
class Aborted extends Error {
  constructor(readonly reason: 'cancel' | 'timeout' | 'closed') {
    super(reason)
  }
}

interface ServeContext {
  signal: AbortSignal
  log(level: 'debug' | 'info' | 'warning' | 'error', data: string): void
}

const text = (value: string) => ({ type: 'text', text: value })
const toolError = (message: string) => ({ content: [text(message)], isError: true })

function typeOk(schema: JsonSchema, value: unknown): boolean {
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false
  switch (schema.type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'array':
      return Array.isArray(value) && (!schema.items || value.every((v) => typeOk(schema.items as JsonSchema, v)))
    case 'object':
      return !!value && typeof value === 'object' && !Array.isArray(value) && validate(schema, value as Record<string, unknown>) === null
    default:
      return true
  }
}

const typeName = (value: unknown): string => (Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value)

/** A small subset of JSON Schema (required, type, enum, nested objects): the first problem, or null. */
function validate(schema: JsonSchema, args: Record<string, unknown>): string | null {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>
  for (const key of (schema.required ?? []) as string[]) {
    if (args[key] === undefined) return `${key}: Required`
  }
  for (const [key, value] of Object.entries(args)) {
    const prop = properties[key]
    if (!prop || value === undefined || typeOk(prop, value)) continue
    return Array.isArray(prop.enum)
      ? `${key}: Invalid enum value. Expected ${prop.enum.map((v) => `'${String(v)}'`).join(' | ')}`
      : `${key}: Expected ${String(prop.type)}, received ${typeName(value)}`
  }
  return null
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

const userJson = (id: string): string => JSON.stringify({ id, name: USERS[id] ?? `User ${id}` }, null, 2)

function readResource(uri: string): Record<string, unknown> {
  if (uri === 'demo://readme') return { contents: [{ uri, mimeType: 'text/markdown', text: README }] }
  if (uri === 'demo://logo.png') return { contents: [{ uri, mimeType: 'image/png', blob: PNG_1X1 }] }
  const user = /^demo:\/\/users\/([^/]+)$/.exec(uri)
  if (user) return { contents: [{ uri, mimeType: 'application/json', text: userJson(decodeURIComponent(user[1])) }] }
  throw new RpcError(-32602, `Resource ${uri} not found`)
}

function getPrompt(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name !== 'greet') throw new RpcError(-32602, `Prompt ${name} not found`)
  if (typeof args.name !== 'string' || args.name === '') throw new RpcError(-32602, `Invalid arguments for prompt ${name}: name: Required`)
  const style = args.style === 'formal' ? 'formal' : 'casual'
  return { description: 'A greeting', messages: [{ role: 'user', content: text(`Please greet ${args.name} in a ${style} way.`) }] }
}

// --- The client API ----------------------------------------------------------------------------------------------

const MAX_SESSIONS = 20
const MAX_TRUSTED = 500
const HISTORY_CAP = 500
const DEFAULT_CALL_TIMEOUT_MS = 60_000
const PLACEHOLDER_RE = /\{\{[^{}]*\}\}/
const LIST_METHOD: Record<McpListKind, string> = {
  tools: 'tools/list',
  resources: 'resources/list',
  resourceTemplates: 'resources/templates/list',
  prompts: 'prompts/list',
}
const LIST_ITEMS: Record<McpListKind, Array<Record<string, unknown>>> = {
  tools: DEMO_TOOLS,
  resources: DEMO_RESOURCES,
  resourceTemplates: DEMO_RESOURCE_TEMPLATES,
  prompts: DEMO_PROMPTS,
}

interface Session {
  id: string
  /** Next JSON-RPC request id (the SDK client starts at 0 with initialize). */
  nextId: number
}

interface Run {
  sessionId: string
  controller: AbortController
}

/** As main's fingerprint: the command, args, cwd and the extra environment (sorted by name, a later duplicate wins). */
const trustKey = (c: McpTrustCommandInput): string =>
  JSON.stringify([c.command, c.args, c.cwd, Object.entries(Object.fromEntries((c.env ?? []).map((e) => [e.key, e.value]))).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))])

/** Same check and message as main (ipc/api.ts): nothing may still hold a `{{variable}}`. */
function assertResolved(parts: Array<[string, string | undefined]>): void {
  for (const [where, value] of parts) {
    if (value && PLACEHOLDER_RE.test(value)) {
      fail('invalid_input', `Unresolved variable in ${where}: define it in the active environment`, { location: where })
    }
  }
}

/** Every key and string inside a JSON value, labelled with its path. */
function jsonStrings(value: unknown, path: string, out: Array<[string, string]> = []): Array<[string, string]> {
  if (typeof value === 'string') out.push([path, value])
  else if (Array.isArray(value)) value.forEach((v, i) => jsonStrings(v, `${path}[${i}]`, out))
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push([`${path} key "${k}"`, k])
      jsonStrings(v, `${path}.${k}`, out)
    }
  }
  return out
}

function hostOf(url: string | undefined): string | null {
  try {
    const parsed = new URL(url ?? '')
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname : null
  } catch {
    return null
  }
}

const elapsed = (started: number): number => Math.max(1, Math.round(performance.now() - started))

function errorOf(e: unknown, timeoutMs: number): NonNullable<McpCallOutcome['error']> {
  if (e instanceof RpcError) return { code: e.code, message: e.message }
  if (e instanceof Aborted) {
    if (e.reason === 'timeout') return { code: -32001, message: `Request timed out after ${timeoutMs} ms`, data: { timeout: timeoutMs } }
    if (e.reason === 'closed') return { code: -32000, message: 'Connection closed' }
    return { code: null, message: 'Request cancelled' }
  }
  return { code: -32603, message: e instanceof Error ? e.message : String(e) }
}

export function createMcpClientApi(state: MockState): { api: McpClientMockApi; controls: MockMcpClientControls } {
  const listeners = new Set<(event: McpClientEvent) => void>()
  const sessions = new Map<string, Session>()
  const runs = new Map<string, Run>()
  let trusted: MockTrustedCommand[] = []
  let sessionCount = 0
  let nextUserId = 1001

  function emit(sessionId: string, type: McpClientEvent['type'], payload: unknown): void {
    const event: McpClientEvent = { sessionId, at: Date.now(), type, payload }
    for (const listener of [...listeners]) {
      try {
        listener(clone(event))
      } catch {
        /* a broken listener must not break the "server" */
      }
    }
  }

  const notification = (sessionId: string, method: string, params?: Record<string, unknown>) =>
    emit(sessionId, 'notification', params === undefined ? { method } : { method, params })

  function mustSession(sessionId: string): Session {
    const session = sessions.get(sessionId)
    if (!session) fail('not_found', 'MCP session not found', { sessionId })
    return session
  }

  function close(sessionId: string, message: string): void {
    if (!sessions.delete(sessionId)) return
    for (const run of runs.values()) {
      if (run.sessionId === sessionId) run.controller.abort(new Aborted('closed'))
    }
    emit(sessionId, 'closed', { message })
  }

  /**
   * One request/response exchange in the message log. `handle` is called synchronously (it gets the JSON-RPC id);
   * an RpcError is logged as the error response and re-thrown, an abort is re-thrown without a response.
   */
  async function exchange(
    session: Session,
    method: string,
    params: Record<string, unknown>,
    handle: (id: number) => Promise<Record<string, unknown>> | Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const id = session.nextId++
    emit(session.id, 'send', { jsonrpc: '2.0', id, method, params })
    try {
      const result = await handle(id)
      if (sessions.has(session.id)) emit(session.id, 'receive', { jsonrpc: '2.0', id, result })
      return result
    } catch (e) {
      if (e instanceof RpcError && sessions.has(session.id)) {
        emit(session.id, 'receive', { jsonrpc: '2.0', id, error: { code: e.code, message: e.message } })
      }
      throw e
    }
  }

  /** tools/call as an SDK McpServer answers it: unknown tools and invalid arguments are tool errors, not JSON-RPC errors. */
  async function callTool(name: string, args: Record<string, unknown>, ctx: ServeContext): Promise<Record<string, unknown>> {
    const tool = DEMO_TOOLS.find((t) => t.name === name)
    if (!tool) return toolError(`MCP error -32602: Tool ${name} not found`)
    const problem = validate(tool.inputSchema as JsonSchema, args)
    if (problem) return toolError(`MCP error -32602: Input validation error: Invalid arguments for tool ${name}: ${problem}`)
    ctx.log('info', `Tool ${name} called`)
    switch (name) {
      case 'echo':
        return { content: [text(String(args.text))] }
      case 'add': {
        const sum = (args.a as number) + (args.b as number)
        return { content: [text(String(sum))], structuredContent: { sum } }
      }
      case 'get_weather': {
        const city = args.city as string
        const units = (args.units as string | undefined) ?? 'metric'
        const w = WEATHER[city]
        const temperature = units === 'imperial' ? Math.round((w.celsius * 9) / 5 + 32) : w.celsius
        return {
          content: [text(`${city}: ${temperature}°${units === 'imperial' ? 'F' : 'C'}, ${w.conditions.toLowerCase()}, humidity ${w.humidity}%`)],
          structuredContent: { city, temperature, units, conditions: w.conditions, humidity: w.humidity },
        }
      }
      case 'create_user': {
        const user = { id: nextUserId++, role: 'viewer', newsletter: false, ...args }
        return { content: [text(`Created user ${String(args.name)} <${String(args.email)}> with id ${user.id}`)], structuredContent: user }
      }
      case 'content_types':
        return {
          content: [
            text('One block of each content type follows.'),
            { type: 'image', data: PNG_1X1, mimeType: 'image/png' },
            { type: 'audio', data: WAV_SILENCE, mimeType: 'audio/wav' },
            { type: 'resource_link', uri: 'demo://readme', name: 'readme', title: 'README', mimeType: 'text/markdown' },
            { type: 'resource', resource: { uri: 'demo://users/42', mimeType: 'application/json', text: userJson('42') } },
            { type: 'resource', resource: { uri: 'demo://logo.png', mimeType: 'image/png', blob: PNG_1X1 } },
          ],
        }
      case 'fail':
        ctx.log('error', 'The fail tool failed, as it always does')
        return toolError('Something went wrong: this tool always fails.')
      default: {
        // slow
        const ms = (args.ms as number | undefined) ?? 3000
        ctx.log('debug', `Waiting ${ms} ms`)
        await abortableDelay(ms, ctx.signal)
        return { content: [text(`Waited ${ms} ms`)] }
      }
    }
  }

  /** The History row main writes for an MCP call (kind 'send', method 'MCP', detail "<operation> <name or URI>"). */
  function record(input: McpCallInput, outcome: McpCallOutcome): void {
    if (!state.workspaces.some((w) => w.id === input.workspaceId)) return
    state.history.unshift({
      id: uuid(),
      workspaceId: input.workspaceId,
      requestId: input.requestId ?? null,
      requestName: input.requestName ?? null,
      method: 'MCP',
      url: input.historyUrl.slice(0, 2000),
      statusCode: null,
      ok: outcome.ok,
      // As main: a tool result with isError has no JSON-RPC error message of its own.
      errorMessage: outcome.error?.message ?? (outcome.isError ? 'The tool returned an error' : null),
      durationMs: outcome.durationMs,
      createdAt: nowSec(),
      kind: 'send',
      source: input.historySource === 'mcp' ? 'mcp' : null,
      // As main: the renderer's display form (secrets as {{name}}), never the resolved URI.
      detail: input.historyDetail ?? (input.operation === 'resources/read' ? input.operation : `${input.operation} ${input.name ?? ''}`),
    })
    if (state.history.length > HISTORY_CAP) state.history.length = HISTORY_CAP
  }

  const api: McpClientMockApi = {
    async mcpClientConnect(input: McpConnectInput): Promise<McpSessionInfo> {
      const started = performance.now()
      const host = hostOf(input.url)
      if (input.transport === 'stdio' ? !input.command : host === null) {
        fail('invalid_input', input.transport === 'stdio' ? 'Invalid input: command: a command is required for stdio' : 'Invalid input: url: must be an http(s) URL')
      }
      assertResolved([
        ['URL', input.url],
        ...(input.headers ?? []).flatMap((h): Array<[string, string]> => [[`header "${h.key}" name`, h.key], [`header "${h.key}"`, h.value]]),
        ['command', input.command],
        ...(input.args ?? []).map((a, i): [string, string] => [`argument ${i + 1}`, a]),
        ['working directory', input.cwd],
        ...(input.env ?? []).flatMap((e): Array<[string, string]> => [[`environment variable "${e.key}" name`, e.key], [`environment variable "${e.key}"`, e.value]]),
      ])
      if (input.transport === 'stdio') {
        const command = { command: input.command ?? '', args: input.args ?? [], cwd: input.cwd ?? '', env: (input.env ?? []).map((e) => ({ key: e.key, value: e.value })) }
        // Every origin gets the same refusal; only the window's confirm dialog calls mcpClientTrustCommand.
        if (!trusted.some((t) => trustKey(t) === trustKey(command))) {
          fail('invalid_input', 'This command has not been allowed on this device yet.', { reason: 'untrusted_command', ...command })
        }
      } else if (host?.endsWith('.invalid')) {
        fail('network_error', `Could not connect to the MCP server: fetch failed (${host})`)
      }

      while (sessions.size >= MAX_SESSIONS) close(sessions.keys().next().value as string, 'Connection closed')
      const session: Session = { id: `mock-mcp-session-${++sessionCount}`, nextId: 0 }
      sessions.set(session.id, session)
      await exchange(session, 'initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }, () => ({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      }))
      emit(session.id, 'send', { jsonrpc: '2.0', method: 'notifications/initialized' })
      if (input.transport === 'stdio') emit(session.id, 'stderr', { text: `Demo MCP server running on stdio (${input.command})\n` })
      return {
        sessionId: session.id,
        serverInfo: { ...SERVER_INFO },
        protocolVersion: PROTOCOL_VERSION,
        capabilities: clone(CAPABILITIES),
        instructions: INSTRUCTIONS,
        connectMs: elapsed(started),
      }
    },

    async mcpClientList(sessionId, kind) {
      const session = mustSession(sessionId)
      if (!(kind in LIST_METHOD)) fail('invalid_input', `Invalid input: unknown list kind ${String(kind)}`)
      // The JSON-RPC result key is the kind itself (tools, resources, resourceTemplates, prompts).
      const result = await exchange(session, LIST_METHOD[kind], {}, () => ({ [kind]: clone(LIST_ITEMS[kind]) }))
      return { kind, items: result[kind] as Array<Record<string, unknown>>, truncated: false }
    },

    mcpClientCall(input) {
      try {
        const session = mustSession(input.sessionId)
        if (input.operation === 'resources/read' ? !input.uri : !input.name) {
          fail('invalid_input', `Invalid input: ${input.operation === 'resources/read' ? 'a resource URI is required' : 'a name is required'}`)
        }
        assertResolved([['name', input.name], ['URI', input.uri], ...jsonStrings(input.arguments, 'arguments')])
        return startCall(session, input)
      } catch (e) {
        return Promise.reject(e)
      }
    },

    async mcpClientCancel(requestRunId) {
      runs.get(requestRunId)?.controller.abort(new Aborted('cancel'))
    },

    async mcpClientDisconnect(sessionId) {
      close(sessionId, 'Connection closed')
    },

    async mcpClientTrustCommand(input) {
      if (!input.command) fail('invalid_input', 'Invalid input: command: a command is required')
      const env = (input.env ?? []).map((e) => ({ key: e.key, value: e.value }))
      assertResolved([
        ['command', input.command],
        ...input.args.map((a, i): [string, string] => [`argument ${i + 1}`, a]),
        ['working directory', input.cwd],
        ...env.flatMap((e): Array<[string, string]> => [[`environment variable "${e.key}" name`, e.key], [`environment variable "${e.key}"`, e.value]]),
      ])
      const entry: MockTrustedCommand = { command: input.command, args: [...input.args], cwd: input.cwd, env, at: nowSec() }
      trusted = [...trusted.filter((t) => trustKey(t) !== trustKey(entry)), entry].slice(-MAX_TRUSTED)
    },

    onMcpClientEvent(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }

  /** Registers the run synchronously (so a cancel right after the call finds it), then serves it. */
  function startCall(session: Session, input: McpCallInput): Promise<McpCallOutcome> {
    const run: Run = { sessionId: session.id, controller: new AbortController() }
    runs.set(input.requestRunId, run)
    const timeoutMs = input.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
    const timer = setTimeout(() => run.controller.abort(new Aborted('timeout')), timeoutMs)
    const started = performance.now()
    const args = input.arguments ?? {}
    const params: Record<string, unknown> = input.operation === 'resources/read' ? { uri: input.uri } : { name: input.name, arguments: args }
    const ctx: ServeContext = {
      signal: run.controller.signal,
      log: (level, data) => notification(session.id, 'notifications/message', { level, logger: LOGGER, data }),
    }
    let requestId = -1
    return exchange(session, input.operation, params, (id) => {
      requestId = id
      if (input.operation === 'tools/call') return callTool(input.name ?? '', args, ctx)
      if (input.operation === 'resources/read') return readResource(input.uri ?? '')
      return getPrompt(input.name ?? '', args)
    })
      .then(
        (result): McpCallOutcome => {
          const isError = result.isError === true
          return { ok: !isError, isError, result, error: null, durationMs: elapsed(started) }
        },
        (e: unknown): McpCallOutcome => {
          const error = errorOf(e, timeoutMs)
          if (e instanceof Aborted && e.reason !== 'closed' && sessions.has(session.id)) {
            // Like the SDK client: tell the server it gave up on the request.
            emit(session.id, 'send', { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId, reason: error.message } })
          }
          return { ok: false, isError: false, result: null, error, durationMs: elapsed(started) }
        },
      )
      .then((outcome) => {
        record(input, outcome)
        return outcome
      })
      .finally(() => {
        clearTimeout(timer)
        if (runs.get(input.requestRunId) === run) runs.delete(input.requestRunId)
      })
  }

  const controls: MockMcpClientControls = {
    reset() {
      for (const run of runs.values()) run.controller.abort(new Aborted('closed'))
      runs.clear()
      sessions.clear()
      trusted = []
      sessionCount = 0
      nextUserId = 1001
    },
    trusted: () => clone(trusted),
    clearTrusted() {
      trusted = []
    },
    sessions: () => [...sessions.keys()],
    notify(method, params, sessionId) {
      const targets = sessionId === undefined ? [...sessions.keys()] : sessions.has(sessionId) ? [sessionId] : []
      for (const id of targets) notification(id, method, params)
    },
    dropSession(sessionId, message = 'Connection closed') {
      close(sessionId, message)
    },
  }

  return { api, controls }
}
