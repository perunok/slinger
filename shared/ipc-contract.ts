/**
 * Single source of truth for the Electron IPC surface.
 *
 * - electron/ipc/handlers.ts registers `ipcMain.handle(channel, ...)` for every
 *   entry using this exact channel string and this exact signature.
 * - electron/preload.ts exposes `window.slinger.<methodName>` via contextBridge,
 *   calling `ipcRenderer.invoke(channel, ...args)` for each entry.
 * - src/tauri.ts (renderer-side client) calls `window.slinger.<methodName>(...)`.
 *
 * Do not rename a channel or change a signature here without updating both
 * the main-process handler and the renderer client in the same change.
 */
import type {
  ApiFolder,
  ApiRequest,
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
  PostmanImportResult,
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

  // Collections
  listCollections(workspaceId: string): Promise<Collection[]>
  createCollection(workspaceId: string, name: string): Promise<Collection>
  renameCollection(collectionId: string, name: string): Promise<Collection>
  deleteCollection(collectionId: string): Promise<void>

  // Folders
  listFolders(collectionId: string): Promise<ApiFolder[]>
  createFolder(input: CreateFolderInput): Promise<ApiFolder>
  renameFolder(folderId: string, name: string): Promise<ApiFolder>
  moveFolder(input: MoveFolderInput): Promise<ApiFolder>
  deleteFolder(folderId: string): Promise<void>

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
  cancelHttpRequest(requestRunId: string): Promise<void>

  // Postman import/export
  importPostmanCollection(workspaceId: string, fileContents: string): Promise<PostmanImportResult>
  defaultExportPath(fileName: string): Promise<string>
  writeExportFile(fileName: string, contents: string): Promise<void>

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
  'listCollections',
  'createCollection',
  'renameCollection',
  'deleteCollection',
  'listFolders',
  'createFolder',
  'renameFolder',
  'moveFolder',
  'deleteFolder',
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
  'importPostmanCollection',
  'defaultExportPath',
  'writeExportFile',
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
] as const satisfies readonly (keyof SlingerIpcApi)[]

export type IpcChannel = (typeof IPC_CHANNELS)[number]

declare global {
  interface Window {
    slinger: SlingerIpcApi
  }
}
