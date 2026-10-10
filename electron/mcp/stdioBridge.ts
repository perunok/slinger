/**
 * stdio <-> HTTP bridge: what connected assistants (Claude Desktop, Claude Code, Cursor, ...) start. Slinger copies it to
 * <userData>/mcp/bridge.cjs on every start, and assistants run it with Slinger's own executable in Node mode:
 *
 *   ELECTRON_RUN_AS_NODE=1 <Slinger executable> <userData>/mcp/bridge.cjs
 *
 * It needs no token or port in the assistant's config: it reads them from endpoint.json next to itself (written by the app
 * while the server is on, readable only by the user). When Slinger is not running it starts it (launch.json) and waits,
 * unless the user quit it.
 * SLINGER_MCP_URL + SLINGER_MCP_TOKEN override the files (manual setups, tests). Every JSON-RPC line read from stdin is
 * POSTed to the endpoint and the replies are written to stdout, one per line. Diagnostics go to stderr only.
 * Plain Node: no Electron, no SDK, no dependencies.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

type Json = Record<string, unknown>
type Out = (line: string) => void

export const ENDPOINT_FILE = 'endpoint.json'
export const LAUNCH_FILE = 'launch.json'

export interface Endpoint {
  url: string
  token: string
}

/**
 * How to start Slinger (written by the app on every start). `enabled` false: the user turned the server off. `quit`:
 * the user quit Slinger (tray or menu), so it stays closed until they open it again.
 */
export interface Launch {
  enabled: boolean
  quit?: boolean
  command: string
  args: string[]
  env?: Record<string, string>
}

export interface BridgeOptions {
  /** Folder with endpoint.json / launch.json (the bridge's own folder). */
  dir?: string
  /** Fixed endpoint (env override); no auto-start then. */
  endpoint?: Endpoint
  fetchImpl?: typeof fetch
  spawnImpl?: (command: string, args: string[], env: NodeJS.ProcessEnv) => void
  /** How long to wait for a started Slinger (default 60 s). */
  startTimeoutMs?: number
  pollMs?: number
}

export interface BridgeState {
  protocolVersion?: string
  /** One start at a time, shared by concurrent requests. */
  starting?: Promise<void> | null
}

const OFF = 'The MCP server is turned off in Slinger. Turn it on in Slinger > Settings > AI assistants (MCP).'
const NOT_RUNNING = 'Slinger is not running, or its MCP server is off (Slinger > Settings > AI assistants (MCP)).'
const QUIT = 'Slinger was quit, so its MCP server is stopped. Open Slinger to use it again.'

class BridgeError extends Error {}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

function currentEndpoint(opts: BridgeOptions): Endpoint | null {
  if (opts.endpoint) return opts.endpoint
  if (!opts.dir) return null
  const e = readJson<Partial<Endpoint>>(join(opts.dir, ENDPOINT_FILE))
  return e && typeof e.url === 'string' && typeof e.token === 'string' ? { url: e.url, token: e.token } : null
}

