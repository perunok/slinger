/**
 * Single source of truth for the Electron IPC surface.
 *
 * - electron/ipc/handlers.ts registers `ipcMain.handle(channel, ...)` for every
 *   entry using this exact channel string and this exact signature.
 * - electron/preload.ts exposes `window.slinger.<methodName>` via contextBridge,
 *   calling `ipcRenderer.invoke(channel, ...args)` for each entry.
 * - src/lib/ipc.ts (renderer-side client) calls `window.slinger.<methodName>(...)`.
 *
 * Do not rename a channel or change a signature here without updating both
 * the main-process handler and the renderer client in the same change.
 */
import type {
  ApiFolder,
  ApiRequest,
  CloudFetchInput,
  Collection,
  CollectionVersion,
  CollectionVersionDetail,
  CreateCollectionVersionInput,
  RestoreCollectionVersionMode,
  CreateFolderInput,
  CreateRequestInput,
  Environment,
  EnvironmentVariable,
  HistoryEntry,
  HttpRequestInput,
  HttpResponseData,
  MoveFolderInput,
  MoveRequestInput,
  PickFileOptions,
  PostmanImportResult,
  CloudConfig,
  CloudSession,
  CloudSignInStart,
  LinkRemoteWorkspaceInput,
  RemoteWorkspace,
  RemoteWorkspacePreview,
  ResolveSyncConflictInput,
  RunScriptsInput,
  RunScriptsResult,
  SyncConflict,
  SyncEvent,
  SyncStatus,
  UpdateRequestInput,
  UpsertEnvironmentVariableInput,
  Workspace,
} from './types'

export interface SlingerIpcApi {
  // Workspaces
  listWorkspaces(): Promise<Workspace[]>
  createWorkspace(name: string): Promise<Workspace>
  renameWorkspace(workspaceId: string, name: string): Promise<Workspace>
  deleteWorkspace(workspaceId: string): Promise<void>

  // Environments
  listEnvironments(workspaceId: string): Promise<Environment[]>
  ensureDefaultEnvironment(workspaceId: string): Promise<Environment>
  createEnvironment(workspaceId: string, name: string): Promise<Environment>
  renameEnvironment(environmentId: string, name: string): Promise<Environment>
  deleteEnvironment(environmentId: string): Promise<void>
  listEnvironmentVariables(environmentId: string): Promise<EnvironmentVariable[]>
  upsertEnvironmentVariable(input: UpsertEnvironmentVariableInput): Promise<EnvironmentVariable>
  deleteEnvironmentVariable(variableId: string): Promise<void>
  /** ADDED: explicit reveal of a variable's value (the only way a secret value reaches the renderer). */
  revealEnvironmentVariable(variableId: string): Promise<string>

  // Collections
  listCollections(workspaceId: string): Promise<Collection[]>
  createCollection(workspaceId: string, name: string): Promise<Collection>
  renameCollection(collectionId: string, name: string): Promise<Collection>
  deleteCollection(collectionId: string): Promise<void>
  /** ADDED (scripts): replaces the collection's Postman `event` array (JSON text, or null to clear). Local-only. */
  setCollectionScripts(collectionId: string, scriptsJson: string | null): Promise<Collection>
  /** ADDED (docs): replaces the collection's description text (null or blank clears it; the stored type is kept). Local-only. */
  setCollectionDescription(collectionId: string, description: string | null): Promise<Collection>

  // Folders
  listFolders(collectionId: string): Promise<ApiFolder[]>
  createFolder(input: CreateFolderInput): Promise<ApiFolder>
  renameFolder(folderId: string, name: string): Promise<ApiFolder>
  moveFolder(input: MoveFolderInput): Promise<ApiFolder>
  deleteFolder(folderId: string): Promise<void>
  /** ADDED (scripts): replaces the folder's Postman `event` array (JSON text, or null to clear). Local-only. */
  setFolderScripts(folderId: string, scriptsJson: string | null): Promise<ApiFolder>
  /** ADDED (docs): replaces the folder's description text (see setCollectionDescription). Local-only. */
  setFolderDescription(folderId: string, description: string | null): Promise<ApiFolder>

