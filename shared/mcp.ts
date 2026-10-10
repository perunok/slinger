/**
 * MCP server (Model Context Protocol): what an LLM client connected to Slinger can do.
 *
 * The main process serves the protocol on 127.0.0.1 (electron/mcp) and forwards every tool call to the renderer, which
 * runs it with the same code as the UI (request model, `{{variable}}` resolution, sending, stores). This file is the
 * single source of truth for the tools: names, descriptions, input schemas (zod; the main process advertises them and the
 * renderer validates against them again) and hints. Secret values never appear in any tool result.
 */
import { z } from 'zod'

export const MCP_DEFAULT_PORT = 7354
/** Largest response body text returned to the LLM; longer bodies are cut with a note. */
export const MCP_BODY_LIMIT = 100_000

const id = z.string().min(1).max(64)
const optWorkspace = id.optional().describe('Workspace id. Defaults to the workspace open in the Slinger window.')
const kv = z
  .array(
    z.object({
      key: z.string().max(4096),
      value: z.string().max(1_000_000),
      enabled: z.boolean().optional().describe('Default true.'),
    }),
  )
  .max(500)
const body = z
  .object({
    mode: z.enum(['none', 'json', 'raw', 'urlencoded', 'form-data']).describe('json = raw JSON with a JSON content type.'),
    raw: z.string().max(5_000_000).optional().describe('Text for json/raw.'),
    language: z.enum(['json', 'xml', 'text', 'html', 'javascript']).optional().describe('raw only; default text.'),
    fields: kv.optional().describe('urlencoded / form-data text fields.'),
  })
  .describe('Request body. Omit to keep the current one.')
const auth = z
  .object({
    type: z.enum(['none', 'basic', 'bearer', 'apikey']),
    username: z.string().max(4096).optional(),
    password: z.string().max(4096).optional(),
    token: z.string().max(65536).optional(),
    key: z.string().max(4096).optional().describe('apikey: header or query parameter name.'),
    value: z.string().max(65536).optional().describe('apikey: its value.'),
    in: z.enum(['header', 'query']).optional().describe('apikey: where to send it; default header.'),
  })
  .describe('Authorization. Prefer {{variables}} (e.g. token "{{apiToken}}") over literal credentials.')

const requestFields = {
  name: z.string().min(1).max(512).optional(),
  method: z.string().min(1).max(32).optional().describe('GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS or a custom verb.'),
  url: z.string().max(65536).optional().describe('May contain {{variables}} and a query string.'),
  headers: kv.optional().describe('Replaces all headers.'),
  query: kv.optional().describe('Replaces the query parameters (rewrites the query string of the URL).'),
  body: body.optional(),
  auth: auth.optional(),
  description: z.string().max(200_000).optional().describe('Markdown documentation.'),
  pre_request_script: z.string().max(500_000).optional().describe('JavaScript (Postman pm API). Empty string removes it.'),
  test_script: z.string().max(500_000).optional().describe('JavaScript tests (pm.test...). Empty string removes it.'),
}

export interface McpToolSpec {
  title: string
  description: string
  input: z.ZodObject
  /** MCP tool annotations. */
  readOnly?: boolean
  destructive?: boolean
  /** Talks to the outside world (sends HTTP requests). */
  openWorld?: boolean
  /** How long the main process waits for the renderer. */
  timeoutMs?: number
}

