import { z } from 'zod'
import type { SlingerInvokeApi } from '../../shared/ipc-contract'
import type { PickFileOptions, TitleBarStyle, UpdateCheckResult, UpdateInstallState, WindowAction, WindowChrome } from '../../shared/types'
import { MOCK_LIMITS, MOCK_MAX_DELAY_MS } from '../../shared/types'
import { invalidInput, ioError } from '../lib/errors'
import { isUuid } from '../lib/ids'
import { assertExternalUrl } from '../services/externalUrl'
import { hasUnresolvedPlaceholder } from '../services/httpExecutor'
import { importPostmanCollection, replaceCollectionFromPostman } from '../services/postmanImport'
import { extractFolderToCollection } from '../services/extractFolder'
import { applyUpdate, linkSpec, planUpdateFrom } from '../openapi/update'
import * as versions from '../services/collectionVersions'
import { OAUTH2_GRANT_TYPES } from '../../shared/oauth2'
import type { Core } from '../services/core'
import { cssColorSchema } from '../lib/windowState'
import { collectVersionInfo } from '../lib/versionInfo'
import { createSyncIpc } from './syncApi'

// ---------------------------------------------------------------------------
// Input schemas. Every IPC argument list is parsed here, before any repository is touched.
// ---------------------------------------------------------------------------

const uuid = z.string().refine(isUuid, { message: 'must be a valid UUID' })
const name = z.string().min(1).max(500)
const text = z.string().max(1_000_000)
const nullableUuid = uuid.nullish()
const index = z.number().int().min(0)
const postmanFile = z.string().max(50 * 1024 * 1024)
const workflowName = z.string().min(1).max(200)
const graphJson = z.string().max(5 * 1024 * 1024)
const createWorkflowInput = z.object({ workspaceId: uuid, name: workflowName, graphJson: graphJson.optional() }).strict()
const updateWorkflowInput = z
  .object({ workflowId: uuid, expectedVersion: z.number().int().min(1), name: workflowName.optional(), graphJson: graphJson.optional() })
  .strict()
const postmanImportOptions = z.object({ name: z.string().min(1).max(200).optional() }).strict()
const openApiSource = z.object({ kind: z.enum(['url', 'file', 'text']), value: z.string().max(4096).nullable() }).strict()
const openApiFolders = z.enum(['tags', 'paths', 'none'])
const openApiPreviewInput = z.object({ text: postmanFile.nullish(), url: z.string().max(4096).nullish() }).strict()
const openApiValidationInput = z
  .object({
    collectionId: uuid,
    requestId: uuid.nullish(),
    method: z.string().min(1).max(64),
    url: z.string().max(65536),
    status: z.number().int().min(0).max(999),
    contentType: z.string().max(1024).nullable(),
    // Bodies over 5 MB are answered "too large to check" by the validator, not rejected here.
    body: z.string().max(20 * 1024 * 1024),
    bodyEncoding: z.literal('base64').nullable(),
  })
  .strict()
const openApiImportInput = z
  .object({ workspaceId: uuid, text: postmanFile, source: openApiSource, folders: openApiFolders, name: z.string().min(1).max(200).optional() })
  .strict()
// OpenAPI updates
const openApiPlanInput = z
  .object({ collectionId: uuid, text: postmanFile.nullish(), url: z.string().max(4096).nullish(), source: openApiSource.optional() })
  .strict()
const openApiApplyInput = z
  .object({
    collectionId: uuid,
    planId: uuid,
    choices: z.record(z.string().max(4200), z.enum(['apply', 'keep', 'delete', 'skip'])).refine((c) => Object.keys(c).length <= 20_000, { message: 'too many choices' }),
  })
  .strict()
const openApiLinkInput = z.object({ collectionId: uuid, text: postmanFile, source: openApiSource, folders: openApiFolders }).strict()

const pickFileOptions = z
  .object({
    title: z.string().max(200).optional(),
    defaultPath: z.string().max(4096).optional(),
    filters: z
      .array(
        z.object({
          name: z.string().max(100),
          // Extensions without dots or path characters ('*' alone means "all files").
          extensions: z.array(z.string().regex(/^(\*|[A-Za-z0-9_-]{1,20})$/)).max(50),
        }),
      )
      .max(20)
      .optional(),
  })
  .strict()

const requestHeader = z.object({ key: z.string().max(8192), value: z.string().max(65_536) })

// ---- Mock servers --------------------------------------------------------------

const mockHeader = z.object({ key: z.string().max(MOCK_LIMITS.headerKey), value: z.string().max(MOCK_LIMITS.headerValue) })
const mockExample = z
  .object({
    requestId: uuid,
    exampleIndex: z.number().int().min(0).max(100_000),
    requestName: z.string().max(MOCK_LIMITS.name),
    name: z.string().max(MOCK_LIMITS.name),
    method: z.string().min(1).max(MOCK_LIMITS.method),
    url: z.string().max(MOCK_LIMITS.url),
    code: z.number().int().min(100).max(999).nullable(),
    status: z.string().max(MOCK_LIMITS.name),
    headers: z.array(mockHeader).max(MOCK_LIMITS.headers),
    body: z.string().max(MOCK_LIMITS.body),
    bodyEncoding: z.enum(['base64']).nullable(),
    requestBody: z.string().max(MOCK_LIMITS.requestBody).nullable(),
    requestHeaders: z.array(mockHeader).max(MOCK_LIMITS.headers).optional(),
    id: z.string().max(MOCK_LIMITS.id).nullable().optional(),
  })
  .strict()
const mockExamples = z.array(mockExample).max(MOCK_LIMITS.examples)
const mockServerOptions = z.object({ cors: z.enum(['local', 'any']), delayMs: z.number().int().min(0).max(MOCK_MAX_DELAY_MS) }).strict()
const collectionName = z.string().max(500)
const startMockServerInput = z
  .object({
    workspaceId: uuid,
    collectionId: uuid,
    collectionName,
    port: z.number().int().min(1).max(65_535),
    examples: mockExamples,
    options: mockServerOptions.optional(),
  })
  .strict()