  // Requests
  listRequests(collectionId: string): Promise<ApiRequest[]>
  createRequest(input: CreateRequestInput): Promise<ApiRequest>
  updateRequest(input: UpdateRequestInput): Promise<ApiRequest>
  renameRequest(requestId: string, name: string): Promise<ApiRequest>
  moveRequest(input: MoveRequestInput): Promise<ApiRequest>
  deleteRequest(requestId: string): Promise<void>

  // History
  listHistory(workspaceId: string, limit?: number): Promise<HistoryEntry[]>
  clearHistory(workspaceId: string): Promise<void>
  deleteHistoryEntry(historyId: string): Promise<void>

  // HTTP execution
  executeHttpRequest(input: HttpRequestInput): Promise<HttpResponseData>
  /** Cancels an HTTP request or a script run (RunScriptsInput.runId) with this id. */
  cancelHttpRequest(requestRunId: string): Promise<void>
  /**
   * ADDED (scripts): runs a chain of pre-request or test scripts in the main-process QuickJS sandbox. Environment
   * writes are persisted before it resolves; script failures are reported in `errors`, not as a rejection.
   */
  runScripts(input: RunScriptsInput): Promise<RunScriptsResult>
  /** Internal cloud API transport: same network stack, but never recorded in history and no file access. */
  cloudFetch(input: CloudFetchInput): Promise<HttpResponseData>

  // Postman import/export
  importPostmanCollection(workspaceId: string, fileContents: string): Promise<PostmanImportResult>
  defaultExportPath(fileName: string): Promise<string>
  /** `encoding` (renderer addition, optional, default 'utf8'): 'base64' means `contents` is base64 of raw bytes (binary response bodies). */
  writeExportFile(fileName: string, contents: string, encoding?: 'utf8' | 'base64'): Promise<void>
  /**
   * ADDED: opens a native folder picker; the chosen folder becomes the export
   * directory used by defaultExportPath/writeExportFile for this session.
   * Resolves to the chosen directory, or null if the dialog was cancelled.
   */
  chooseExportDirectory(): Promise<string | null>

  // Collection versions (semver snapshots; no git)
  listCollectionVersions(collectionId: string): Promise<CollectionVersion[]> // newest semver first
  getCollectionVersion(versionId: string): Promise<CollectionVersionDetail>
  createCollectionVersion(input: CreateCollectionVersionInput): Promise<CollectionVersion>
  restoreCollectionVersion(versionId: string, mode: RestoreCollectionVersionMode): Promise<Collection>
  deleteCollectionVersion(versionId: string): Promise<void>

  // Secure storage (OS keychain), used by cloud.ts for tokens instead of localStorage
  secureStoreGet(key: string): Promise<string | null>
  secureStoreSet(key: string, value: string): Promise<void>
  secureStoreDelete(key: string): Promise<void>

  // Misc
  openExternalUrl(url: string): Promise<void>
  prepareBrowserAuthCallback(): Promise<{ callbackId: string; redirectUrl: string }>
  waitForBrowserAuthCallback(callbackId: string, timeoutMs: number): Promise<Record<string, string>>

  // App
  getAppVersion(): Promise<string>

  // --- Renderer-driven additions ---
  /** Native open-file dialog (form-data file fields, binary body); absolute path, or null when cancelled. */
  pickFile(options?: PickFileOptions): Promise<string | null>


  // Cloud account (tokens never reach the renderer)
  getCloudConfig(): Promise<CloudConfig>
  setCloudConfig(config: CloudConfig): Promise<CloudConfig>
  getCloudSession(): Promise<CloudSession>
  /** Starts the device flow; main polls in the background and emits 'auth' / 'signInResult'. */
  startCloudSignIn(): Promise<CloudSignInStart>
  cancelCloudSignIn(): Promise<void>
  signOutCloud(): Promise<void>
  listRemoteWorkspaces(): Promise<RemoteWorkspace[]>
  previewRemoteWorkspace(remoteWorkspaceId: string): Promise<RemoteWorkspacePreview>