const SEC = 1000
export const MCP_TOOLS = {
  list_workspaces: {
    title: 'List workspaces',
    description: 'Lists the local workspaces; the one open in the Slinger window is marked "open". Start here.',
    input: z.object({}),
    readOnly: true,
  },
  get_tree: {
    title: 'Collection tree',
    description:
      'Collections with their folders and requests (ids, method, URL) in sidebar order. Use the ids with the other tools.',
    input: z.object({ workspace_id: optWorkspace, collection_id: id.optional().describe('Only this collection.') }),
    readOnly: true,
  },
  search_requests: {
    title: 'Search requests',
    description: 'Finds saved requests whose name, URL or method contains the text (case-insensitive).',
    input: z.object({ query: z.string().min(1).max(512), workspace_id: optWorkspace }),
    readOnly: true,
  },
  get_request: {
    title: 'Read a request',
    description:
      'Full request: method, URL, query, headers, body, auth, scripts, docs, saved example names. Literal credentials are masked.',
    input: z.object({ request_id: id }),
    readOnly: true,
  },
  create_collection: {
    title: 'Create a collection',
    description: 'Creates an empty collection.',
    input: z.object({ name: z.string().min(1).max(512), workspace_id: optWorkspace }),
  },
  create_folder: {
    title: 'Create a folder',
    description: 'Creates a folder in a collection (optionally inside another folder).',
    input: z.object({ collection_id: id, parent_folder_id: id.optional(), name: z.string().min(1).max(512) }),
  },
  create_request: {
    title: 'Create a request',
    description: 'Saves a new request in a collection or folder. Only name, method and url are needed.',
    input: z.object({
      collection_id: id,
      folder_id: id.optional(),
      ...requestFields,
      name: z.string().min(1).max(512),
      method: z.string().min(1).max(32),
      url: z.string().max(65536),
    }),
  },
  update_request: {
    title: 'Edit a request',
    description: 'Changes the given parts of a saved request; everything not given stays as it is.',
    input: z.object({ request_id: id, ...requestFields }),
  },
  move_request: {
    title: 'Move a request',
    description: 'Moves a request to another collection and/or folder (at the end).',
    input: z.object({ request_id: id, collection_id: id, folder_id: id.nullable().optional().describe('null or omitted: top level.') }),
  },
  rename: {
    title: 'Rename',
    description: 'Renames a collection, folder, request or environment.',
    input: z.object({ kind: z.enum(['collection', 'folder', 'request', 'environment']), id, name: z.string().min(1).max(512) }),
  },
  delete: {
    title: 'Delete',
    description: 'Deletes a collection, folder (with its contents), request or environment (it goes to Slinger\'s trash-like soft delete).',
    input: z.object({ kind: z.enum(['collection', 'folder', 'request', 'environment']), id }),
    destructive: true,
  },
  list_environments: {
    title: 'Environments',
    description: 'Environments with their variables; the active one is marked. Secret values are never shown, only that they are set.',
    input: z.object({ workspace_id: optWorkspace }),
    readOnly: true,
  },
  create_environment: {
    title: 'Create an environment',
    description: 'Creates an environment (add variables with set_variable).',
    input: z.object({ name: z.string().min(1).max(512), workspace_id: optWorkspace }),
  },
  set_variable: {
    title: 'Set an environment variable',
    description:
      'Creates or changes a variable. secret: true stores the value in the OS keychain; it can be used in requests but never read back.',
    input: z.object({
      environment_id: id,
      key: z.string().min(1).max(4096),
      value: z.string().max(1_000_000),
      secret: z.boolean().optional().describe('Default: keep the current setting (false for a new variable).'),
    }),
  },
  delete_variable: {
    title: 'Delete an environment variable',
    description: 'Removes a variable from an environment.',
    input: z.object({ environment_id: id, key: z.string().min(1).max(4096) }),
    destructive: true,
  },
  set_active_environment: {
    title: 'Choose the active environment',
    description: 'Selects the environment the Slinger window uses for {{variables}} (null: none).',
    input: z.object({ environment_id: id.nullable() }),
  },
  send_request: {
    title: 'Send a request',
    description:
      'Sends a saved request (request_id) or an ad-hoc one (method + url + ...) exactly like the Send button: scripts run, ' +
      '{{variables}} resolve (secrets inside Slinger), the result lands in history. Returns status, headers, body and tests.',
    input: z.object({
      request_id: id.optional().describe('A saved request. Other fields given here override it for this send only.'),
      ...requestFields,
      environment_id: id.nullable().optional().describe('Use this environment instead of the active one (null: none).'),
    }),
    openWorld: true,
    timeoutMs: 330 * SEC,
  },
  run_collection: {
    title: 'Run a collection',
    description: 'Runs every request of a collection or folder in order (like the Runner) and reports each status and test result.',
    input: z.object({
      collection_id: id,
      folder_id: id.optional(),
      environment_id: id.nullable().optional().describe('Default: the active environment.'),
      iterations: z.number().int().min(1).max(100).optional(),
      stop_on_failure: z.boolean().optional(),
    }),
    openWorld: true,
    timeoutMs: 30 * 60 * SEC,
  },
  list_history: {
    title: 'Recent sends',
    description: 'The latest sends of a workspace (newest first): method, URL, status, duration, request.',
    input: z.object({ workspace_id: optWorkspace, limit: z.number().int().min(1).max(200).optional() }),
    readOnly: true,
  },
  import_postman: {
    title: 'Import a Postman collection',
    description: 'Imports a Postman v2.0/v2.1 collection given as JSON text into a new collection.',
    input: z.object({ collection_json: z.string().min(2).max(50_000_000), workspace_id: optWorkspace }),
  },
  open_in_app: {
    title: 'Show in Slinger',
    description: 'Opens a request in a tab of the Slinger window so the user sees it.',
    input: z.object({ request_id: id }),
  },
} satisfies Record<string, McpToolSpec>

export type McpToolName = keyof typeof MCP_TOOLS
export const MCP_TOOL_NAMES = Object.keys(MCP_TOOLS) as McpToolName[]
export type McpToolArgs<T extends McpToolName> = z.infer<(typeof MCP_TOOLS)[T]['input']>

/** main -> renderer: run one tool. */
export interface McpCall {
  id: string
  tool: McpToolName
  args: unknown
}

/** renderer -> main: what the tool produced. `text` is what the LLM reads; `data` becomes structured content. */
export type McpCallResult = { ok: true; text: string; data?: Record<string, unknown> } | { ok: false; error: string }

export interface McpSettings {
  enabled: boolean
  port: number
}

export interface McpStatus extends McpSettings {
  /** The endpoint is listening. */
  running: boolean
  /** Why it is not running although enabled (e.g. no free port). */
  error: string | null
  /** Set when the chosen port was busy and a nearby one is used instead. */
  portNote: string | null
  /** e.g. http://127.0.0.1:7354/mcp (the port actually in use while running). */
  url: string
  /** Unix seconds of the last tool call, or null. */
  lastCallAt: number | null
  calls: number
  /**
   * What connected assistants run: Slinger's executable in Node mode with the bridge kept in Slinger's data folder
   * (<userData>/mcp/bridge.cjs). No token or port: the bridge reads them, and starts Slinger when it is not running.
   */
  stdio: { command: string; args: string[]; env: Record<string, string> }
}

export type McpClientId = 'claude-desktop' | 'claude-code' | 'cursor' | 'vscode' | 'windsurf'

export interface McpClientStatus {
  id: McpClientId
  name: string
  /** Found on this computer (its config folder exists, or the `claude` command for Claude Code). */
  installed: boolean
  /** connected: has Slinger's entry; outdated: has an entry for another Slinger location (Connect again fixes it). */
  state: 'connected' | 'outdated' | 'not-connected'
  /** The file Slinger edits (Claude Code: the command it runs instead). */
  configPath: string | null
  /** What to do after connecting, e.g. "Restart Claude Desktop." */
  afterConnect: string
}
