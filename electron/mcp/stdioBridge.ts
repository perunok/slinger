/**
 * stdio <-> HTTP bridge for MCP clients that can only start a local command (Claude Desktop's config file, ...).
 * Bundled as dist-electron/mcp-stdio.cjs and run by Slinger's own executable in Node mode:
 *
 *   ELECTRON_RUN_AS_NODE=1 SLINGER_MCP_TOKEN=<token> <Slinger> <...>/dist-electron/mcp-stdio.cjs
 *
 * Every JSON-RPC line read from stdin is POSTed to the running app's endpoint (SLINGER_MCP_URL, default
 * http://127.0.0.1:7354/mcp); the reply messages are written to stdout, one per line. Diagnostics go to stderr only.
 * Plain Node: no Electron, no SDK.
 */
import { createInterface } from 'node:readline'

type Json = Record<string, unknown>
type Out = (line: string) => void

export interface BridgeOptions {
  url: string
  token: string
  fetchImpl?: typeof fetch
}

const NOT_RUNNING = 'Slinger is not running, or its MCP server is off (Slinger > Settings > AI assistants (MCP)).'

/** Handles one stdin line; writes zero or more stdout lines. Exported for tests. */
export async function relay(line: string, opts: BridgeOptions, out: Out, state: { protocolVersion?: string }): Promise<void> {
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
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${opts.token}`,
  }
  if (state.protocolVersion) headers['mcp-protocol-version'] = state.protocolVersion
  let res: Response
  try {
    res = await (opts.fetchImpl ?? fetch)(opts.url, { method: 'POST', headers, body: line })
  } catch {
    return fail(NOT_RUNNING)
  }
  if (res.status === 202) return
  const type = res.headers.get('content-type') ?? ''
  const text = await res.text()
  const messages: unknown[] = []
  if (type.includes('text/event-stream')) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n')
      if (data) messages.push(...[JSON.parse(data)].flat())
    }
  } else if (text) {
    try {
      messages.push(...[JSON.parse(text)].flat())
    } catch {
      return fail(`Slinger answered HTTP ${res.status} with something that is not JSON.`)
    }
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

export function runBridge(env: NodeJS.ProcessEnv = process.env): void {
  const opts: BridgeOptions = { url: env.SLINGER_MCP_URL || 'http://127.0.0.1:7354/mcp', token: env.SLINGER_MCP_TOKEN ?? '' }
  if (!opts.token) process.stderr.write('slinger mcp-stdio: SLINGER_MCP_TOKEN is not set; copy the token from Slinger > Settings > AI assistants (MCP).\n')
  const state: { protocolVersion?: string } = {}
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