const httpRequestInput = z.object({
  method: z.string().min(1).max(32),
  url: z.string().max(100_000),
  headers: z.array(requestHeader).max(500),
  auth: z.object({
    kind: z.enum(['none', 'basic', 'bearer', 'apiKey', 'oauth2']),
    basic: z.object({ username: z.string().max(65_536), password: z.string().max(65_536) }).optional(),
    bearer: z.object({ token: z.string().max(65_536) }).optional(),
    apiKey: z
      .object({ key: z.string().max(8192), value: z.string().max(65_536), addTo: z.enum(['header', 'query']) })
      .optional(),
    oauth2: z
      .object({ tokenKey: z.string().regex(/^[0-9a-f]{64}$/), addTo: z.enum(['header', 'query']), headerPrefix: z.string().max(256) })
      .optional(),
  }),
  body: z.object({
    mode: z.enum(['none', 'raw', 'formData', 'urlEncoded', 'binary']),
    raw: z.object({ content: z.string(), contentType: z.string().max(1024) }).optional(),
    formData: z
      .array(
        z.object({
          key: z.string().max(8192),
          value: z.string(),
          filePath: z.string().max(4096).optional(),
          type: z.enum(['text', 'file']),
          enabled: z.boolean(),
        }),
      )
      .max(1000)
      .optional(),
    urlEncoded: z
      .array(z.object({ key: z.string().max(8192), value: z.string(), enabled: z.boolean() }))
      .max(1000)
      .optional(),
    binaryFilePath: z.string().max(4096).optional(),
  }),
  timeoutMs: z.number().int().positive().max(3_600_000).optional(),
  requestId: z.string().max(128).nullish(),
  requestName: z.string().max(500).nullish(),
  workspaceId: uuid,
  requestRunId: z.string().max(128).nullish(),
  historyUrl: z.string().max(100_000).nullish(),
  historySource: z.literal('mcp').nullish(),
  scriptSessionId: z.string().max(128).nullish(),
  maxResponseBytes: z.number().int().positive().optional(),
  downloadId: z.string().uuid().optional(),
  cookies: z.enum(['jar', 'off']).optional(),
})

// ---- Cookie jar ------------------------------------------------------------------

const sameSite = z.enum(['Strict', 'Lax', 'None']).nullable()
const upsertCookieInput = z
  .object({
    workspaceId: uuid,
    id: uuid.optional(),
    name: z.string().min(1).max(4096),
    value: z.string().max(4096).optional(),
    domain: z.string().min(1).max(253),
    hostOnly: z.boolean(),
    path: z.string().max(1024),
    expiresAt: z.number().int().min(0).max(32_503_680_000).nullable(),
    secure: z.boolean(),
    httpOnly: z.boolean(),
    sameSite,
  })
  .strict()
const cookieDomains = z.array(z.string().max(253)).max(500)

/** A file name for the save dialog's suggestion: no folders, no control or reserved characters. */
export function safeDownloadName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const clean = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/^[.\s]+/, '').trim().slice(0, 200)
  return clean || 'response'
}

// ---- OAuth 2.0 ----------------------------------------------------------------

const oauth2Text = z.string().max(8192)
const oauth2Config = z
  .object({
    workspaceId: uuid,
    grantType: z.enum(OAUTH2_GRANT_TYPES),
    authUrl: oauth2Text,
    accessTokenUrl: oauth2Text,
    clientId: oauth2Text,
    clientSecret: oauth2Text,
    scope: oauth2Text,
    state: z.string().max(1024),
    redirectUri: z.string().max(2048),
    username: oauth2Text,
    password: oauth2Text,
    challengeAlgorithm: z.enum(['S256', 'plain']),
    codeVerifier: z.string().max(128),
    clientAuthentication: z.enum(['header', 'body']),
    refreshTokenUrl: oauth2Text,
    audience: oauth2Text,
    resource: oauth2Text,
  })
  .strict()
const oauth2FlowId = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/)
const oauth2TokenKey = z.string().regex(/^[0-9a-f]{64}$/)

const cloudFetchInput = z.object({
  method: z.string().min(1).max(32),
  url: z.string().max(100_000),
  headers: z.array(requestHeader).max(100),
  body: z.object({ content: z.string().max(10_000_000), contentType: z.string().max(1024) }).nullish(),
  timeoutMs: z.number().int().positive().max(3_600_000).optional(),
})

const createRequestInput = z.object({
  workspaceId: uuid,
  collectionId: uuid,
  folderId: nullableUuid,
  name,
  method: z.string().min(1).max(32),
  url: z.string().max(100_000),
  documentJson: z.string(),
})
const updateRequestInput = z.object({
  requestId: uuid,
  name,
  method: z.string().min(1).max(32),
  url: z.string().max(100_000),
  documentJson: z.string(),
  expectedVersion: z.number().int().min(1),
})
const moveRequestInput = z.object({
  requestId: uuid,
  targetCollectionId: uuid,
  targetFolderId: uuid.nullable(),
  targetIndex: index,
})
const createFolderInput = z.object({
  workspaceId: uuid,
  collectionId: uuid,
  parentFolderId: nullableUuid,
  name,
})
const moveFolderInput = z.object({
  folderId: uuid,
  targetParentFolderId: uuid.nullable(),
  targetIndex: index,
})
const upsertVariableInput = z.object({
  environmentId: uuid,
  key: z.string().min(1).max(256),
  value: z.string().max(1_000_000),
  isSecret: z.boolean(),
  variableId: uuid.optional(),
  expectedVersion: z.number().int().min(1).optional(),
})
// ---- persisted variables (collection variables + globals) --------------------------

const varKey = z.string().min(1).max(256)
const varValue = z.string().max(1_000_000)
const varDescription = z.string().max(100_000).nullable().optional()
const upsertCollectionVariableInput = z
  .object({
    collectionId: uuid,
    key: varKey,
    value: varValue,
    enabled: z.boolean().optional(),
    description: varDescription,
    variableId: uuid.optional(),
    expectedVersion: z.number().int().min(1).optional(),
    // Collection variables are never secret; accepted only as `false` so the repository can give a clear error.
    isSecret: z.boolean().optional(),
  })
  .strict()
