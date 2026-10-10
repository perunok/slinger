import { z } from 'zod'
import type { SlingerInvokeApi } from '../../shared/ipc-contract'
import type { PickFileOptions, TitleBarStyle, UpdateCheckResult, WindowAction, WindowChrome } from '../../shared/types'
import { invalidInput, ioError } from '../lib/errors'
import { isUuid } from '../lib/ids'
import { assertExternalUrl } from '../services/externalUrl'
import { importPostmanCollection, replaceCollectionFromPostman } from '../services/postmanImport'
import { extractFolderToCollection } from '../services/extractFolder'
import * as versions from '../services/collectionVersions'
import { assertGenericSecureKey } from '../services/secrets'
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
})

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
})
const scriptsJson = z.string().max(4 * 1024 * 1024).nullable()
const extractFolderInput = z.object({
  folderId: uuid,
  name,
  scriptsJson: scriptsJson.optional(),
  copyCollectionVariables: z.boolean(),
})
const description = z.string().max(4 * 1024 * 1024).nullable()

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
  appVersion: string
  /** Paints + remembers the window background (already validated and normalised to `#rrggbb`). Optional: tests omit it. */
  setWindowBackground?(color: string): void
  /** Latest-release lookup (services/updateCheck.ts); absent when update checks are off (automated runs, tests). */
  checkForUpdates?(): Promise<UpdateCheckResult>
  /** The main window's frame (custom title bar). Optional: tests omit it. */
  window?: WindowControls
}

export interface WindowControls {
  chrome(): WindowChrome
  setTitleBarStyle(style: TitleBarStyle): WindowChrome
  reopen(): void
  control(action: WindowAction): void
  /** CSS pixels within the page. */
  showAppMenu(x: number, y: number): void
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
const mcpClientId = z.enum(['claude-desktop', 'claude-code', 'cursor', 'vscode', 'windsurf'])
const mcpSettings = z.object({ enabled: z.boolean(), port: z.number().int().min(1024).max(65535) }).strict()
const mcpCallResult = z.union([
  z.object({ ok: z.literal(true), text: z.string().max(20_000_000), data: z.record(z.string(), z.unknown()).optional() }).strict(),
  z.object({ ok: z.literal(false), error: z.string().max(100_000) }).strict(),
])

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
    setCollectionScripts: async (...a) => {
      const [id, json] = parseArgs(z.tuple([uuid, scriptsJson]), a)
      return core.collections.setScripts(id, json)
    },
    setCollectionDescription: async (...a) => {
      const [id, text] = parseArgs(z.tuple([uuid, description]), a)
      return core.collections.setDescription(id, text)
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

    // HTTP execution
    executeHttpRequest: async (...a) => core.http.execute(parseArgs(z.tuple([httpRequestInput]), a)[0]),
    cloudFetch: async (...a) => core.http.fetchInternal(parseArgs(z.tuple([cloudFetchInput]), a)[0]),
    cancelHttpRequest: async (...a) => {
      const [runId] = parseArgs(z.tuple([z.string().max(128)]), a)
      core.http.cancel(runId)
      core.scripts.cancel(runId)
    },
    runScripts: async (...a) => core.scripts.run(parseArgs(z.tuple([runScriptsInput]), a)[0]),

    // Postman import/export
    importPostmanCollection: async (...a) => {
      const [id, contents, options] = parseArgs(z.tuple([uuid, postmanFile, postmanImportOptions.optional()]), a)
      return importPostmanCollection(core.db, id, contents, options ?? {})
    },
    replaceCollectionFromPostman: async (...a) => {
      const [id, contents, sourceName] = parseArgs(z.tuple([uuid, postmanFile, z.string().max(1024).nullish()]), a)
      return replaceCollectionFromPostman(core.db, id, contents, sourceName)
    },
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
      versions.createCollectionVersion(core.db, parseArgs(z.tuple([createVersionInput]), a)[0]),
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

    secureStoreGet: async (...a) => core.secrets.get(assertGenericSecureKey(parseArgs(z.tuple([z.string()]), a)[0])),
    secureStoreSet: async (...a) => {
      const [key, value] = parseArgs(z.tuple([z.string(), z.string().max(1_000_000)]), a)
      core.secrets.set(assertGenericSecureKey(key), value)
    },
    secureStoreDelete: async (...a) => core.secrets.delete(assertGenericSecureKey(parseArgs(z.tuple([z.string()]), a)[0])),

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
    revealOAuth2Token: async (...a) => core.oauth2.reveal(parseArgs(z.tuple([oauth2TokenKey]), a)[0]),

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

    // App
    getAppVersion: async (...a) => (parseArgs(z.tuple([]), a), platform.appVersion),
    getVersionInfo: async (...a) => (parseArgs(z.tuple([]), a), collectVersionInfo(platform.appVersion)),
    setWindowBackground: async (...a) => platform.setWindowBackground?.(parseArgs(z.tuple([cssColorSchema]), a)[0]),
    checkForUpdates: async (...a) => {
      parseArgs(z.tuple([]), a)
      if (!platform.checkForUpdates) throw ioError('Update checks are off in this run')
      return platform.checkForUpdates()
    },
    getWindowChrome: async (...a) => (parseArgs(z.tuple([]), a), windowControls().chrome()),
    setTitleBarStyle: async (...a) => windowControls().setTitleBarStyle(parseArgs(z.tuple([titleBarStyle]), a)[0]),
    reopenWindow: async (...a) => (parseArgs(z.tuple([]), a), windowControls().reopen()),
    windowControl: async (...a) => platform.window?.control(parseArgs(z.tuple([windowAction]), a)[0]),
    showAppMenu: async (...a) => {
      const [x, y] = parseArgs(z.tuple([pagePoint, pagePoint]), a)
      platform.window?.showAppMenu(x, y)
    },
  }

  function windowControls(): WindowControls {
    if (!platform.window) throw ioError('No application window')
    return platform.window
  }
}
