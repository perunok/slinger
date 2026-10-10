/**
 * The MCP endpoint: Streamable HTTP (JSON responses, stateless) on 127.0.0.1:<port>/mcp.
 *
 * Every request must carry `Authorization: Bearer <token>`; a Host other than the loopback names and any browser Origin
 * are refused, so web pages (including DNS-rebinding ones) cannot drive it. Tools come from shared/mcp.ts; a call is
 * validated here, then run by the renderer through the bridge.
 */
import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { MCP_TOOLS, type McpCallResult, type McpToolName, type McpToolSpec } from '../../shared/mcp'

const MAX_BODY = 60 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 60_000
/** After the grace period: how long failed calls get to write their answers before the connections are cut. */
const FLUSH_MS = 1_000
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

export interface McpServerDeps {
  /** Runs a validated tool call (the renderer bridge). */
  run(tool: McpToolName, args: unknown, timeoutMs: number): Promise<McpCallResult>
  /** Current bearer token. */
  token(): string
  appVersion: string
  /** Called for every tool call (status: last call, count). */
  onCall?(tool: McpToolName): void
}

const INSTRUCTIONS =
  'Slinger is a local API client (like Postman). Workspaces hold collections (folders, saved requests) and environments ' +
  '({{variables}}). Start with list_workspaces and get_tree; most tools default to the workspace open in the Slinger window. ' +
  'Edits appear in the window at once. send_request sends exactly like the Send button and records history. Secret ' +
  'values are never returned: use {{variables}} for credentials and set them with set_variable (secret: true).'

function jsonSchemaOf(spec: McpToolSpec) {
  const schema = z.toJSONSchema(spec.input, { target: 'draft-7' }) as Record<string, unknown>
  delete schema.$schema
  return schema as { type: 'object'; properties?: Record<string, unknown>; required?: string[] }
}

const TOOL_LIST = Object.entries(MCP_TOOLS).map(([name, spec]) => ({
  name,
  title: spec.title,
  description: spec.description,
  inputSchema: jsonSchemaOf(spec),
  annotations: {
    title: spec.title,
    readOnlyHint: 'readOnly' in spec ? spec.readOnly : false,
    destructiveHint: 'destructive' in spec ? spec.destructive : false,
    openWorldHint: 'openWorld' in spec ? spec.openWorld : false,
  },
}))

/** Builds one protocol server (stateless: a fresh one per HTTP request). */
export function createMcpProtocolServer(deps: McpServerDeps): Server {
  const server = new Server(
    { name: 'slinger', title: 'Slinger', version: deps.appVersion },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_LIST }))
  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const name = req.params.name
    if (!Object.hasOwn(MCP_TOOLS, name)) return failure(`Unknown tool "${name}".`)
    const tool = name as McpToolName
    const spec: McpToolSpec = MCP_TOOLS[tool]
    const parsed = spec.input.safeParse(req.params.arguments ?? {})
    if (!parsed.success) return failure(`Invalid arguments: ${z.prettifyError(parsed.error)}`)
    deps.onCall?.(tool)
    const result = await deps.run(tool, parsed.data, spec.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    if (!result.ok) return failure(result.error)
    return { content: [{ type: 'text', text: result.text }], ...(result.data ? { structuredContent: result.data } : {}) }
  })
  return server
}

const failure = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true })

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && expected.length > 0 && timingSafeEqual(a, b)
}

function reply(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
}

