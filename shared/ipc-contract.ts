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
import type { McpCall, McpCallResult, McpClientId, McpClientStatus, McpSettings, McpStatus } from './mcp'
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
  ExtractFolderInput,
  ExtractFolderResult,
  MoveFolderInput,
  GetOAuth2TokenOptions,
  OAuth2Config,
  OAuth2TokenStatus,
  RefreshOAuth2TokenOptions,
  MoveRequestInput,
  PickFileOptions,
  PostmanImportOptions,
  PostmanImportResult,
  PostmanReplaceResult,
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
  VersionInfo,
  Workflow,
  WorkflowSummary,
  CreateWorkflowInput,
  UpdateWorkflowInput,
  UpdateCheckResult,
  WindowChrome,
  TitleBarStyle,
  WindowAction,
  WindowState,
  UpdateRequestInput,
  UpsertEnvironmentVariableInput,
  Workspace,
  CollectionVariable,
  GlobalVariable,
  UpsertCollectionVariableInput,
  UpsertGlobalVariableInput,
  VariableEntryInput,
} from './types'
import type { MenuCommand } from './menu'

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
  /** ADDED (extract folder): the folder becomes a collection of its own (its requests move, keeping their ids). */
  extractFolderToCollection(input: ExtractFolderInput): Promise<ExtractFolderResult>
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
  /** `options` (re-import addition, optional): `name` overrides the file's name, e.g. "X (2)" for an import as a copy. */
  importPostmanCollection(workspaceId: string, fileContents: string, options?: PostmanImportOptions): Promise<PostmanImportResult>
  /**
   * ADDED (re-import): replaces the folders, requests, scripts, descriptions and collection variables of an existing collection with a
   * Postman file in one transaction, after an automatic safety version (next patch). Keeps the collection's id,
   * name and versions. `sourceName` (the file name) only labels the safety version's notes.
   */
  replaceCollectionFromPostman(collectionId: string, fileContents: string, sourceName?: string | null): Promise<PostmanReplaceResult>
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

  // Workflows (ADDED: local-only visual workflows per workspace; graph documents are opaque JSON objects to main)
  listWorkflows(workspaceId: string): Promise<WorkflowSummary[]> // by name
  getWorkflow(workflowId: string): Promise<Workflow>
  createWorkflow(input: CreateWorkflowInput): Promise<Workflow>
  /** version_conflict (details.currentVersion) unless expectedVersion is current. */
  updateWorkflow(input: UpdateWorkflowInput): Promise<Workflow>
  /** A copy in the same workspace ("<name> copy" unless `name` is given). */
  duplicateWorkflow(workflowId: string, name?: string): Promise<Workflow>
  deleteWorkflow(workflowId: string): Promise<void>

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
  /** ADDED (About dialog): app, Electron, Chromium, Node and V8 versions plus OS platform/release/arch. Nothing else. */
  getVersionInfo(): Promise<VersionInfo>
  /**
   * ADDED (launch): the resolved theme background (CSS hex or rgb() colour). Main paints the window with it now and
   * remembers it for the next launch (window-state.json), so the native window never flashes a different colour.
   */
  setWindowBackground(color: string): Promise<void>
  /**
   * ADDED (update notice): asks GitHub for the latest published Slinger release. Read-only; nothing is downloaded or
   * installed. Rejects with `network_error` when offline, `io_error` for an unexpected answer.
   */
  checkForUpdates(): Promise<UpdateCheckResult>
  /** ADDED (custom title bar): platform, the current window's title bar and the saved preference. */
  getWindowChrome(): Promise<WindowChrome>
  /** Saves the title bar preference (window-state.json); it applies when the window is reopened. */
  setTitleBarStyle(style: TitleBarStyle): Promise<WindowChrome>
  /** Closes the main window and opens it again with the saved title bar preference (same process, data and bounds). */
  reopenWindow(): Promise<void>
  /** The custom title bar's own window buttons (Windows/Linux): minimise, maximise or restore, close. */
  windowControl(action: WindowAction): Promise<void>
  /** Pops up the application menu at a point in the page (CSS pixels); the custom title bar's menu button. */
  showAppMenu(x: number, y: number): Promise<void>

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
  /** Push channel (main -> renderer): application-menu commands (shared/menu.ts). Returns an unsubscribe function. */
  onMenuCommand(listener: (command: MenuCommand) => void): () => void
  /** Push channel (main -> renderer): the main window was maximised / restored, entered or left full screen, gained or lost focus. */
  onWindowState(listener: (state: WindowState) => void): () => void

  // --- MCP server (shared/mcp.ts): a local endpoint LLM clients use to work in Slinger. ---
  getMcpStatus(): Promise<McpStatus>
  /** Turns the endpoint on/off or moves it; a start failure (port in use) is reported in the returned status. */
  setMcpSettings(settings: McpSettings): Promise<McpStatus>
  /** The bearer token clients need (created on first use, kept in the OS keychain). */
  revealMcpToken(): Promise<string>
  /** Replaces the token; connected clients must be given the new one. */
  regenerateMcpToken(): Promise<McpStatus>
  /** The renderer's answer to an onMcpCall request. */
  mcpRespond(callId: string, result: McpCallResult): Promise<void>
  /** The renderer subscribed to onMcpCall (tool calls wait for this after a start or reload). */
  mcpHostReady(): Promise<void>
  /** Assistants found on this computer and whether Slinger is in their MCP configuration. */
  listMcpClients(): Promise<McpClientStatus[]>
  /** Adds Slinger to that assistant's configuration (turning the server on first). */
  connectMcpClient(clientId: McpClientId): Promise<McpClientStatus[]>
  /** Removes Slinger's entry from that assistant's configuration. */
  disconnectMcpClient(clientId: McpClientId): Promise<McpClientStatus[]>
  /** Push channel (main -> renderer): an LLM client called a tool; run it and answer with mcpRespond. */
  onMcpCall(listener: (call: McpCall) => void): () => void
  /**
   * Which of these saved file paths the user has granted in this session (via pickFile). Local files
   * are only readable by executeHttpRequest after a grant; grants are in-memory and reset on restart.
   */
  grantedFiles(paths: string[]): Promise<string[]>

  // --- ADDED (persisted variables): collection variables and globals. Local-only (never synced). ---
  /** Live variables of the collection in their order (disabled ones included). */
  listCollectionVariables(collectionId: string): Promise<CollectionVariable[]>
  upsertCollectionVariable(input: UpsertCollectionVariableInput): Promise<CollectionVariable>
  deleteCollectionVariable(variableId: string): Promise<void>
  /** `variableIds` must be every live variable of the collection exactly once. Does not bump versions. */
  reorderCollectionVariables(collectionId: string, variableIds: string[]): Promise<CollectionVariable[]>
  /** Bulk editor: the collection ends up with exactly these variables, in this order. */
  replaceCollectionVariables(collectionId: string, variables: VariableEntryInput[]): Promise<CollectionVariable[]>
  listGlobalVariables(workspaceId: string): Promise<GlobalVariable[]>
  upsertGlobalVariable(input: UpsertGlobalVariableInput): Promise<GlobalVariable>
  deleteGlobalVariable(variableId: string): Promise<void>
  reorderGlobalVariables(workspaceId: string, variableIds: string[]): Promise<GlobalVariable[]>
  replaceGlobalVariables(workspaceId: string, variables: VariableEntryInput[]): Promise<GlobalVariable[]>
  /** The only way a secret global's value reaches the renderer (like revealEnvironmentVariable). */
  revealGlobalVariable(variableId: string): Promise<string>
  // OAuth 2.0 request authorization (tokens live in the OS keychain; the renderer gets status only)
  /**
   * ADDED (OAuth 2.0): runs the configured grant in main and stores the token. The authorization code grants open the
   * system browser and wait for the redirect on the loopback redirect URI (default 5 min; `cancelOAuth2Flow`).
   */
  getOAuth2Token(config: OAuth2Config, options?: GetOAuth2TokenOptions): Promise<OAuth2TokenStatus>
  /** ADDED (OAuth 2.0): aborts a running getOAuth2Token with that flowId (no-op when unknown). */
  cancelOAuth2Flow(flowId: string): Promise<void>
  /** ADDED (OAuth 2.0): uses the stored refresh token (`ifExpiring`: only when expired or about to be; see the type). */
  refreshOAuth2Token(config: OAuth2Config, options?: RefreshOAuth2TokenOptions): Promise<OAuth2TokenStatus>
  /** ADDED (OAuth 2.0): the stored token's metadata and key for this configuration (hasToken false when none). */
  getOAuth2TokenStatus(config: OAuth2Config): Promise<OAuth2TokenStatus>
  /** ADDED (OAuth 2.0): removes a stored token from the keychain. */
  deleteOAuth2Token(tokenKey: string): Promise<void>
  /** ADDED (OAuth 2.0): the access token itself, for an explicit user action only (like revealEnvironmentVariable). */
  revealOAuth2Token(tokenKey: string): Promise<string>
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
  'extractFolderToCollection',
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
  'replaceCollectionFromPostman',
  'defaultExportPath',
  'writeExportFile',
  'chooseExportDirectory',
  'listCollectionVersions',
  'getCollectionVersion',
  'createCollectionVersion',
  'restoreCollectionVersion',
  'deleteCollectionVersion',
  'listWorkflows',
  'getWorkflow',
  'createWorkflow',
  'updateWorkflow',
  'duplicateWorkflow',
  'deleteWorkflow',
  'secureStoreGet',
  'secureStoreSet',
  'secureStoreDelete',
  'openExternalUrl',
  'prepareBrowserAuthCallback',
  'waitForBrowserAuthCallback',
  'getAppVersion',
  'getVersionInfo',
  'setWindowBackground',
  'checkForUpdates',
  'getWindowChrome',
  'setTitleBarStyle',
  'reopenWindow',
  'windowControl',
  'showAppMenu',
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
  'listCollectionVariables',
  'upsertCollectionVariable',
  'deleteCollectionVariable',
  'reorderCollectionVariables',
  'replaceCollectionVariables',
  'listGlobalVariables',
  'upsertGlobalVariable',
  'deleteGlobalVariable',
  'reorderGlobalVariables',
  'replaceGlobalVariables',
  'revealGlobalVariable',
  'getOAuth2Token',
  'cancelOAuth2Flow',
  'refreshOAuth2Token',
  'getOAuth2TokenStatus',
  'deleteOAuth2Token',
  'revealOAuth2Token',
  'getMcpStatus',
  'setMcpSettings',
  'revealMcpToken',
  'regenerateMcpToken',
  'mcpRespond',
  'mcpHostReady',
  'listMcpClients',
  'connectMcpClient',
  'disconnectMcpClient',
] as const satisfies readonly (keyof SlingerIpcApi)[]

export type IpcChannel = (typeof IPC_CHANNELS)[number]

/** Push channels (main -> renderer, `webContents.send`); NOT invoke channels, so not in IPC_CHANNELS. */
export const IPC_EVENT_CHANNELS = ['sync:event', 'menu:command', 'window:state', 'mcp:call'] as const
export const SYNC_EVENT_CHANNEL = IPC_EVENT_CHANNELS[0]
export const MENU_COMMAND_CHANNEL = IPC_EVENT_CHANNELS[1]
export const WINDOW_STATE_CHANNEL = IPC_EVENT_CHANNELS[2]
export const MCP_CALL_CHANNEL = IPC_EVENT_CHANNELS[3]

/** The invoke-only part of the API (everything except the push subscriptions), i.e. what main implements. */
export type SlingerInvokeApi = Omit<SlingerIpcApi, 'onSyncEvent' | 'onMenuCommand' | 'onWindowState' | 'onMcpCall'>

declare global {
  interface Window {
    slinger: SlingerIpcApi
  }
}
