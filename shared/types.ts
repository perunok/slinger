/**
 * Shared domain types for Slinger desktop app.
 * Imported by both the Electron main process (electron/**) and the
 * Svelte renderer (src/**). Keep this file dependency-free (no Node,
 * no DOM) so it can be imported from either side unchanged.
 */

// ---------------------------------------------------------------------------
// Core entities
// ---------------------------------------------------------------------------

export interface Workspace {
  id: string
  name: string
  workspaceType: 'personal' | 'team'
  createdAt: number
  updatedAt: number
  version: number
}

export interface Collection {
  id: string
  workspaceId: string
  name: string
  createdAt: number
  updatedAt: number
  version: number
}

export interface ApiFolder {
  id: string
  workspaceId: string
  collectionId: string
  parentFolderId: string | null
  name: string
  sortOrder: number
  createdAt: number
  updatedAt: number
  version: number
}

export interface ApiRequest {
  id: string
  workspaceId: string
  collectionId: string
  folderId: string | null
  name: string
  method: string
  url: string
  documentJson: string
  sortOrder: number
  createdAt: number
  updatedAt: number
  version: number
}

export interface Environment {
  id: string
  workspaceId: string
  name: string
  createdAt: number
  updatedAt: number
  version: number
}

export interface EnvironmentVariable {
  id: string
  environmentId: string
  key: string
  /** Present only when isSecret === false. Secret values are never sent to the renderer. */
  value: string | null
  isSecret: boolean
  /** Present only when isSecret === true, e.g. "••••••••". */
  maskedValue: string | null
  createdAt: number
  updatedAt: number
  version: number
}

export interface HistoryEntry {
  id: string
  workspaceId: string
  requestId: string | null
  requestName: string | null
  method: string
  url: string
  statusCode: number | null
  ok: boolean
  errorMessage: string | null
  durationMs: number
  createdAt: number
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface CreateRequestInput {
  workspaceId: string
  collectionId: string
  folderId?: string | null
  name: string
  method: string
  url: string
  documentJson: string
}

export interface UpdateRequestInput {
  requestId: string
  name: string
  method: string
  url: string
  documentJson: string
  /** Expected current version, for optimistic-concurrency checks. */
  expectedVersion: number
}

export interface MoveRequestInput {
  requestId: string
  targetCollectionId: string
  targetFolderId: string | null
  targetIndex: number
}

export interface CreateFolderInput {
  workspaceId: string
  collectionId: string
  parentFolderId?: string | null
  name: string
}

export interface MoveFolderInput {
  folderId: string
  targetParentFolderId: string | null
  targetIndex: number
}

export interface UpsertEnvironmentVariableInput {
  environmentId: string
  key: string
  value: string
  isSecret: boolean
  /** Set when updating an existing variable; omit to create a new one. */
  variableId?: string
}

// ---------------------------------------------------------------------------
// HTTP execution
// ---------------------------------------------------------------------------

export interface RequestHeader {
  key: string
  value: string
}

export type AuthKind = 'none' | 'basic' | 'bearer' | 'apiKey'

export interface ResolvedAuth {
  kind: AuthKind
  basic?: { username: string; password: string }
  bearer?: { token: string }
  apiKey?: { key: string; value: string; addTo: 'header' | 'query' }
}

export type BodyMode = 'none' | 'raw' | 'formData' | 'urlEncoded' | 'binary'

export interface FormDataField {
  key: string
  value: string
  /** Absolute file path, only for type === 'file'. */
  filePath?: string
  type: 'text' | 'file'
  enabled: boolean
}

export interface UrlEncodedField {
  key: string
  value: string
  enabled: boolean
}

export interface ResolvedBody {
  mode: BodyMode
  raw?: { content: string; contentType: string }
  formData?: FormDataField[]
  urlEncoded?: UrlEncodedField[]
  /** Absolute file path for a raw binary upload. */
  binaryFilePath?: string
}

export interface HttpRequestInput {
  method: string
  url: string
  headers: RequestHeader[]
  auth: ResolvedAuth
  body: ResolvedBody
  timeoutMs?: number
  /** For history + response-viewer labeling; not sent over the wire. */
  requestId?: string | null
  requestName?: string | null
  workspaceId: string
}

export interface HttpResponseData {
  status: number
  statusText: string
  durationMs: number
  headers: RequestHeader[]
  /** Present when the body decodes as UTF-8 text. */
  bodyText: string | null
  /** Present when the body is not valid UTF-8; base64-encoded raw bytes. */
  bodyBase64: string | null
  bodyByteLength: number
}

// ---------------------------------------------------------------------------
// Postman import/export
// ---------------------------------------------------------------------------

export interface PostmanImportResult {
  collection: Collection
  folders: ApiFolder[]
  requests: ApiRequest[]
}

// ---------------------------------------------------------------------------
// Workspace versioning (local git-backed snapshots)
// ---------------------------------------------------------------------------

export interface WorkspaceVersioningStatus {
  initialized: boolean
  repoPath: string
  changedFiles: WorkspaceVersioningFileChange[]
}

export interface WorkspaceVersioningFileChange {
  path: string
  status: 'added' | 'modified' | 'deleted'
}

export interface WorkspaceVersioningCommit {
  id: string
  shortId: string
  message: string
  author: string
  authoredAt: number
}

export interface WorkspaceVersioningRestoreResult {
  commitId: string
  restoredFiles: number
}

// ---------------------------------------------------------------------------
// Secure storage (OS keychain, proxied through the main process)
// ---------------------------------------------------------------------------

export interface SecureStoreSetInput {
  key: string
  value: string
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Discriminated error shape returned by every IPC call on failure. */
export interface IpcErrorPayload {
  code:
    | 'not_found'
    | 'version_conflict'
    | 'invalid_input'
    | 'io_error'
    | 'network_error'
    | 'internal_error'
  message: string
  details?: Record<string, unknown>
}

export class IpcError extends Error {
  code: IpcErrorPayload['code']
  details?: Record<string, unknown>

  constructor(payload: IpcErrorPayload) {
    super(payload.message)
    this.name = 'IpcError'
    this.code = payload.code
    this.details = payload.details
  }
}
