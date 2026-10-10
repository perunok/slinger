/**
 * MCP client (MCP requests): Slinger as an MCP client. Sessions with MCP servers over Streamable HTTP, SSE (legacy) or a
 * local command (stdio), created by `connect` and used by `list` and `call`. Every JSON-RPC message, server notification and
 * stderr line of a session is pushed to the window as an McpClientEvent (the request's message log).
 *
 * Security: a stdio command runs only after the user allowed it on this device (`trustCommand`, called from the window's
 * confirm dialog). Collections can be synced, imported or written by AI assistants, so the check lives here, in main, and
 * covers every origin; nothing but the window's dialog adds to the trusted list. What is allowed is the exact command,
 * arguments, working directory and extra environment; only their fingerprint is stored (an argument may hold a secret).
 */
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js'
import { ErrorCode, McpError, type JSONRPCMessage, type MessageExtraInfo } from '@modelcontextprotocol/sdk/types.js'
import type {
  McpCallInput,
  McpCallOutcome,
  McpClientEvent,
  McpConnectInput,
  McpListKind,
  McpListResult,
  McpSessionInfo,
  McpTrustCommandInput,
} from '../../shared/types'
import { invalidInput, IpcError, networkError, notFound } from '../lib/errors'
import { isUuid } from '../lib/ids'
import { HistoryRepository } from '../repositories/history'
import { getSetting, setSetting } from '../sync/store'
import type { McpClientApi, McpClientDeps } from './types'

/** More open sessions than this: the least recently used ones are closed. */
export const MAX_SESSIONS = 20
/** A session unused for this long is closed. */
export const IDLE_MS = 15 * 60_000
const SWEEP_EVERY_MS = 60_000
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000
const DEFAULT_CALL_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 600_000
/** `list` follows nextCursor up to this many items (`truncated` then true). */
export const MAX_LIST_ITEMS = 1000
/** stderr of a stdio server forwarded per session; the rest is dropped (one notice). */
export const STDERR_CAP_BYTES = 64 * 1024
/** A JSON-RPC message larger than this is logged as a stub (the call still returns the whole result). */
const MAX_LOGGED_MESSAGE_CHARS = 1024 * 1024
/** Disconnecting from a Streamable HTTP server: how long the session DELETE may take. */
const TERMINATE_TIMEOUT_MS = 2000
const HISTORY_URL_MAX = 2000
/** app_settings key of the stdio commands allowed on this device (local, never synced). */
export const TRUSTED_COMMANDS_KEY = 'mcp-client.trusted'
const MAX_TRUSTED_COMMANDS = 500

/** Only the fingerprint: the resolved command line may hold secret values, which never go to SQLite. */
interface TrustedCommand {
  fingerprint: string
  /** Unix seconds. */
  at: number
}

interface Session {
  id: string
  client: Client
  /** The SDK transport inside the logging wrapper. */
  inner: Transport
  transport: McpConnectInput['transport']
  workspaceId: string
  lastUsed: number
  /** Calls and lists in progress (an idle sweep never closes a busy session). */
  busy: number
  /** Set by whoever closes it on purpose; the `closed` event carries it. */
  closeReason: string | null
  /** In the session map (connect succeeded) and not closed yet. */
  open: boolean
  /** Set while #close runs (closing twice waits for the first). */
  closing: Promise<void> | null
  /** The transport has closed (also before connect finished). */
  ended: boolean
  stderrBytes: number
}

type EnvRows = ReadonlyArray<{ key: string; value: string }>

/** The extra environment as the child gets it (a later row wins over an earlier one of the same name), sorted by name. */
function envPairs(env: EnvRows): Array<[string, string]> {
  return Object.entries(Object.fromEntries(env.map((e) => [e.key, e.value]))).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * What a stdio command is allowed by: the exact command, arguments, working directory and extra environment (variables
 * such as NODE_OPTIONS, LD_PRELOAD or PATH change what runs, so a new or changed one needs a new Allow).
 */
export function commandFingerprint(command: string, args: string[], cwd: string, env: EnvRows = []): string {
  return createHash('sha256').update(JSON.stringify([command, args, cwd, envPairs(env)])).digest('hex')
}

/**
 * Wraps an SDK transport so every JSON-RPC message in either direction reaches `log` before the Client sees it (incoming)
 * or the wire gets it (outgoing). Also remembers the negotiated protocol version, which the Client reports only to
 * transports that want it.
 */
class LoggedTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void
  protocolVersion: string | null = null

  constructor(
    private readonly inner: Transport,
    private readonly log: (direction: 'send' | 'receive', message: JSONRPCMessage) => void,
  ) {
    inner.onmessage = (message, extra) => {
      log('receive', message)
      this.onmessage?.(message, extra)
    }
    inner.onclose = () => this.onclose?.()
    inner.onerror = (error) => this.onerror?.(error)
  }

  get sessionId(): string | undefined {
    return this.inner.sessionId
  }

  start(): Promise<void> {
    return this.inner.start()
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    this.log('send', message)
    return this.inner.send(message, options)
  }

  close(): Promise<void> {
    return this.inner.close()
  }

  setProtocolVersion(version: string): void {
    this.protocolVersion = version
    this.inner.setProtocolVersion?.(version)
  }
}

