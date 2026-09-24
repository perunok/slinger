import type { Db } from '../db/database'
import { runMigrations } from '../db/migrate'
import { CollectionRepository } from '../repositories/collections'
import { EnvironmentRepository } from '../repositories/environments'
import { HistoryRepository } from '../repositories/history'
import { WorkspaceRepository } from '../repositories/workspaces'
import { FolderRepository, RequestRepository } from '../repositories/tree'
import { BrowserAuthCallbacks } from './authCallback'
import { ExportFiles } from './exportFiles'
import { FileGrants } from './fileGrants'
import { HttpService } from './httpService'
import type { SecretStore } from './secrets'
import type { SyncEvent } from '../../shared/types'
import { createSyncService, type SyncService, type SyncServiceDeps } from '../sync'

export interface CoreDeps {
  db: Db
  secrets: SecretStore
  /** Directory holding the numbered .sql migrations; migrations run when it is provided. */
  migrationsDir?: string
  exportFiles?: ExportFiles
  /** Cloud sync wiring (all optional; sensible defaults for tests). */
  sync?: {
    /** Receives every SyncEvent (main forwards them to the renderer). */
    emit?: (event: SyncEvent) => void
    appVersion?: string
  } & Partial<Omit<SyncServiceDeps, 'db' | 'secrets' | 'emit' | 'appVersion'>>
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
  fileGrants: FileGrants
  sync: SyncService
}

export function createCore(deps: CoreDeps): Core {
  if (deps.migrationsDir) runMigrations(deps.db, deps.migrationsDir)
  const { db, secrets } = deps
  const history = new HistoryRepository(db)
  const fileGrants = new FileGrants()
  const core: Core = {
    db,
    secrets,
    workspaces: new WorkspaceRepository(db, secrets),
    environments: new EnvironmentRepository(db, secrets),
    collections: new CollectionRepository(db),
    folders: new FolderRepository(db),
    requests: new RequestRepository(db),
    history,
    http: new HttpService(history, fileGrants),
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
  }
  // First launch: make sure there is always a workspace to work in.
  core.workspaces.ensureDefault()
  return core
}
