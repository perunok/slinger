/**
 * MCP request model: a saved request with `method: 'MCP'` whose document carries a top-level `mcp` object (wire format
 * version 1, below) next to the usual Postman item keys. Headers and auth stay on the RequestDraft (the HTTP/SSE
 * transport's headers and auth); body and params are unused and saved empty.
 *
 * Wire format of `document.mcp` (unknown keys are kept and written back verbatim):
 * `{ v: 1, transport, command, args, env: [{key, value, disabled}], cwd, operation, tool, arguments (JSON text), uri,
 *    prompt, promptArguments: [{key, value, disabled}], timeoutMs }`
 */
import { dataRows, ensureTrailingEmpty, newRow, type KvRow } from './kv'
import { newDraft, type RequestDraft } from './request'

export type McpTransport = 'http' | 'sse' | 'stdio'
export type McpOperation = 'tools/call' | 'resources/read' | 'prompts/get'

export interface McpDraft {
  transport: McpTransport
  /** stdio: the executable (template). */
  command: string
  /** stdio: argument templates. */
  args: string[]
  /** stdio: extra environment (templates), with the usual trailing empty row. */
  env: KvRow[]
  /** stdio: working directory (template); '' = Slinger's default. */
  cwd: string
  operation: McpOperation
  /** tools/call: tool name. */
  tool: string
  /** tools/call: JSON text; may contain `{{vars}}` (resolved, then parsed, when sending). */
  arguments: string
  /** resources/read: resource URI (template). */
  uri: string
  /** prompts/get: prompt name. */
  prompt: string
  /** prompts/get: string arguments (templates), with the usual trailing empty row. */
  promptArguments: KvRow[]
  /** Per-call timeout; null = the default (60 s). */
  timeoutMs: number | null
  /** Unknown keys of document.mcp, written back verbatim. */
  extra: Record<string, unknown>
}

export const MCP_METHOD = 'MCP'
export const MCP_WIRE_VERSION = 1
export const MCP_TRANSPORTS: readonly McpTransport[] = ['http', 'sse', 'stdio']
export const MCP_OPERATIONS: readonly McpOperation[] = ['tools/call', 'resources/read', 'prompts/get']
/** The `url` column is cut to this many characters (stdio command lines). */
export const MCP_URL_COLUMN_MAX = 8192

/** Keys of document.mcp this model edits; everything else lands in `extra`. */
const OWN_KEYS = new Set(['v', 'transport', 'command', 'args', 'env', 'cwd', 'operation', 'tool', 'arguments', 'uri', 'prompt', 'promptArguments', 'timeoutMs'])

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export function newMcpDraft(init: Partial<McpDraft> = {}): McpDraft {
  return {
    transport: 'http',
    command: '',
    args: [],
    env: ensureTrailingEmpty([]),
    cwd: '',
    operation: 'tools/call',
    tool: '',
    arguments: '{}',
    uri: '',
    prompt: '',
    promptArguments: ensureTrailingEmpty([]),
    timeoutMs: null,
    extra: {},
    ...init,
  }
}

function rowsFrom(list: unknown): KvRow[] {
  if (!Array.isArray(list)) return ensureTrailingEmpty([])
  const rows = list.filter(isObj).map((r) => newRow({ key: str(r.key), value: str(r.value), enabled: r.disabled !== true }))
  return ensureTrailingEmpty(rows)
}

function rowsTo(rows: KvRow[]): Json[] {
  return dataRows(rows).map((r) => ({ key: r.key, value: r.value, disabled: !r.enabled }))
}

/** Tolerant: anything missing or of the wrong type gets its default. */
export function parseMcp(value: unknown): McpDraft {
  const m = isObj(value) ? value : {}
  const extra: Json = {}
  for (const [k, v] of Object.entries(m)) if (!OWN_KEYS.has(k)) extra[k] = v
  const args = m.arguments
  const timeout = m.timeoutMs
  return newMcpDraft({
    transport: MCP_TRANSPORTS.includes(m.transport as McpTransport) ? (m.transport as McpTransport) : 'http',
    command: str(m.command),
    args: Array.isArray(m.args) ? m.args.filter((a) => typeof a === 'string' || typeof a === 'number').map(String) : [],
    env: rowsFrom(m.env),
    cwd: str(m.cwd),
    operation: MCP_OPERATIONS.includes(m.operation as McpOperation) ? (m.operation as McpOperation) : 'tools/call',
    tool: str(m.tool),
    // Older or hand-written documents may hold the arguments as an object: keep them, as JSON text.
    arguments: typeof args === 'string' ? args : isObj(args) ? JSON.stringify(args, null, 2) : '{}',
    uri: str(m.uri),
    prompt: str(m.prompt),
    promptArguments: rowsFrom(m.promptArguments),
    timeoutMs: typeof timeout === 'number' && Number.isInteger(timeout) && timeout > 0 ? timeout : null,
    extra,
  })
}

export function serializeMcp(d: McpDraft): Record<string, unknown> {
  return {
    v: MCP_WIRE_VERSION,
    transport: d.transport,
    command: d.command,
    args: [...d.args],
    env: rowsTo(d.env),
    cwd: d.cwd,
    operation: d.operation,
    tool: d.tool,
    arguments: d.arguments,
    uri: d.uri,
    prompt: d.prompt,
    promptArguments: rowsTo(d.promptArguments),
    timeoutMs: d.timeoutMs,
    ...Object.fromEntries(Object.entries(d.extra).filter(([k]) => !OWN_KEYS.has(k))),
  }
}

export function isMcpDraft(draft: RequestDraft): boolean {
  return draft.mcp !== undefined
}

/** The `url` column of an MCP request: the server URL template (http/sse) or the command line `command arg1 arg2` (stdio). */
export function mcpDisplayUrl(draft: RequestDraft): string {
  const m = draft.mcp
  if (!m || m.transport !== 'stdio') return draft.url
  return [m.command, ...m.args].filter((p) => p !== '').join(' ').slice(0, MCP_URL_COLUMN_MAX)
}

/**
 * The MCP strings that may hold `{{templates}}` and must resolve before a send: only the ones the transport and the
 * operation use, so an unused `{{variable}}` never blocks a send (the URL, headers and auth are added by templateTexts).
 */
export function mcpTemplateTexts(d: McpDraft): string[] {
  const out: string[] = []
  if (d.transport === 'stdio') {
    out.push(d.command, ...d.args)
    for (const r of dataRows(d.env)) if (r.enabled) out.push(r.value)
    out.push(d.cwd)
  }
  if (d.operation === 'tools/call') out.push(d.arguments)
  if (d.operation === 'resources/read') out.push(d.uri)
  if (d.operation === 'prompts/get') for (const r of dataRows(d.promptArguments)) if (r.enabled) out.push(r.value)
  return out
}

export function newMcpRequestDraft(name = 'New MCP Request'): RequestDraft {
  return { ...newDraft({ name, method: MCP_METHOD, url: '' }), mcp: newMcpDraft() }
}