const errorText = (err: unknown): string => {
  const message = err instanceof Error ? err.message : String(err)
  // McpError prefixes "MCP error <code>: " (an SDK server sends its own prefixed message, so twice); the code travels separately.
  return err instanceof McpError ? message.replace(/^(?:MCP error -?\d+: )+/, '') : message
}

const clampTimeout = (ms: number | undefined, fallback: number) => Math.min(Math.max(Math.trunc(ms ?? fallback), 1), MAX_TIMEOUT_MS)

/** Resolves after `ms` at the latest; never rejects. */
const settle = (p: Promise<unknown>, ms: number) =>
  Promise.race([p.catch(() => {}), new Promise<void>((resolve) => setTimeout(resolve, ms).unref())])

export class McpClientService implements McpClientApi {
  readonly #sessions = new Map<string, Session>()
  /** Calls in progress by requestRunId (mcpClientCancel). */
  readonly #runs = new Map<string, AbortController>()
  readonly #history: HistoryRepository
  #sweep: NodeJS.Timeout | null = null

  constructor(private readonly deps: McpClientDeps) {
    this.#history = new HistoryRepository(deps.db)
  }

  async connect(input: McpConnectInput): Promise<McpSessionInfo> {
    const started = performance.now()
    const inner: Transport = input.transport === 'stdio' ? this.#stdioTransport(input) : this.#httpTransport(input)
    const session: Session = {
      id: randomUUID(),
      client: new Client({ name: 'slinger', version: this.deps.appVersion ?? '0.0.0' }, { capabilities: {} }),
      inner,
      transport: input.transport,
      workspaceId: input.workspaceId,
      lastUsed: this.#now(),
      busy: 0,
      closeReason: null,
      open: false,
      closing: null,
      ended: false,
      stderrBytes: 0,
    }
    if (inner instanceof StdioClientTransport) this.#pipeStderr(session, inner)
    const transport = new LoggedTransport(inner, (direction, message) => this.#logMessage(session, direction, message))
    session.client.onclose = () => this.#closed(session)
    session.client.onerror = (err) => {
      // Closing on purpose can make a transport complain (an aborted stream); that is not news.
      if (session.closing === null) this.#emit(session.id, 'error', { message: errorText(err) })
    }

    const timeoutMs = clampTimeout(input.timeoutMs, DEFAULT_CONNECT_TIMEOUT_MS)
    try {
      await session.client.connect(transport, { timeout: timeoutMs })
    } catch (err) {
      // A started stdio child must not outlive a failed connect.
      await session.client.close().catch(() => {})
      const timedOut = err instanceof McpError && err.code === ErrorCode.RequestTimeout
      throw networkError(
        timedOut ? `The MCP server did not answer within ${timeoutMs} ms` : `Could not connect to the MCP server: ${errorText(err)}`,
        timedOut ? { timedOut: true } : undefined,
      )
    }

    if (session.ended) throw networkError('The MCP server closed the connection right after connecting')
    session.open = true
    session.lastUsed = this.#now()
    this.#sessions.set(session.id, session)
    this.#evictOverCap(session)
    this.#startSweep()
    const server = session.client.getServerVersion()
    return {
      sessionId: session.id,
      serverInfo: {
        name: String(server?.name ?? ''),
        version: String(server?.version ?? ''),
        ...(typeof server?.title === 'string' ? { title: server.title } : {}),
      },
      protocolVersion: transport.protocolVersion,
      capabilities: (session.client.getServerCapabilities() ?? {}) as Record<string, unknown>,
      instructions: session.client.getInstructions() ?? null,
      connectMs: Math.round(performance.now() - started),
    }
  }

  async list(sessionId: string, kind: McpListKind): Promise<McpListResult> {
    const session = this.#session(sessionId)
    const capability = kind === 'resourceTemplates' ? 'resources' : kind
    // Nothing to list (asking anyway would only produce "Method not found").
    if (!session.client.getServerCapabilities()?.[capability]) return { kind, items: [], truncated: false }
    const client = session.client
    const options: RequestOptions = { timeout: DEFAULT_CALL_TIMEOUT_MS }
    const page = async (cursor: string | undefined): Promise<{ items: unknown[]; nextCursor?: string }> => {
      const params = cursor === undefined ? undefined : { cursor }
      switch (kind) {
        case 'tools': {
          const r = await client.listTools(params, options)
          return { items: r.tools, nextCursor: r.nextCursor }
        }
        case 'resources': {
          const r = await client.listResources(params, options)
          return { items: r.resources, nextCursor: r.nextCursor }
        }
        case 'resourceTemplates': {
          const r = await client.listResourceTemplates(params, options)
          return { items: r.resourceTemplates, nextCursor: r.nextCursor }
        }
        case 'prompts': {
          const r = await client.listPrompts(params, options)
          return { items: r.prompts, nextCursor: r.nextCursor }
        }
      }
    }

    this.#use(session, +1)
    try {
      const items: Array<Record<string, unknown>> = []
      const seen = new Set<string>()
      let cursor: string | undefined
      let truncated = false
      for (;;) {
        const r = await page(cursor)
        items.push(...(r.items as Array<Record<string, unknown>>))
        cursor = r.nextCursor
        if (items.length >= MAX_LIST_ITEMS) {
          truncated = items.length > MAX_LIST_ITEMS || !!cursor
          items.length = MAX_LIST_ITEMS
          break
        }
        // A server that hands out the same cursor twice would loop forever.
        if (!cursor || seen.has(cursor)) break
        seen.add(cursor)
      }
      return { kind, items, truncated }
    } catch (err) {
      // A server may declare `resources` without implementing every list (resources/templates/list above all): nothing to list.
      if (err instanceof McpError && err.code === ErrorCode.MethodNotFound) return { kind, items: [], truncated: false }
      throw networkError(errorText(err), err instanceof McpError ? { code: err.code } : undefined)
    } finally {
      this.#use(session, -1)
    }
  }

  async call(input: McpCallInput): Promise<McpCallOutcome> {
    const session = this.#session(input.sessionId)
    const runId = input.requestRunId
    if (this.#runs.has(runId)) throw invalidInput('a call with this requestRunId is already running')
    const controller = new AbortController()
    this.#runs.set(runId, controller)
    const timeoutMs = clampTimeout(input.timeoutMs, DEFAULT_CALL_TIMEOUT_MS)
    // onprogress makes the request carry a progressToken, so servers may report progress (it shows in the message log).
    const options: RequestOptions = { timeout: timeoutMs, signal: controller.signal, onprogress: () => {} }
    const client = session.client
    const started = performance.now()
    this.#use(session, +1)
    let outcome: McpCallOutcome
    try {
      let result: Record<string, unknown>
      if (input.operation === 'tools/call') {
        result = await client.callTool({ name: input.name ?? '', arguments: input.arguments ?? {} }, undefined, options)
      } else if (input.operation === 'resources/read') {
        result = await client.readResource({ uri: input.uri ?? '' }, options)
      } else {
        result = await client.getPrompt({ name: input.name ?? '', arguments: (input.arguments ?? {}) as Record<string, string> }, options)
      }
      const isError = input.operation === 'tools/call' && result.isError === true
      outcome = { ok: !isError, isError, result, error: null, durationMs: Math.round(performance.now() - started) }
    } catch (err) {
      let error: NonNullable<McpCallOutcome['error']>
      if (controller.signal.aborted) {
        error = { code: null, message: 'Request cancelled', data: { cancelled: true } }
      } else if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) {
        error = { code: err.code, message: `Request timed out after ${timeoutMs} ms`, data: { timedOut: true } }
      } else if (err instanceof McpError) {
        error = { code: err.code, message: errorText(err), ...(err.data !== undefined ? { data: err.data } : {}) }
      } else {
        error = { code: null, message: errorText(err) }
      }
      outcome = { ok: false, isError: false, result: null, error, durationMs: Math.round(performance.now() - started) }
    } finally {
      this.#runs.delete(runId)
      this.#use(session, -1)
    }
    this.#record(input, outcome)
    return outcome
  }

  cancel(requestRunId: string): void {
    this.#runs.get(requestRunId)?.abort(new Error('Request cancelled'))
  }

  async disconnect(sessionId: string): Promise<void> {
    const session = this.#sessions.get(sessionId)
    if (session) await this.#close(session, 'Disconnected')
  }

  trustCommand(input: McpTrustCommandInput): void {
    const fingerprint = commandFingerprint(input.command, input.args, input.cwd, input.env ?? [])
    const list = this.#trusted()
      .filter((t) => t.fingerprint !== fingerprint)
      .map((t) => ({ fingerprint: t.fingerprint, at: t.at }))
    list.push({ fingerprint, at: Math.floor(this.#now() / 1000) })
    setSetting(this.deps.db, TRUSTED_COMMANDS_KEY, JSON.stringify(list.slice(-MAX_TRUSTED_COMMANDS)))
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.#sessions.values()].map((s) => this.#close(s, 'Slinger is quitting')))
    this.#stopSweep()
  }

  /** Closes sessions unused for IDLE_MS (runs every minute while any session is open; public for tests). */
  async closeIdle(): Promise<void> {
    const cutoff = this.#now() - IDLE_MS
    const idle = [...this.#sessions.values()].filter((s) => s.busy === 0 && s.lastUsed <= cutoff)
    await Promise.all(idle.map((s) => this.#close(s, 'Closed after 15 minutes without use')))
  }

  // -------------------------------------------------------------------------------------------------------------------

  #now(): number {
    return (this.deps.now ?? Date.now)()
  }

  #session(sessionId: string): Session {
    const session = this.#sessions.get(sessionId)
    if (!session) throw notFound('MCP session', { sessionId })
    return session
  }

  #use(session: Session, delta: 1 | -1): void {
    session.busy += delta
    session.lastUsed = this.#now()
  }

  #emit(sessionId: string, type: McpClientEvent['type'], payload: unknown): void {
    try {
      this.deps.emit({ sessionId, at: this.#now(), type, payload })
    } catch {
      // A window going away must never break a session.
    }
  }

  /** Incoming notifications are `notification` events; every other message is `send` / `receive`. */
  #logMessage(session: Session, direction: 'send' | 'receive', message: JSONRPCMessage): void {
    if (direction === 'receive' && 'method' in message && !('id' in message)) {
      this.#emit(session.id, 'notification', { method: message.method, params: message.params ?? null })
      return
    }
    let payload: unknown = message
    const size = JSON.stringify(message).length
    if (size > MAX_LOGGED_MESSAGE_CHARS) {
      payload = {
        jsonrpc: '2.0',
        ...('id' in message ? { id: message.id } : {}),
        ...('method' in message ? { method: message.method } : {}),
        _slinger: `Message of ${size} characters not shown in the log`,
      }
    }
    this.#emit(session.id, direction, payload)
  }

  #httpTransport(input: McpConnectInput): Transport {
    let url: URL
    try {
      url = new URL(input.url ?? '')
    } catch {
      throw invalidInput('The MCP server URL is not valid')
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalidInput('The MCP server URL must start with http:// or https://')
    const headers = new Headers()
    for (const h of input.headers ?? []) {
      if (!h.key.trim()) continue
      try {
        headers.append(h.key.trim(), h.value)
      } catch {
        throw invalidInput(`Header "${h.key}" is not a valid HTTP header`)
      }
    }
    const options = { requestInit: { headers }, ...(this.deps.fetchImpl ? { fetch: this.deps.fetchImpl } : {}) }
    return input.transport === 'sse' ? new SSEClientTransport(url, options) : new StreamableHTTPClientTransport(url, options)
  }

  #stdioTransport(input: McpConnectInput): StdioClientTransport {
    const command = input.command ?? ''
    const args = input.args ?? []
    const cwd = input.cwd ?? ''
    const extra = input.env ?? []
    if (!this.#trusted().some((t) => t.fingerprint === commandFingerprint(command, args, cwd, extra))) {
      const env = extra.map((e) => ({ key: e.key, value: e.value }))
      throw invalidInput('This command has not been allowed on this device yet.', { reason: 'untrusted_command', command, args, cwd, env })
    }
    const base = this.deps.spawnEnv
      ? Object.fromEntries(Object.entries(this.deps.spawnEnv).filter((e): e is [string, string] => typeof e[1] === 'string'))
      : getDefaultEnvironment()
    const env = { ...base, ...Object.fromEntries(envPairs(extra)) }
    return new StdioClientTransport({ command, args, env, cwd: cwd || homedir(), stderr: 'pipe' })
  }

  /** stderr lines of a stdio server -> `stderr` events, up to STDERR_CAP_BYTES per session (the rest is drained). */
  #pipeStderr(session: Session, transport: StdioClientTransport): void {
    const stream = transport.stderr
    if (!stream) return
    const decoder = new StringDecoder('utf8')
    let partial = ''
    const line = (text: string) => {
      if (session.stderrBytes >= STDERR_CAP_BYTES) return
      session.stderrBytes += Buffer.byteLength(text) + 1
      if (session.stderrBytes >= STDERR_CAP_BYTES) {
        this.#emit(session.id, 'stderr', { text: `[stderr beyond ${STDERR_CAP_BYTES / 1024} KB is not shown]` })
      } else {
        this.#emit(session.id, 'stderr', { text })
      }
    }
    stream.on('data', (chunk: Buffer) => {
      const lines = (partial + decoder.write(chunk)).split(/\r?\n/)
      partial = lines.pop() ?? ''
      // A server writing without newlines still shows up, in pieces.
      if (partial.length > 8192) {
        lines.push(partial)
        partial = ''
      }
      for (const l of lines) line(l)
    })
    stream.on('end', () => {
      const rest = partial + decoder.end()
      partial = ''
      if (rest) line(rest)
    })
    stream.on('error', () => {})
  }

  #trusted(): TrustedCommand[] {
    try {
      const value = JSON.parse(getSetting(this.deps.db, TRUSTED_COMMANDS_KEY) ?? '[]') as unknown
      return Array.isArray(value) ? value.filter((t): t is TrustedCommand => typeof t?.fingerprint === 'string') : []
    } catch {
      return []
    }
  }

  #record(input: McpCallInput, outcome: McpCallOutcome): void {
    // The renderer's display form keeps secrets as {{name}}; the resolved URI never goes to History.
    const detail = input.historyDetail ?? (input.operation === 'resources/read' ? input.operation : `${input.operation} ${input.name ?? ''}`)
    const redact = (text: string) => (this.deps.redact ? this.deps.redact(input.scriptSessionId, text) : text)
    const errorMessage = outcome.error?.message ?? (outcome.isError ? 'The tool returned an error' : null)
    try {
      this.#history.record({
        workspaceId: input.workspaceId,
        requestId: isUuid(input.requestId) ? input.requestId : null,
        requestName: input.requestName ?? null,
        method: 'MCP',
        url: redact(input.historyUrl).slice(0, HISTORY_URL_MAX),
        statusCode: null,
        ok: outcome.ok,
        errorMessage: errorMessage === null ? null : redact(errorMessage),
        durationMs: outcome.durationMs,
        source: input.historySource === 'mcp' ? 'mcp' : null,
        detail: redact(detail.trim()).slice(0, HISTORY_URL_MAX),
      })
    } catch (err) {
      // Unknown workspace (deleted meanwhile): no row. Anything else is worth a line, but never hides the outcome.
      if (!(err instanceof IpcError && err.code === 'not_found')) {
        console.warn('[slinger] could not record MCP history:', err instanceof Error ? err.message : err)
      }
    }
  }

  /** Over MAX_SESSIONS: the least recently used sessions other than `keep` are closed. */
  #evictOverCap(keep: Session): void {
    const excess = this.#sessions.size - MAX_SESSIONS
    if (excess <= 0) return
    const oldest = [...this.#sessions.values()]
      .filter((s) => s !== keep)
      .sort((a, b) => a.lastUsed - b.lastUsed)
      .slice(0, excess)
    for (const s of oldest) void this.#close(s, `Closed: more than ${MAX_SESSIONS} MCP connections were open`)
  }

  #close(session: Session, reason: string): Promise<void> {
    if (!session.open) return Promise.resolve()
    session.closing ??= (async () => {
      session.closeReason = reason
      this.#sessions.delete(session.id)
      // Streamable HTTP: tell the server the session is over (best effort, bounded).
      if (session.inner instanceof StreamableHTTPClientTransport && session.inner.sessionId) {
        await settle(session.inner.terminateSession(), TERMINATE_TIMEOUT_MS)
      }
      // Stdio: closes stdin, then SIGTERM / SIGKILL if the server does not exit (the SDK waits up to 2 s for each).
      await session.client.close().catch(() => {})
      this.#closed(session)
    })()
    return session.closing
  }

  /** The transport closed (on purpose or not): one `closed` event per session. */
  #closed(session: Session): void {
    session.ended = true
    if (!session.open) return
    session.open = false
    if (this.#sessions.get(session.id) === session) this.#sessions.delete(session.id)
    const fallback = session.transport === 'stdio' ? 'The server process exited' : 'The server closed the connection'
    this.#emit(session.id, 'closed', { message: session.closeReason ?? fallback })
    if (this.#sessions.size === 0) this.#stopSweep()
  }

  #startSweep(): void {
    if (this.#sweep) return
    this.#sweep = setInterval(() => void this.closeIdle(), SWEEP_EVERY_MS)
    this.#sweep.unref()
  }

  #stopSweep(): void {
    if (this.#sweep) clearInterval(this.#sweep)
    this.#sweep = null
  }
}