const upsertGlobalVariableInput = z
  .object({
    workspaceId: uuid,
    key: varKey,
    value: varValue,
    isSecret: z.boolean(),
    enabled: z.boolean().optional(),
    description: varDescription,
    variableId: uuid.optional(),
    expectedVersion: z.number().int().min(1).optional(),
  })
  .strict()
const variableEntries = z
  .array(z.object({ key: varKey, value: varValue, enabled: z.boolean().optional(), description: varDescription, isSecret: z.boolean().optional() }).strict())
  .max(5000)
const variableIds = z.array(uuid).max(5000)

const createVersionInput = z.object({
  collectionId: uuid,
  version: z.string().min(1).max(128),
  notes: z.string().max(10_000).nullish(),
})

// ---- scripts ----------------------------------------------------------------

const scriptKv = z.object({ key: z.string().max(8192), value: z.string().max(65_536), disabled: z.boolean().optional() })
const scriptRequest = z.object({
  method: z.string().min(1).max(32),
  url: z.string().max(100_000),
  headers: z.array(scriptKv).max(500),
  body: z.object({
    mode: z.enum(['none', 'raw', 'urlencoded', 'formdata', 'file', 'other']),
    raw: z.string().max(10 * 1024 * 1024).optional(),
    language: z.string().max(32).optional(),
    urlencoded: z.array(scriptKv).max(1000).optional(),
    formdata: z.array(scriptKv).max(1000).optional(),
  }),
  auth: z
    .object({ type: z.string().max(64), params: z.array(z.object({ key: z.string().max(256), value: z.string().max(65_536) })).max(100) })
    .nullish(),
})
const scriptResponse = z.object({
  code: z.number().int().min(0).max(999),
  status: z.string().max(1024),
  headers: z.array(requestHeader).max(1000),
  body: z.string().max(64 * 1024 * 1024).nullable(),
  responseTime: z.number().min(0),
  size: z.number().min(0),
})
/** Scope values are JSON data; the whole record is capped by its serialized size. */
const scriptVariables = z
  .record(z.string().max(256), z.unknown())
  .refine((v) => JSON.stringify(v).length <= 20 * 1024 * 1024, { message: 'variables are too large' })
const runScriptsInput = z.object({
  runId: z.string().max(128),
  sessionId: z.string().max(128),
  workspaceId: uuid,
  environmentId: uuid.nullable(),
  event: z.enum(['prerequest', 'test']),
  scripts: z
    .array(z.object({ origin: z.enum(['collection', 'folder', 'request']), name: z.string().max(500), code: z.string().max(1_000_000) }))
    .max(110),
  request: scriptRequest,
  response: scriptResponse.nullish(),
  variables: scriptVariables,
  collectionId: uuid.nullish(),
  collectionVariables: scriptVariables.optional(),
  globals: scriptVariables.optional(),
  info: z.object({
    requestName: z.string().max(500),
    requestId: z.string().max(128).nullable(),
    iteration: z.number().int().min(0),
    iterationCount: z.number().int().min(0),
  }),
  iterationData: scriptVariables.optional(),
  timeoutMs: z.number().int().min(1).max(60_000).optional(),
  sendRequestTimeoutMs: z.number().int().min(1).max(10 * 60_000).optional(),
  continueOnError: z.boolean().optional(),
  denySecrets: z.string().min(1).max(1000).optional(),
})
const scriptsJson = z.string().max(4 * 1024 * 1024).nullable()
const extractFolderInput = z.object({
  folderId: uuid,
  name,
  scriptsJson: scriptsJson.optional(),
  copyCollectionVariables: z.boolean(),
})
const description = z.string().max(4 * 1024 * 1024).nullable()
/** ADDED (container auth): Postman `auth` JSON of a collection/folder; validated and token-stripped by the repository. */
const authJson = z.string().max(2 * 1024 * 1024).nullable()

/** Parses `args` against a tuple schema and turns zod failures into invalid_input errors. */
function parseArgs<T extends z.ZodType>(schema: T, args: unknown[]): z.infer<T> {
  const result = schema.safeParse(args)
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
    const first = issues[0]
    throw invalidInput(`Invalid input${first ? ` (${first.path || 'argument'}: ${first.message})` : ''}`, { issues })
  }
  return result.data
}

export interface PlatformDeps {
  openExternal(url: string): Promise<void>
  /** Shows a native folder picker; resolves to the chosen directory or null. */
  chooseDirectory(): Promise<string | null>
  /** Shows a native open-file dialog (single selection); resolves to the chosen absolute path or null. */
  pickFile(options: PickFileOptions): Promise<string | null>
  /** Shows a native save dialog (`defaultName` in the Downloads folder); the chosen absolute path or null. Optional: tests. */
  saveFile?(options: { title: string; defaultName: string }): Promise<string | null>
  appVersion: string
  /** Paints + remembers the window background (already validated and normalised to `#rrggbb`). Optional: tests omit it. */
  setWindowBackground?(color: string): void
  /** Latest-release lookup (services/updateCheck.ts); absent when update checks are off (automated runs, tests). */
  checkForUpdates?(): Promise<UpdateCheckResult>
  /** The in-app updater (services/updateInstall.ts); absent in tests and runs without update checks. */
  updates?: {
    state(): UpdateInstallState
    download(): UpdateInstallState
    cancel(): UpdateInstallState
    install(): Promise<UpdateInstallState>
  }
  /** The main window's frame (custom title bar). Optional: tests omit it. */
  window?: WindowControls
}

export interface WindowControls {
  chrome(): WindowChrome
  setTitleBarStyle(style: TitleBarStyle): WindowChrome
  setCloseToTray(enabled: boolean): WindowChrome
  reopen(): void
  control(action: WindowAction): void
  /** CSS pixels within the page. */
  showAppMenu(x: number, y: number): void
  /** The window's unsaved edits that would be lost on quit (titles); quitting asks first while there are any. */
  setUnsavedChanges?(titles: string[]): void
}

const assistantEdit = z
  .object({
    workspaceId: uuid,
    requestId: uuid.nullable(),
    requestName: z.string().max(500).nullable(),
    method: z.string().max(32),
    url: z.string().max(8192),
    detail: z.string().min(1).max(1000),
  })
  .strict()
const assistantChangeRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('request'), requestId: uuid, created: z.boolean().optional(), pending: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal('variable'), environmentId: uuid, key: z.string().min(1).max(500), pending: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal('container'), containerKind: z.enum(['collection', 'folder']), id: uuid, pending: z.boolean().optional() }).strict(),
])
const redactSecretsInput = z
  .object({
    scriptSessionId: z.string().max(128).nullable(),
    oauth2TokenKey: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    texts: z.array(z.string().max(64 * 1024 * 1024)).max(10_000),
    cookies: z.object({ workspaceId: uuid, responseSetCookies: z.array(z.string().max(65_536)).max(1000) }).strict().nullish(),
  })
  .strict()
/** An origin as `new URL(x).origin` prints it: http(s)://host[:port]. */
const httpOrigin = z
  .string()
  .max(2048)
  .refine((v) => {
    try {
      const u = new URL(v)
      return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === v
    } catch {
      return false
    }
  }, { message: 'must be an http(s) origin' })
const mcpClientId = z.enum(['claude-desktop', 'claude-code', 'cursor', 'vscode', 'windsurf'])
const mcpSettings = z.object({ enabled: z.boolean(), port: z.number().int().min(1024).max(65535) }).strict()
const mcpCallResult = z.union([
  z.object({ ok: z.literal(true), text: z.string().max(20_000_000), data: z.record(z.string(), z.unknown()).optional() }).strict(),
  z.object({ ok: z.literal(false), error: z.string().max(100_000) }).strict(),
])

// ---- MCP client (MCP requests) -------------------------------------------------
// Inputs are fully resolved by the renderer; any `{{variable}}` left in what reaches the server or the command line is
// rejected (like the HTTP path), so a template never runs or goes on the wire.

const MCP_MAX_TIMEOUT_MS = 600_000
const mcpSessionId = z.string().min(1).max(128)
const mcpRunId = z.string().min(1).max(128)
const mcpKv = z.object({ key: z.string().max(8192), value: z.string().max(65_536) }).strict()
const mcpCommand = z.string().min(1).max(4096)
const mcpArgs = z.array(z.string().max(32_768)).max(1000)
const mcpCwd = z.string().max(4096)
/** stdio: the command's extra environment (a key is required). */
const mcpEnv = z.array(mcpKv.extend({ key: z.string().min(1).max(1024) })).max(500)
const httpUrl = z
  .string()
  .min(1)
  .max(100_000)
  .refine(
    (u) => {
      try {
        const p = new URL(u).protocol
        return p === 'http:' || p === 'https:'
      } catch {
        return false
      }
    },
    { message: 'must be an http(s) URL' },
  )
const mcpConnectInput = z
  .object({
    workspaceId: uuid,
    transport: z.enum(['http', 'sse', 'stdio']),
    url: z.string().max(100_000).optional(),
    headers: z.array(mcpKv).max(500).optional(),
    command: z.string().max(4096).optional(),
    args: mcpArgs.optional(),
    env: mcpEnv.optional(),
    cwd: mcpCwd.optional(),
    origin: z.enum(['user', 'runner', 'workflow', 'mcp']),
    timeoutMs: z.number().int().min(1).max(MCP_MAX_TIMEOUT_MS).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.transport === 'stdio') {
      if (!mcpCommand.safeParse(v.command).success) ctx.addIssue({ code: 'custom', path: ['command'], message: 'a command is required for stdio' })
    } else if (!httpUrl.safeParse(v.url).success) {
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'must be an http(s) URL' })
    }
  })
/** JSON values (tool arguments), capped by their serialized size. */
const mcpArguments = z
  .record(z.string().max(8192), z.unknown())
  .refine((v) => JSON.stringify(v).length <= 10 * 1024 * 1024, { message: 'arguments are too large' })
const mcpCallInput = z
  .object({
    sessionId: mcpSessionId,
    operation: z.enum(['tools/call', 'resources/read', 'prompts/get']),
    name: z.string().max(1000).optional(),
    uri: z.string().max(100_000).optional(),
    arguments: mcpArguments.optional(),
    requestRunId: mcpRunId,
    timeoutMs: z.number().int().min(1).max(MCP_MAX_TIMEOUT_MS).optional(),
    workspaceId: uuid,
    requestId: z.string().max(128).nullish(),
    requestName: z.string().max(500).nullish(),
    historySource: z.literal('mcp').nullish(),
    historyUrl: z.string().max(100_000),
    historyDetail: z.string().max(100_000).optional(),
    scriptSessionId: z.string().max(128).nullish(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.operation === 'resources/read') {
      if (!v.uri) ctx.addIssue({ code: 'custom', path: ['uri'], message: 'a resource URI is required' })
    } else if (!v.name) {
      ctx.addIssue({ code: 'custom', path: ['name'], message: `a ${v.operation === 'tools/call' ? 'tool' : 'prompt'} name is required` })
    }
    if (v.operation === 'prompts/get' && v.arguments && Object.values(v.arguments).some((x) => typeof x !== 'string')) {
      ctx.addIssue({ code: 'custom', path: ['arguments'], message: 'prompt arguments must be strings' })
    }
  })
const mcpTrustInput = z.object({ command: mcpCommand, args: mcpArgs, cwd: mcpCwd, env: mcpEnv.default([]) }).strict()
const mcpListKind = z.enum(['tools', 'resources', 'resourceTemplates', 'prompts'])

/** Throws invalid_input when any of these labelled strings still holds an unresolved `{{variable}}`. */
function assertResolved(parts: Array<[string, string | undefined]>): void {
  for (const [where, value] of parts) {
    if (hasUnresolvedPlaceholder(value)) {
      throw invalidInput(`Unresolved variable in ${where}: define it in the active environment`, { location: where })
    }
  }
}

/** Every key and string inside a JSON value, labelled with its path (`arguments.a.b`). */
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

function commandParts(c: { command?: string; args?: string[]; cwd?: string; env?: Array<{ key: string; value: string }> }): Array<[string, string | undefined]> {
  return [
    ['command', c.command],
    ...(c.args ?? []).map((a, i): [string, string] => [`argument ${i + 1}`, a]),
    ['working directory', c.cwd],
    ...(c.env ?? []).flatMap((e): Array<[string, string]> => [[`environment variable "${e.key}" name`, e.key], [`environment variable "${e.key}"`, e.value]]),
  ]
}

