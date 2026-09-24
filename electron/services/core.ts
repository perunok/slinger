import type { Db } from '../db/database'
import { runMigrations } from '../db/migrate'
import { CollectionRepository } from '../repositories/collections'
import { EnvironmentRepository } from '../repositories/environments'
import { HistoryRepository } from '../repositories/history'
import { WorkspaceRepository } from '../repositories/workspaces'
import { FolderRepository, RequestRepository } from '../repositories/tree'
import { BrowserAuthCallbacks } from './authCallback'
import { ExportFiles } from './exportFiles'
import { HttpService } from './httpService'
import type { SecretStore } from './secrets'

export interface CoreDeps {
  db: Db
  secrets: SecretStore
  /** Directory holding the numbered .sql migrations; migrations run when it is provided. */
  migrationsDir?: string
  exportFiles?: ExportFiles
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
  history: HistoryRepository
  http: HttpService
  authCallbacks: BrowserAuthCallbacks
  exportFiles: ExportFiles
}

export function createCore(deps: CoreDeps): Core {
  if (deps.migrationsDir) runMigrations(deps.db, deps.migrationsDir)
  const { db, secrets } = deps
  const history = new HistoryRepository(db)
  const core: Core = {
    db,
    secrets,
    workspaces: new WorkspaceRepository(db, secrets),
    environments: new EnvironmentRepository(db, secrets),
    collections: new CollectionRepository(db),
    folders: new FolderRepository(db),
    requests: new RequestRepository(db),
    history,
    http: new HttpService(history),
    authCallbacks: new BrowserAuthCallbacks(),
    exportFiles: deps.exportFiles ?? new ExportFiles(),
  }
  // First launch: make sure there is always a workspace to work in.
  core.workspaces.ensureDefault()
  return core
}