  // Sync
  getSyncStatus(workspaceId: string): Promise<SyncStatus>
  listSyncStatuses(): Promise<SyncStatus[]>            // every LINKED workspace
  /** Runs (or joins) a sync cycle and resolves with the final status. Never rejects for network errors: see status.state/lastError. */
  syncNow(workspaceId: string): Promise<SyncStatus>
  setAutoSync(workspaceId: string, enabled: boolean): Promise<SyncStatus>
  /** Creates the remote workspace, links, and starts the initial upload in the background. */
  publishWorkspace(workspaceId: string): Promise<SyncStatus>
  /** Links (merge) or downloads (localWorkspaceId null). Resolves after the link exists; download/upload continues in the background. Returns the local workspace. */
  linkRemoteWorkspace(input: LinkRemoteWorkspaceInput): Promise<{ workspace: Workspace; status: SyncStatus }>
  unlinkWorkspace(workspaceId: string): Promise<void>
  listSyncConflicts(workspaceId: string, includeResolved?: boolean): Promise<SyncConflict[]>
  resolveSyncConflict(input: ResolveSyncConflictInput): Promise<SyncStatus>
  discardPendingChanges(workspaceId: string): Promise<SyncStatus>

  /** Push channel (main -> renderer). Returns an unsubscribe function. Implemented in preload with ipcRenderer.on('sync:event'). */
  onSyncEvent(listener: (event: SyncEvent) => void): () => void
  /**
   * Which of these saved file paths the user has granted in this session (via pickFile). Local files
   * are only readable by executeHttpRequest after a grant; grants are in-memory and reset on restart.
   */
  grantedFiles(paths: string[]): Promise<string[]>
}

/** Channel name for every SlingerIpcApi method — kept identical to the method name. */
export const IPC_CHANNELS = [
  'listWorkspaces',
  'createWorkspace',
  'renameWorkspace',
  'deleteWorkspace',
  'listEnvironments',
  'ensureDefaultEnvironment',
  'createEnvironment',
  'renameEnvironment',
  'deleteEnvironment',
  'listEnvironmentVariables',
  'upsertEnvironmentVariable',
  'deleteEnvironmentVariable',
  'revealEnvironmentVariable',
  'listCollections',
  'createCollection',
  'renameCollection',
  'deleteCollection',
  'setCollectionScripts',
  'setCollectionDescription',
  'listFolders',
  'createFolder',
  'renameFolder',
  'moveFolder',
  'deleteFolder',
  'setFolderScripts',
  'setFolderDescription',
  'listRequests',
  'createRequest',
  'updateRequest',
  'renameRequest',
  'moveRequest',
  'deleteRequest',
  'listHistory',
  'clearHistory',
  'deleteHistoryEntry',
  'executeHttpRequest',
  'cancelHttpRequest',
  'runScripts',
  'cloudFetch',
  'importPostmanCollection',
  'defaultExportPath',
  'writeExportFile',
  'chooseExportDirectory',
  'listCollectionVersions',
  'getCollectionVersion',
  'createCollectionVersion',
  'restoreCollectionVersion',
  'deleteCollectionVersion',
  'secureStoreGet',
  'secureStoreSet',
  'secureStoreDelete',
  'openExternalUrl',
  'prepareBrowserAuthCallback',
  'waitForBrowserAuthCallback',
  'getAppVersion',
  'pickFile',
  'getCloudConfig',
  'setCloudConfig',
  'getCloudSession',
  'startCloudSignIn',
  'cancelCloudSignIn',
  'signOutCloud',
  'listRemoteWorkspaces',
  'previewRemoteWorkspace',
  'getSyncStatus',
  'listSyncStatuses',
  'syncNow',
  'setAutoSync',
  'publishWorkspace',
  'linkRemoteWorkspace',
  'unlinkWorkspace',
  'listSyncConflicts',
  'resolveSyncConflict',
  'discardPendingChanges',
  'grantedFiles',
] as const satisfies readonly (keyof SlingerIpcApi)[]

export type IpcChannel = (typeof IPC_CHANNELS)[number]

/** Push channels (main -> renderer, `webContents.send`); NOT invoke channels, so not in IPC_CHANNELS. */
export const IPC_EVENT_CHANNELS = ['sync:event'] as const

/** The invoke-only part of the API (everything except the push subscription), i.e. what main implements. */
export type SlingerInvokeApi = Omit<SlingerIpcApi, 'onSyncEvent'>

declare global {
  interface Window {
    slinger: SlingerIpcApi
  }
}