function headersFor(ep: Endpoint, state: BridgeState): Record<string, string> {
  const h: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${ep.token}`,
  }
  if (state.protocolVersion) h['mcp-protocol-version'] = state.protocolVersion
  return h
}

/** Posts one line. Nothing listening: starts Slinger (when the bridge knows how) and tries once more. */
async function post(line: string, opts: BridgeOptions, state: BridgeState): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const attempt = async () => {
    const ep = currentEndpoint(opts)
    if (!ep) return null
    try {
      return await fetchImpl(ep.url, { method: 'POST', headers: headersFor(ep, state), body: line })
    } catch {
      return null
    }
  }
  const first = await attempt()
  if (first) return first
  if (opts.endpoint || !opts.dir) throw new BridgeError(NOT_RUNNING)
  await ensureStarted(opts, state)
  const second = await attempt()
  if (!second) throw new BridgeError(NOT_RUNNING)
  return second
}

/** Starts Slinger from launch.json and waits until its endpoint answers. */
function ensureStarted(opts: BridgeOptions, state: BridgeState): Promise<void> {
  state.starting ??= (async () => {
    const launch = readJson<Launch>(join(opts.dir!, LAUNCH_FILE))
    if (!launch || typeof launch.command !== 'string') throw new BridgeError(NOT_RUNNING)
    if (!launch.enabled) throw new BridgeError(OFF)
    if (launch.quit) throw new BridgeError(QUIT)
    const env: NodeJS.ProcessEnv = { ...process.env, ...(launch.env ?? {}) }
    delete env.ELECTRON_RUN_AS_NODE // the app itself must start as Electron, not as Node
    const spawnImpl =
      opts.spawnImpl ??
      ((command, args, e) => {
        const child = nodeSpawn(command, args, { detached: true, stdio: 'ignore', env: e })
        child.on('error', () => {})
        child.unref()
      })
    process.stderr.write('slinger mcp-stdio: starting Slinger\n')
    spawnImpl(launch.command, launch.args ?? [], env)
    const deadline = Date.now() + (opts.startTimeoutMs ?? 60_000)
    const fetchImpl = opts.fetchImpl ?? fetch
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, opts.pollMs ?? 500))
      const ep = currentEndpoint(opts)
      if (!ep) continue
      try {
        await fetchImpl(ep.url, { method: 'POST', headers: headersFor(ep, state), body: '{"jsonrpc":"2.0","id":"slinger-bridge-ping","method":"ping"}' })
        return
      } catch {
        /* not listening yet */
      }
    }
    throw new BridgeError('Slinger was started but its MCP server did not answer in time. Is it turned on in Settings?')
  })().finally(() => {
    state.starting = null
  })
  return state.starting
}

/** Handles one stdin line; writes zero or more stdout lines. */
export async function relay(line: string, opts: BridgeOptions, out: Out, state: BridgeState): Promise<void> {
  let msg: Json
  try {
    msg = JSON.parse(line) as Json
  } catch {
    return // not JSON-RPC: ignore, like a server would
  }
  const id = msg.id ?? null
  const isRequest = typeof msg.method === 'string' && id !== null
  const fail = (message: string, code = -32000) => {
    if (isRequest) out(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }))
  }
  let res: Response
  try {
    res = await post(line, opts, state)
  } catch (e) {
    return fail(e instanceof BridgeError ? e.message : NOT_RUNNING)
  }
  if (res.status === 202) return
  const type = res.headers.get('content-type') ?? ''
  const text = await res.text()
  const messages: unknown[] = []
  try {
    if (type.includes('text/event-stream')) {
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n')
        if (data) messages.push(...[JSON.parse(data)].flat())
      }
    } else if (text) messages.push(...[JSON.parse(text)].flat())
  } catch {
    return fail(`Slinger answered HTTP ${res.status} with something that is not JSON.`)
  }
  if (!res.ok) {
    const err = (messages[0] as { error?: { message?: string } } | undefined)?.error?.message
    return fail(err ? `${err} (HTTP ${res.status})` : `Slinger answered HTTP ${res.status}.`)
  }
  for (const m of messages) {
    const result = (m as { result?: { protocolVersion?: unknown } }).result
    if (msg.method === 'initialize' && typeof result?.protocolVersion === 'string') state.protocolVersion = result.protocolVersion
    out(JSON.stringify(m))
  }
}

export function runBridge(dir: string, env: NodeJS.ProcessEnv = process.env): void {
  const opts: BridgeOptions =
    env.SLINGER_MCP_URL && env.SLINGER_MCP_TOKEN ? { endpoint: { url: env.SLINGER_MCP_URL, token: env.SLINGER_MCP_TOKEN } } : { dir }
  const state: BridgeState = {}
  const out: Out = (l) => void process.stdout.write(`${l}\n`)
  const pending = new Set<Promise<void>>()
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on('line', (line) => {
    if (!line.trim()) return
    const p = relay(line, opts, out, state).catch((e) => {
      process.stderr.write(`slinger mcp-stdio: ${String(e)}\n`)
    })
    pending.add(p)
    void p.finally(() => pending.delete(p))
  })
  rl.on('close', () => void Promise.allSettled([...pending]).then(() => process.exit(0)))
}
