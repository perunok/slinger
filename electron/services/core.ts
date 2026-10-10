import type { Db } from '../db/database'
import { runMigrations } from '../db/migrate'
import { CollectionRepository } from '../repositories/collections'
import { EnvironmentRepository } from '../repositories/environments'
import { HistoryRepository } from '../repositories/history'
import { WorkspaceRepository } from '../repositories/workspaces'
import { FolderRepository, RequestRepository } from '../repositories/tree'
import { CollectionVariableRepository, GlobalVariableRepository } from '../repositories/variables'
import { WorkflowRepository } from '../repositories/workflows'
import { BrowserAuthCallbacks } from './authCallback'
import { ExportFiles } from './exportFiles'
import { FileGrants } from './fileGrants'
import { HttpService } from './httpService'
import { OAuth2Service } from './oauth2'
import { ScriptService } from './scriptService'
import { UnavailableExecutor, type ScriptExecutor } from '../scripts/executor'
import type { SecretStore } from './secrets'
import type { SyncEvent } from '../../shared/types'
import { createSyncService, type SyncService, type SyncServiceDeps } from '../sync'
import { McpService, type McpServiceDeps } from '../mcp/service'
import { McpClientService, type McpClientApi, type McpClientDeps } from '../mcpClient/types'

export interface CoreDeps {
  db: Db
  secrets: SecretStore
  /** Directory holding the numbered .sql migrations; migrations run when it is provided. */
  migrationsDir?: string
  exportFiles?: ExportFiles
  /** Where scripts run: the app passes a WorkerExecutor, tests an InlineExecutor. Without one, scripts are unavailable. */
  scriptExecutor?: ScriptExecutor
  /** Cloud sync wiring (all optional; sensible defaults for tests). */
  sync?: {
    /** Receives every SyncEvent (main forwards them to the renderer). */
    emit?: (event: SyncEvent) => void
    appVersion?: string
  } & Partial<Omit<SyncServiceDeps, 'db' | 'secrets' | 'emit' | 'appVersion'>>
  /** MCP server wiring (optional: tests get a server with no window to run tools in). */
  mcp?: Partial<Omit<McpServiceDeps, 'db' | 'secrets'>>
  /** MCP client wiring (MCP requests; optional: tests get a client whose events go nowhere). */
  mcpClient?: Partial<Omit<McpClientDeps, 'db'>>
}

/** Everything the IPC layer needs, wired together. Contains no Electron imports. */
export interface Core {
  db: Db
  secrets: SecretStore
  workspaces: WorkspaceRepository
  environments: EnvironmentRepository
  collections: CollectionRepository
  folders: FolderRepository
  requests: RequestRepository
  /** ADDED (workflows): local-only visual workflows per workspace. */
  workflows: WorkflowRepository
  history: HistoryRepository
  /** ADDED (persisted variables): local-only collection variables and workspace globals. */
  collectionVariables: CollectionVariableRepository
  globals: GlobalVariableRepository
  http: HttpService
  oauth2: OAuth2Service
  scripts: ScriptService
  authCallbacks: BrowserAuthCallbacks
  exportFiles: ExportFiles
  fileGrants: FileGrants
  sync: SyncService
  /** Local MCP endpoint for LLM clients (off until enabled in Settings). */
  mcp: McpService
  /** ADDED (MCP requests): Slinger's own MCP client sessions (connect to a server, list, call). */
  mcpClient: McpClientApi
}

export function createCore(deps: CoreDeps): Core {
  if (deps.migrationsDir) runMigrations(deps.db, deps.migrationsDir)
  const { db, secrets } = deps
  const history = new HistoryRepository(db)
  const fileGrants = new FileGrants()
  const environments = new EnvironmentRepository(db, secrets)
  const collectionVariables = new CollectionVariableRepository(db)
  const globals = new GlobalVariableRepository(db, secrets)
  const oauth2 = new OAuth2Service(secrets)
  const scripts = new ScriptService(db, environments, deps.scriptExecutor ?? new UnavailableExecutor(), Date.now, fileGrants, {
    collectionVariables,
    globals,
  })
  const core: Core = {
    db,
    secrets,
    workspaces: new WorkspaceRepository(db, secrets),
    environments,
    collections: new CollectionRepository(db),
    folders: new FolderRepository(db),
    requests: new RequestRepository(db),
    workflows: new WorkflowRepository(db),
    history,
    collectionVariables,
    globals,
    http: new HttpService(history, fileGrants, (sessionId, text) => scripts.redact(sessionId, text), (key) => oauth2.accessTokenFor(key)),
    oauth2,
    scripts,
    authCallbacks: new BrowserAuthCallbacks(),
    exportFiles: deps.exportFiles ?? new ExportFiles(),
    fileGrants,
    sync: createSyncService({
      db,
      secrets,
      emit: deps.sync?.emit ?? (() => {}),
      appVersion: deps.sync?.appVersion ?? '0.0.0',
      ...deps.sync,
    }),
    mcp: new McpService({
      ...deps.mcp,
      db,
      secrets,
      emit: deps.mcp?.emit ?? (() => false),
      appVersion: deps.mcp?.appVersion ?? deps.sync?.appVersion ?? '0.0.0',
    }),
    mcpClient: new McpClientService({
      redact: (sessionId, text) => scripts.redact(sessionId, text),
      ...deps.mcpClient,
      db,
      emit: deps.mcpClient?.emit ?? (() => {}),
      appVersion: deps.mcpClient?.appVersion ?? deps.sync?.appVersion ?? '0.0.0',
    }),
  }
  // First launch: make sure there is always a workspace to work in.
  core.workspaces.ensureDefault()
  return core
}