const titleBarStyle = z.enum(['custom', 'system'])
const windowAction = z.enum(['minimize', 'toggleMaximize', 'close'])
const pagePoint = z.number().finite().min(0).max(100_000)

/**
 * Builds the full SlingerIpcApi over a Core. This is the validation boundary: electron/ipc/handlers.ts
 * exposes exactly these functions over IPC. Lives outside handlers.ts so it can be tested under
 * plain Node (no `electron` import).
 */
export function createIpcApi(core: Core, platform: PlatformDeps): SlingerInvokeApi {
  return {
    // Workspaces
    listWorkspaces: async (...a) => (parseArgs(z.tuple([]), a), core.workspaces.list()),
    createWorkspace: async (...a) => core.workspaces.create(parseArgs(z.tuple([name]), a)[0]),
    renameWorkspace: async (...a) => {
      const [id, n] = parseArgs(z.tuple([uuid, name]), a)
      return core.workspaces.rename(id, n)
    },
    deleteWorkspace: async (...a) => {
      const [id] = parseArgs(z.tuple([uuid]), a)
      core.workspaces.softDelete(id)
      // Its OAuth 2.0 tokens go with it (like its secret variables).
      core.oauth2.deleteWorkspaceTokens(id)
    },

    // Environments
    listEnvironments: async (...a) => core.environments.list(parseArgs(z.tuple([uuid]), a)[0]),
    ensureDefaultEnvironment: async (...a) => core.environments.ensureDefault(parseArgs(z.tuple([uuid]), a)[0]),
    createEnvironment: async (...a) => {
      const [id, n] = parseArgs(z.tuple([uuid, name]), a)
      return core.environments.create(id, n)
    },
    renameEnvironment: async (...a) => {
      const [id, n] = parseArgs(z.tuple([uuid, name]), a)
      return core.environments.rename(id, n)
    },
    deleteEnvironment: async (...a) => core.environments.softDelete(parseArgs(z.tuple([uuid]), a)[0]),
    listEnvironmentVariables: async (...a) => core.environments.listVariables(parseArgs(z.tuple([uuid]), a)[0]),
    upsertEnvironmentVariable: async (...a) => core.environments.upsertVariable(parseArgs(z.tuple([upsertVariableInput]), a)[0]),
    deleteEnvironmentVariable: async (...a) => core.environments.deleteVariable(parseArgs(z.tuple([uuid]), a)[0]),
    revealEnvironmentVariable: async (...a) => core.environments.reveal(parseArgs(z.tuple([uuid]), a)[0]),

    // Collections
    listCollections: async (...a) => core.collections.list(parseArgs(z.tuple([uuid]), a)[0]),
    createCollection: async (...a) => {
      const [id, n] = parseArgs(z.tuple([uuid, name]), a)
      return core.collections.create(id, n)
    },
    renameCollection: async (...a) => {
      const [id, n] = parseArgs(z.tuple([uuid, name]), a)
      return core.collections.rename(id, n)
    },
    deleteCollection: async (...a) => core.collections.softDelete(parseArgs(z.tuple([uuid]), a)[0]),
    trustCollectionScripts: async (...a) => core.trust.trustCollection(parseArgs(z.tuple([uuid]), a)[0]),
    setCollectionScripts: async (...a) => {
      const [id, json] = parseArgs(z.tuple([uuid, scriptsJson]), a)
      return core.collections.setScripts(id, json)
    },
    setCollectionDescription: async (...a) => {
      const [id, text] = parseArgs(z.tuple([uuid, description]), a)
      return core.collections.setDescription(id, text)
    },
    setCollectionAuth: async (...a) => {
      const [id, json] = parseArgs(z.tuple([uuid, authJson]), a)
      return core.collections.setAuth(id, json)
    },

    // Folders
    listFolders: async (...a) => core.folders.list(parseArgs(z.tuple([uuid]), a)[0]),
    createFolder: async (...a) => core.folders.create(parseArgs(z.tuple([createFolderInput]), a)[0]),
    renameFolder: async (...a) => {
      const [id, n] = parseArgs(z.tuple([uuid, name]), a)
      return core.folders.rename(id, n)
    },
    moveFolder: async (...a) => core.folders.move(parseArgs(z.tuple([moveFolderInput]), a)[0]),
    extractFolderToCollection: async (...a) => extractFolderToCollection(core.db, parseArgs(z.tuple([extractFolderInput]), a)[0]),
    deleteFolder: async (...a) => core.folders.softDelete(parseArgs(z.tuple([uuid]), a)[0]),
    setFolderScripts: async (...a) => {
      const [id, json] = parseArgs(z.tuple([uuid, scriptsJson]), a)
      return core.folders.setScripts(id, json)
    },
    setFolderDescription: async (...a) => {
      const [id, text] = parseArgs(z.tuple([uuid, description]), a)
      return core.folders.setDescription(id, text)
    },
    setFolderAuth: async (...a) => {
      const [id, json] = parseArgs(z.tuple([uuid, authJson]), a)
      return core.folders.setAuth(id, json)
    },

    // Requests
    listRequests: async (...a) => core.requests.list(parseArgs(z.tuple([uuid]), a)[0]),
    createRequest: async (...a) => core.requests.create(parseArgs(z.tuple([createRequestInput]), a)[0]),
    updateRequest: async (...a) => core.requests.update(parseArgs(z.tuple([updateRequestInput]), a)[0]),
    renameRequest: async (...a) => {
      const [id, n] = parseArgs(z.tuple([uuid, name]), a)
      return core.requests.rename(id, n)
    },
    moveRequest: async (...a) => core.requests.move(parseArgs(z.tuple([moveRequestInput]), a)[0]),
    deleteRequest: async (...a) => core.requests.softDelete(parseArgs(z.tuple([uuid]), a)[0]),

    // History
    listHistory: async (...a) => {
      const [id, limit] = parseArgs(z.tuple([uuid, z.number().int().min(1).max(1000).optional()]), a)
      return core.history.list(id, limit)
    },
    clearHistory: async (...a) => core.history.clear(parseArgs(z.tuple([uuid]), a)[0]),
    deleteHistoryEntry: async (...a) => core.history.deleteEntry(parseArgs(z.tuple([uuid]), a)[0]),
    recordAssistantEdit: async (...a) => {
      const [e] = parseArgs(z.tuple([assistantEdit]), a)
      return core.history.record({ ...e, statusCode: null, ok: true, errorMessage: null, durationMs: 0, kind: 'edit', source: 'mcp' })
    },
    markAssistantChange: async (...a) => core.trust.markAssistantChange(parseArgs(z.tuple([assistantChangeRef]), a)[0]),
    clearAssistantChange: async (...a) => core.trust.clearAssistantChange(parseArgs(z.tuple([assistantChangeRef]), a)[0]),
    listAssistantChanges: async (...a) => core.trust.listAssistantChanges(parseArgs(z.tuple([uuid]), a)[0]),
    redactSecrets: async (...a) => {
      const [input] = parseArgs(z.tuple([redactSecretsInput]), a)
      const texts = input.texts.map((t) => core.oauth2.redactToken(input.oauth2TokenKey, core.scripts.redact(input.scriptSessionId, t)))
      // Cookie values of the workspace's jar (not the ones the response set itself).
      return input.cookies ? core.cookies.redact(input.cookies.workspaceId, texts, input.cookies.responseSetCookies) : texts
    },

    // HTTP execution
    executeHttpRequest: async (...a) => core.http.execute(parseArgs(z.tuple([httpRequestInput]), a)[0]),
    cloudFetch: async (...a) => core.http.fetchInternal(parseArgs(z.tuple([cloudFetchInput]), a)[0]),

    // Cookie jar (services/cookieJar.ts; local only, values encrypted at rest)
    listCookies: async (...a) => core.cookies.list(parseArgs(z.tuple([uuid]), a)[0]),
    revealCookie: async (...a) => core.cookies.reveal(parseArgs(z.tuple([uuid]), a)[0]),
    upsertCookie: async (...a) => core.cookies.upsert(parseArgs(z.tuple([upsertCookieInput]), a)[0]),
    deleteCookie: async (...a) => core.cookies.delete(parseArgs(z.tuple([uuid]), a)[0]),
    clearCookies: async (...a) => {
      const [id, domain] = parseArgs(z.tuple([uuid, z.string().min(1).max(253).nullable()]), a)
      return core.cookies.clear(id, domain)
    },
    getCookieScriptDomains: async (...a) => core.cookies.scriptDomains(parseArgs(z.tuple([uuid]), a)[0]),
    setCookieScriptDomains: async (...a) => {
      const [id, domains] = parseArgs(z.tuple([uuid, cookieDomains]), a)
      return core.cookies.setScriptDomains(id, domains)
    },
    cancelHttpRequest: async (...a) => {
      const [runId] = parseArgs(z.tuple([z.string().max(128)]), a)
      core.http.cancel(runId)
      core.scripts.cancel(runId)
    },
    chooseResponseDownloadFile: async (...a) => {
      const [name] = parseArgs(z.tuple([z.string().max(1000)]), a)
      if (!platform.saveFile) throw invalidInput('Saving files is not available here')
      const path = await platform.saveFile({ title: 'Download the response to', defaultName: safeDownloadName(name) })
      return path ? core.http.registerDownload(path) : null
    },
    runScripts: async (...a) => core.scripts.run(parseArgs(z.tuple([runScriptsInput]), a)[0]),

    // Postman import/export
    importPostmanCollection: async (...a) => {
      const [id, contents, options] = parseArgs(z.tuple([uuid, postmanFile, postmanImportOptions.optional()]), a)
      return importPostmanCollection(core.db, id, contents, options ?? {})
    },
    replaceCollectionFromPostman: async (...a) => {
      const [id, contents, sourceName] = parseArgs(z.tuple([uuid, postmanFile, z.string().max(1024).nullish()]), a)
      return replaceCollectionFromPostman(core.db, id, contents, sourceName, core.versionAuthor())
    },
    // OpenAPI
    previewOpenApi: async (...a) => core.openapi.preview(parseArgs(z.tuple([openApiPreviewInput]), a)[0]),
    importOpenApi: async (...a) => core.openapi.import(parseArgs(z.tuple([openApiImportInput]), a)[0]),
    getOpenApiLink: async (...a) => core.openapi.getLink(parseArgs(z.tuple([uuid]), a)[0]),
    unlinkOpenApi: async (...a) => core.openapi.unlink(parseArgs(z.tuple([uuid]), a)[0]),
    validateOpenApiResponse: async (...a) => core.openapi.validation.validate(parseArgs(z.tuple([openApiValidationInput]), a)[0]),
    // OpenAPI updates
    planOpenApiUpdate: async (...a) => planUpdateFrom(core.db, core.openapi, parseArgs(z.tuple([openApiPlanInput]), a)[0]),
    applyOpenApiUpdate: async (...a) => applyUpdate(core.db, core.openapi, parseArgs(z.tuple([openApiApplyInput]), a)[0], core.versionAuthor()),
    linkOpenApi: async (...a) => linkSpec(core.db, core.openapi, parseArgs(z.tuple([openApiLinkInput]), a)[0]),
    defaultExportPath: async (...a) => core.exportFiles.pathFor(parseArgs(z.tuple([z.string().max(1024)]), a)[0]),
    writeExportFile: async (...a) => {
      const [fileName, contents, encoding] = parseArgs(
        z.tuple([z.string().max(1024), z.string(), z.enum(['utf8', 'base64']).optional()]),
        a,
      )
      await core.exportFiles.write(fileName, contents, encoding ?? 'utf8')
    },
    pickFile: async (...a) => {
      const [options] = parseArgs(z.tuple([pickFileOptions.optional()]), a)
      const path = await platform.pickFile(options ?? {})
      // Only a path the OS dialog just returned is ever granted; the renderer cannot grant anything itself.
      if (path) await core.fileGrants.grant(path)
      return path
    },
    grantedFiles: async (...a) => core.fileGrants.filterGranted(parseArgs(z.tuple([z.array(z.string().max(4096)).max(2000)]), a)[0]),
    chooseExportDirectory: async (...a) => {
      parseArgs(z.tuple([]), a)
      const dir = await platform.chooseDirectory()
      if (dir) core.exportFiles.setDirectory(dir)
      return dir
    },

    // Collection versions
    listCollectionVersions: async (...a) => versions.listCollectionVersions(core.db, parseArgs(z.tuple([uuid]), a)[0]),
    getCollectionVersion: async (...a) => versions.getCollectionVersion(core.db, parseArgs(z.tuple([uuid]), a)[0]),
    createCollectionVersion: async (...a) =>
      versions.createCollectionVersion(core.db, parseArgs(z.tuple([createVersionInput]), a)[0], core.versionAuthor()),
    restoreCollectionVersion: async (...a) => {
      const [id, mode] = parseArgs(z.tuple([uuid, z.enum(['replace', 'copy'])]), a)
      return versions.restoreCollectionVersion(core.db, id, mode)
    },
    deleteCollectionVersion: async (...a) => versions.deleteCollectionVersion(core.db, parseArgs(z.tuple([uuid]), a)[0]),

    // Secure storage (generic keychain passthrough; env-var secret namespace is reserved)
    // Workflows (repositories/workflows.ts; graphJson must be a JSON object)
    listWorkflows: async (...a) => core.workflows.list(parseArgs(z.tuple([uuid]), a)[0]),
    getWorkflow: async (...a) => core.workflows.get(parseArgs(z.tuple([uuid]), a)[0]),
    createWorkflow: async (...a) => core.workflows.create(parseArgs(z.tuple([createWorkflowInput]), a)[0]),
    updateWorkflow: async (...a) => core.workflows.update(parseArgs(z.tuple([updateWorkflowInput]), a)[0]),
    duplicateWorkflow: async (...a) => {
      const [id, n] = parseArgs(z.tuple([uuid, workflowName.optional()]), a)
      return core.workflows.duplicate(id, n)
    },
    deleteWorkflow: async (...a) => core.workflows.delete(parseArgs(z.tuple([uuid]), a)[0]),

    // Mock servers (services/mockServers.ts; local-only, in memory)
    startMockServer: async (...a) => core.mockServers.start(parseArgs(z.tuple([startMockServerInput]), a)[0]),
    updateMockServer: async (...a) => {
      const [collectionId, examples, name] = parseArgs(z.tuple([uuid, mockExamples, collectionName.optional()]), a)
      return core.mockServers.update(collectionId, examples, name)
    },
    setMockServerOptions: async (...a) => {
      const [collectionId, options] = parseArgs(z.tuple([uuid, mockServerOptions]), a)
      return core.mockServers.setOptions(collectionId, options)
    },
    stopMockServer: async (...a) => core.mockServers.stop(parseArgs(z.tuple([uuid]), a)[0]),
    listMockServers: async (...a) => (parseArgs(z.tuple([]), a), core.mockServers.list()),
    getMockServerLog: async (...a) => core.mockServers.log(parseArgs(z.tuple([uuid]), a)[0]),
    clearMockServerLog: async (...a) => core.mockServers.clearLog(parseArgs(z.tuple([uuid]), a)[0]),

    // Misc
    openExternalUrl: async (...a) => platform.openExternal(assertExternalUrl(parseArgs(z.tuple([z.string()]), a)[0])),
    prepareBrowserAuthCallback: async (...a) => (parseArgs(z.tuple([]), a), core.authCallbacks.prepare()),
    waitForBrowserAuthCallback: async (...a) => {
      const [id, timeout] = parseArgs(z.tuple([z.string(), z.number()]), a)
      return core.authCallbacks.wait(id, timeout)
    },

    // Persisted variables (local-only)
    listCollectionVariables: async (...a) => core.collectionVariables.list(parseArgs(z.tuple([uuid]), a)[0]),
    upsertCollectionVariable: async (...a) => core.collectionVariables.upsert(parseArgs(z.tuple([upsertCollectionVariableInput]), a)[0]),
    deleteCollectionVariable: async (...a) => core.collectionVariables.delete(parseArgs(z.tuple([uuid]), a)[0]),
    reorderCollectionVariables: async (...a) => {
      const [id, ids] = parseArgs(z.tuple([uuid, variableIds]), a)
      return core.collectionVariables.reorder(id, ids)
    },
    replaceCollectionVariables: async (...a) => {
      const [id, entries] = parseArgs(z.tuple([uuid, variableEntries]), a)
      return core.collectionVariables.replace(id, entries)
    },
    listGlobalVariables: async (...a) => core.globals.list(parseArgs(z.tuple([uuid]), a)[0]),
    upsertGlobalVariable: async (...a) => core.globals.upsert(parseArgs(z.tuple([upsertGlobalVariableInput]), a)[0]),
    deleteGlobalVariable: async (...a) => core.globals.delete(parseArgs(z.tuple([uuid]), a)[0]),
    reorderGlobalVariables: async (...a) => {
      const [id, ids] = parseArgs(z.tuple([uuid, variableIds]), a)
      return core.globals.reorder(id, ids)
    },
    replaceGlobalVariables: async (...a) => {
      const [id, entries] = parseArgs(z.tuple([uuid, variableEntries]), a)
      return core.globals.replace(id, entries)
    },
    revealGlobalVariable: async (...a) => core.globals.reveal(parseArgs(z.tuple([uuid]), a)[0]),
    // OAuth 2.0 request authorization (services/oauth2.ts); tokens stay in main and the keychain
    getOAuth2Token: async (...a) => {
      const [config, options] = parseArgs(
        z.tuple([oauth2Config, z.object({ flowId: oauth2FlowId.optional(), timeoutMs: z.number().int().min(1).max(3_600_000).optional() }).strict().optional()]),
        a,
      )
      // Only the configured (http/https) authorization URL is ever opened, through the same allow-list as openExternalUrl.
      return core.oauth2.getToken(config, options ?? {}, (url) => platform.openExternal(assertExternalUrl(url)))
    },
    cancelOAuth2Flow: async (...a) => core.oauth2.cancel(parseArgs(z.tuple([oauth2FlowId]), a)[0]),
    refreshOAuth2Token: async (...a) => {
      const [config, options] = parseArgs(z.tuple([oauth2Config, z.object({ ifExpiring: z.boolean().optional() }).strict().optional()]), a)
      return core.oauth2.refresh(config, options ?? {})
    },
    getOAuth2TokenStatus: async (...a) => core.oauth2.status(parseArgs(z.tuple([oauth2Config]), a)[0]),
    deleteOAuth2Token: async (...a) => core.oauth2.delete(parseArgs(z.tuple([oauth2TokenKey]), a)[0]),
    revealOAuth2Token: async (...a) => {
      const [key, origin] = parseArgs(z.tuple([oauth2TokenKey, httpOrigin.optional()]), a)
      return core.oauth2.reveal(key, origin)
    },
    allowOAuth2Origin: async (...a) => {
      const [key, origin] = parseArgs(z.tuple([oauth2TokenKey, httpOrigin]), a)
      core.oauth2.allowOrigin(key, origin)
    },

    // Cloud account + sync (electron/ipc/syncApi.ts)
    ...createSyncIpc(core),

    // MCP server (electron/mcp)
    getMcpStatus: async (...a) => (parseArgs(z.tuple([]), a), core.mcp.status()),
    setMcpSettings: async (...a) => core.mcp.update(parseArgs(z.tuple([mcpSettings]), a)[0]),
    revealMcpToken: async (...a) => (parseArgs(z.tuple([]), a), core.mcp.revealToken()),
    regenerateMcpToken: async (...a) => (parseArgs(z.tuple([]), a), core.mcp.regenerateToken()),
    mcpRespond: async (...a) => {
      const [callId, result] = parseArgs(z.tuple([uuid, mcpCallResult]), a)
      core.mcp.respond(callId, result)
    },
    mcpHostReady: async (...a) => (parseArgs(z.tuple([]), a), core.mcp.hostReady()),
    listMcpClients: async (...a) => (parseArgs(z.tuple([]), a), core.mcp.clients()),
    connectMcpClient: async (...a) => core.mcp.connect(parseArgs(z.tuple([mcpClientId]), a)[0]),
    disconnectMcpClient: async (...a) => core.mcp.disconnect(parseArgs(z.tuple([mcpClientId]), a)[0]),

    // MCP client (electron/mcpClient): MCP requests
    mcpClientConnect: async (...a) => {
      const [input] = parseArgs(z.tuple([mcpConnectInput]), a)
      assertResolved([
        ['URL', input.url],
        ...(input.headers ?? []).flatMap((h): Array<[string, string]> => [[`header "${h.key}" name`, h.key], [`header "${h.key}"`, h.value]]),
        ...commandParts(input),
      ])
      return core.mcpClient.connect(input)
    },
    mcpClientList: async (...a) => {
      const [sessionId, kind] = parseArgs(z.tuple([mcpSessionId, mcpListKind]), a)
      return core.mcpClient.list(sessionId, kind)
    },
    mcpClientCall: async (...a) => {
      const [input] = parseArgs(z.tuple([mcpCallInput]), a)
      // historyUrl and historyDetail are unresolved display strings (templates by design) and requestName is a label: none is sent.
      assertResolved([['name', input.name], ['URI', input.uri], ...jsonStrings(input.arguments, 'arguments')])
      return core.mcpClient.call(input)
    },
    mcpClientCancel: async (...a) => core.mcpClient.cancel(parseArgs(z.tuple([mcpRunId]), a)[0]),
    mcpClientDisconnect: async (...a) => core.mcpClient.disconnect(parseArgs(z.tuple([mcpSessionId]), a)[0]),
    mcpClientTrustCommand: async (...a) => {
      const [input] = parseArgs(z.tuple([mcpTrustInput]), a)
      assertResolved(commandParts(input))
      return core.mcpClient.trustCommand(input)
    },

    // App
    getAppVersion: async (...a) => (parseArgs(z.tuple([]), a), platform.appVersion),
    getVersionInfo: async (...a) => (parseArgs(z.tuple([]), a), collectVersionInfo(platform.appVersion)),
    setWindowBackground: async (...a) => platform.setWindowBackground?.(parseArgs(z.tuple([cssColorSchema]), a)[0]),
    getUpdateInstallState: async (...a) => (parseArgs(z.tuple([]), a), updater().state()),
    downloadUpdate: async (...a) => (parseArgs(z.tuple([]), a), updater().download()),
    cancelUpdateDownload: async (...a) => (parseArgs(z.tuple([]), a), updater().cancel()),
    installUpdate: async (...a) => (parseArgs(z.tuple([]), a), updater().install()),
    checkForUpdates: async (...a) => {
      parseArgs(z.tuple([]), a)
      if (!platform.checkForUpdates) throw ioError('Update checks are off in this run')
      return platform.checkForUpdates()
    },
    getWindowChrome: async (...a) => (parseArgs(z.tuple([]), a), windowControls().chrome()),
    setTitleBarStyle: async (...a) => windowControls().setTitleBarStyle(parseArgs(z.tuple([titleBarStyle]), a)[0]),
    setCloseToTray: async (...a) => windowControls().setCloseToTray(parseArgs(z.tuple([z.boolean()]), a)[0]),
    reopenWindow: async (...a) => (parseArgs(z.tuple([]), a), windowControls().reopen()),
    windowControl: async (...a) => platform.window?.control(parseArgs(z.tuple([windowAction]), a)[0]),
    showAppMenu: async (...a) => {
      const [x, y] = parseArgs(z.tuple([pagePoint, pagePoint]), a)
      platform.window?.showAppMenu(x, y)
    },
    setUnsavedChanges: async (...a) => {
      const [titles] = parseArgs(z.tuple([z.array(z.string().max(1000)).max(10_000)]), a)
      platform.window?.setUnsavedChanges?.(titles)
    },
  }

  function updater(): NonNullable<PlatformDeps['updates']> {
    if (!platform.updates) throw ioError('Updates are off in this run')
    return platform.updates
  }

  function windowControls(): WindowControls {
    if (!platform.window) throw ioError('No application window')
    return platform.window
  }
}