/** Checks Host, Origin and the bearer token; on failure sends the refusal and returns true. */
export function rejectRequest(req: IncomingMessage, res: ServerResponse, port: number, token: string): boolean {
  const host = (req.headers.host ?? '').toLowerCase()
  const hostName = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]!
  const hostPort = host.slice(hostName.length + 1)
  if (!LOOPBACK_HOSTS.has(hostName) || (hostPort !== '' && hostPort !== String(port))) {
    reply(res, 403, 'Forbidden host.')
    return true
  }
  // MCP clients do not send Origin; browsers always do on cross-origin requests.
  if (req.headers.origin !== undefined) {
    reply(res, 403, 'Browser origins are not allowed.')
    return true
  }
  const auth = req.headers.authorization ?? ''
  const m = /^Bearer\s+(.+)$/i.exec(auth)
  if (!m || !sameToken(m[1]!.trim(), token)) {
    reply(res, 401, 'Missing or wrong token. Copy it from Slinger > Settings > AI assistants (MCP).', { 'www-authenticate': 'Bearer' })
    return true
  }
  return false
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw Object.assign(new Error('Request too large.'), { status: 413 })
    chunks.push(chunk as Buffer)
  }
  if (size === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw Object.assign(new Error('Body is not JSON.'), { status: 400 })
  }
}

/** Listens on 127.0.0.1. `start` rejects with code EADDRINUSE when the port is taken. */
export class McpHttpServer {
  #http: HttpServer | null = null
  #port = 0
  /** Requests being answered (a tool call can take a while: it runs in the window). */
  #inFlight = 0
  #idleWaiters: Array<() => void> = []
  /** Quitting: new requests are refused, the ones in progress finish. */
  #draining = false

  constructor(private readonly deps: McpServerDeps) {}

  get port(): number {
    return this.#port
  }

  get listening(): boolean {
    return this.#http?.listening === true
  }

  async start(port: number): Promise<number> {
    await this.stop()
    const http = createServer((req, res) => void this.#handle(req, res))
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject)
      http.listen(port, '127.0.0.1', () => {
        http.off('error', reject)
        resolve()
      })
    })
    this.#http = http
    this.#port = (http.address() as { port: number }).port
    return this.#port
  }

  get inFlight(): number {
    return this.#inFlight
  }

  async stop(): Promise<void> {
    const http = this.#http
    this.#http = null
    this.#draining = false
    if (!http) return
    http.closeAllConnections()
    await new Promise<void>((resolve) => http.close(() => resolve()))
  }

  /**
   * Graceful stop (Slinger quitting): refuses new requests and connections at once, gives the calls in progress up to
   * `graceMs` to finish, then `failRemaining()` (which must make them answer) and a moment to send those answers.
   * An assistant never sees a cut connection for a call it made, only a result or an error message.
   */
  async drain(graceMs: number, failRemaining: () => void): Promise<void> {
    const http = this.#http
    if (!http) return
    this.#draining = true
    http.close() // no new connections; the open ones may still be answering
    http.closeIdleConnections()
    if (!(await this.#idle(graceMs))) {
      failRemaining()
      await this.#idle(FLUSH_MS)
    }
    await this.stop()
  }

  /** Resolves true once no request is in progress, false after `ms`. */
  #idle(ms: number): Promise<boolean> {
    if (this.#inFlight === 0) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        resolve(true)
      }
      const timer = setTimeout(() => {
        this.#idleWaiters = this.#idleWaiters.filter((w) => w !== done)
        resolve(false)
      }, ms)
      this.#idleWaiters.push(done)
    })
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.#inFlight++
    res.once('close', () => {
      this.#inFlight--
      if (this.#inFlight === 0) for (const w of this.#idleWaiters.splice(0)) w()
    })
    try {
      const path = (req.url ?? '').split('?')[0]
      if (path !== '/mcp') return reply(res, 404, 'Not found. The MCP endpoint is /mcp.')
      if (rejectRequest(req, res, this.#port, this.deps.token())) return
      // Keep-alive connections can still send requests after close(): answer them, but do not start new work.
      if (this.#draining) return reply(res, 503, 'Slinger is quitting.', { connection: 'close' })
      if (req.method !== 'POST') return reply(res, 405, 'Method not allowed (stateless server: POST only).', { allow: 'POST' })
      const body = await readJson(req)
      const server = createMcpProtocolServer(this.deps)
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      res.on('close', () => {
        void transport.close()
        void server.close()
      })
      await server.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500
      if (!res.headersSent) reply(res, status, (e as Error).message || 'Internal error.')
      else res.end()
    }
  }
}
