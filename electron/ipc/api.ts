import { z } from 'zod'
import type { SlingerInvokeApi } from '../../shared/ipc-contract'
import type { PickFileOptions } from '../../shared/types'
import { invalidInput } from '../lib/errors'
import { isUuid } from '../lib/ids'
import { assertExternalUrl } from '../services/externalUrl'
import { importPostmanCollection } from '../services/postmanImport'
import * as versions from '../services/collectionVersions'
import { assertGenericSecureKey } from '../services/secrets'
import type { Core } from '../services/core'
import { createSyncIpc } from './syncApi'

// ---------------------------------------------------------------------------
// Input schemas. Every IPC argument list is parsed here, before any repository is touched.
// ---------------------------------------------------------------------------

const uuid = z.string().refine(isUuid, { message: 'must be a valid UUID' })
const name = z.string().min(1).max(500)
const text = z.string().max(1_000_000)
const nullableUuid = uuid.nullish()
const index = z.number().int().min(0)

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
    kind: z.enum(['none', 'basic', 'bearer', 'apiKey']),
    basic: z.object({ username: z.string().max(65_536), password: z.string().max(65_536) }).optional(),
    bearer: z.object({ token: z.string().max(65_536) }).optional(),
    apiKey: z
      .object({ key: z.string().max(8192), value: z.string().max(65_536), addTo: z.enum(['header', 'query']) })
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
})

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
const createVersionInput = z.object({
  collectionId: uuid,
  version: z.string().min(1).max(128),
  notes: z.string().max(10_000).nullish(),
})

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
}

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
    deleteWorkspace: async (...a) => core.workspaces.softDelete(parseArgs(z.tuple([uuid]), a)[0]),

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

    // Folders
    listFolders: async (...a) => core.folders.list(parseArgs(z.tuple([uuid]), a)[0]),
    createFolder: async (...a) => core.folders.create(parseArgs(z.tuple([createFolderInput]), a)[0]),
    renameFolder: async (...a) => {
      const [id, n] = parseArgs(z.tuple([uuid, name]), a)
      return core.folders.rename(id, n)
    },
    moveFolder: async (...a) => core.folders.move(parseArgs(z.tuple([moveFolderInput]), a)[0]),
    deleteFolder: async (...a) => core.folders.softDelete(parseArgs(z.tuple([uuid]), a)[0]),

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

    // HTTP execution
    executeHttpRequest: async (...a) => core.http.execute(parseArgs(z.tuple([httpRequestInput]), a)[0]),
    cloudFetch: async (...a) => core.http.fetchInternal(parseArgs(z.tuple([cloudFetchInput]), a)[0]),
    cancelHttpRequest: async (...a) => core.http.cancel(parseArgs(z.tuple([z.string().max(128)]), a)[0]),

    // Postman import/export
    importPostmanCollection: async (...a) => {
      const [id, contents] = parseArgs(z.tuple([uuid, z.string().max(50 * 1024 * 1024)]), a)
      return importPostmanCollection(core.db, id, contents)
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

    // Cloud account + sync (electron/ipc/syncApi.ts)
    ...createSyncIpc(core),

    // App
    getAppVersion: async (...a) => (parseArgs(z.tuple([]), a), platform.appVersion),
  }
}
