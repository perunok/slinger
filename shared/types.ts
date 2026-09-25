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

/**
 * ADDED (docs): the Postman shape a collection/folder description was imported as. `null` = a plain string
 * (Markdown, the usual case); otherwise the `type` of a `{content, type}` object, written back on export.
 */
export type DescriptionType = 'text/markdown' | 'text/plain'

export interface Collection {
  id: string
  workspaceId: string
  name: string
  /**
   * ADDED (scripts): the collection's Postman `event` array (pre-request / test scripts) as JSON text, or null.
   * Local-only: not carried by cloud sync in v1. Optional so older fixtures stay valid; main always sets it.
   */
  scriptsJson?: string | null
  /**
   * ADDED (docs): the collection's documentation (Postman `description`; Markdown unless `descriptionType` is
   * 'text/plain'), or null. Local-only like `scriptsJson`. Optional so older fixtures stay valid; main always sets it.
   */
  description?: string | null
  descriptionType?: DescriptionType | null
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
  /** ADDED (scripts): the folder's Postman `event` array as JSON text, or null (see Collection.scriptsJson). */
  scriptsJson?: string | null
  /** ADDED (docs): the folder's documentation, see Collection.description. */
  description?: string | null
  descriptionType?: DescriptionType | null
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
  /** Secret variable created by another device: its value is not set on this device (see sync design D3). */
  secretMissing: boolean
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
  /**
   * ADDED (ts-rewrite main process): id used to cancel this run via
   * cancelHttpRequest(requestRunId). Optional; 1-128 chars of [A-Za-z0-9._:-].
   * A run id may only be in flight once at a time.
   */
  requestRunId?: string | null
  /**
   * ADDED: what to store in history instead of `url`. The renderer resolves templates before
   * sending, so `url` may contain secret values or an apiKey query parameter; it passes the URL
   * with secrets left as `{{name}}` placeholders and without auth query parameters here.
   */
  historyUrl?: string | null
  /**
   * ADDED (scripts): the script session of this send / collection run (RunScriptsInput.sessionId). Secret values
   * that scripts of the session read are replaced by `{{name}}` in the history entry.
   */
  scriptSessionId?: string | null
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

/**
 * Input of `cloudFetch`: the app's own cloud API transport. Deliberately narrower than
 * HttpRequestInput: no auth block, no file bodies, no workspace, and it never creates history rows.
 */
export interface CloudFetchInput {
  method: string
  url: string
  headers: RequestHeader[]
  body?: { content: string; contentType: string } | null
  timeoutMs?: number
}

/** Options for the native file picker (`pickFile`): single file selection. */
export interface PickFileOptions {
  title?: string
  /** Directory or file the dialog opens at (e.g. a saved path that must be granted again). */
  defaultPath?: string
  filters?: Array<{ name: string; extensions: string[] }>
}

// ---------------------------------------------------------------------------
// Postman import/export
// ---------------------------------------------------------------------------

export interface PostmanImportResult {
  collection: Collection
  folders: ApiFolder[]
  requests: ApiRequest[]
  /** ADDED (scripts): non-empty pre-request/test scripts imported (collection + folders + requests). */
  scriptCount?: number
}

// ---------------------------------------------------------------------------
// Collection versions (immutable snapshots labelled with a semantic version)
// ---------------------------------------------------------------------------

/** Frozen copy of a collection's content at the time a version was created. */
export interface CollectionSnapshot {
  collectionName: string
  /** ADDED (scripts): collection-level scripts (Postman `event` JSON) at snapshot time; absent in older snapshots. */
  collectionScriptsJson?: string | null
  /** ADDED (docs): collection description at snapshot time; absent in older snapshots or when empty. */
  collectionDescription?: string | null
  collectionDescriptionType?: DescriptionType | null
  folders: Array<Pick<ApiFolder, 'id' | 'parentFolderId' | 'name' | 'sortOrder' | 'scriptsJson' | 'description' | 'descriptionType'>>
  requests: Array<
    Pick<ApiRequest, 'id' | 'folderId' | 'name' | 'method' | 'url' | 'documentJson' | 'sortOrder'>
  >
}

export interface CollectionVersion {
  id: string
  workspaceId: string
  collectionId: string
  /** Semantic version 2.0.0 string, e.g. "1.4.0" or "2.0.0-beta.1" (no leading "v"). */
  version: string
  notes: string | null
  folderCount: number
  requestCount: number
  createdAt: number
}

export interface CollectionVersionDetail extends CollectionVersion {
  snapshot: CollectionSnapshot
}

export interface CreateCollectionVersionInput {
  collectionId: string
  /** Must be valid semver and not already used for this collection. */
  version: string
  notes?: string | null
}

export type RestoreCollectionVersionMode =
  /** Overwrite the live collection's folders/requests with the snapshot. */
  | 'replace'
  /** Create a new collection named "<name> (v<version>)" from the snapshot; live collection untouched. */
  | 'copy'

// ---------------------------------------------------------------------------
// Scripts (Postman-compatible pre-request / test scripts, run in the main process in a QuickJS sandbox)
// ---------------------------------------------------------------------------

export type ScriptEventName = 'prerequest' | 'test'

/** One script of the chain; the chain is ordered collection -> folders (outer to inner) -> request. */
export interface ScriptSource {
  origin: 'collection' | 'folder' | 'request'
  /** Name of the collection / folder / request, used in console, test and error labels. */
  name: string
  code: string
}

export interface ScriptKeyValue {
  key: string
  value: string
  disabled?: boolean
}

/** The request as scripts see it (`pm.request`). Templates are unresolved in pre-request scripts. */
export interface ScriptRequestData {
  method: string
  url: string
  headers: ScriptKeyValue[]
  body: {
    mode: 'none' | 'raw' | 'urlencoded' | 'formdata' | 'file' | 'other'
    raw?: string
    /** Raw body language (json, text, xml, html, javascript). */
    language?: string
    urlencoded?: ScriptKeyValue[]
    formdata?: ScriptKeyValue[]
  }
}

/** The response as test scripts see it (`pm.response`). */
export interface ScriptResponseData {
  code: number
  status: string
  headers: RequestHeader[]
  /** Decoded body text (null for binary bodies); capped before it enters the sandbox. */
  body: string | null
  responseTime: number
  size: number
}

/** Plain JSON values a script stored with pm.variables / pm.collectionVariables / pm.globals. */
export type ScriptVariables = Record<string, unknown>

export interface RunScriptsInput {
  /** Cancellation handle (also accepted by cancelHttpRequest); same grammar as requestRunId. */
  runId: string
  /** Groups the script runs of one send or one collection run (history redaction of secrets they read). */
  sessionId: string
  workspaceId: string
  /** Active environment (pm.environment), or null. */
  environmentId: string | null
  event: ScriptEventName
  scripts: ScriptSource[]
  request: ScriptRequestData
  response?: ScriptResponseData | null
  /** Local scope (pm.variables.set) of this send / collection run. */
  variables: ScriptVariables
  /** Session-only scopes (not persisted in v1). */
  collectionVariables: ScriptVariables
  globals: ScriptVariables
  info: { requestName: string; requestId: string | null; iteration: number; iterationCount: number }
  /** Per-script time limit in ms (default 5000, max 60000). Time waiting for pm.sendRequest does not count. */
  timeoutMs?: number
  /** Default pm.sendRequest timeout in ms (the request's own timeout; default 60000, capped at 120000). */
  sendRequestTimeoutMs?: number
  /** Pre-request only: keep running the remaining scripts after one fails (default false). */
  continueOnError?: boolean
}

export type ScriptConsoleLevel = 'log' | 'info' | 'warn' | 'error'

export interface ScriptConsoleEntry {
  level: ScriptConsoleLevel
  message: string
  /** Epoch milliseconds. */
  timestamp: number
  /** e.g. "Pre-request · collection “Payments”". */
  source: string
}

export interface ScriptTestResult {
  name: string
  status: 'passed' | 'failed' | 'skipped'
  error: string | null
  source: string
}

export interface ScriptErrorInfo {
  source: string
  kind: 'error' | 'timeout' | 'cancelled' | 'memory' | 'internal'
  message: string
}

export interface RunScriptsResult {
  event: ScriptEventName
  /** Scripts that failed (uncaught error, timeout, cancel, memory). Empty when all ran. */
  errors: ScriptErrorInfo[]
  /** The request after pre-request mutations, or null when no script changed it. Never saved. */
  request: ScriptRequestData | null
  variables: ScriptVariables
  collectionVariables: ScriptVariables
  globals: ScriptVariables
  /** True when the active environment was written (the renderer reloads its variables). */
  environmentChanged: boolean
  console: ScriptConsoleEntry[]
  tests: ScriptTestResult[]
  durationMs: number
}

// ---------------------------------------------------------------------------
// Secure storage (OS keychain, proxied through the main process)
// ---------------------------------------------------------------------------

export interface SecureStoreSetInput {
  key: string
  value: string
}

// ---------------------------------------------------------------------------
// Cloud sync
// ---------------------------------------------------------------------------

export type CloudRole = 'owner' | 'admin' | 'editor' | 'viewer'

export type SyncEntityType =
  | 'collection'
  | 'folder'
  | 'request'
  | 'environment'
  | 'environment_variable'
  | 'collection_version'

export interface CloudConfig {
  apiBaseUrl: string
  deviceName: string
}

export interface CloudUser {
  id: string
  email: string
  displayName: string
}

export interface CloudSession {
  apiBaseUrl: string
  status: 'signedOut' | 'signingIn' | 'signedIn'
  user: CloudUser | null
  /** True when the last server contact failed for network reasons (session is still valid). */
  offline: boolean
}

export interface CloudSignInStart {
  userCode: string
  verificationUri: string
  verificationUriComplete: string | null
  expiresInSec: number
  intervalSec: number
}

export interface RemoteWorkspace {
  id: string
  name: string
  slug: string
  role: CloudRole
  /** Local workspace on THIS device linked to it, if any. */
  linkedLocalWorkspaceId: string | null
}

export interface RemoteWorkspacePreview {
  id: string
  name: string
  role: CloudRole
  /** null when it could not be determined (offline mid-call). */
  remoteEmpty: boolean | null
  linkedLocalWorkspaceId: string | null
  /** Additive: what the remote workspace holds (null when it could not be counted, e.g. offline). */
  counts?: RemoteWorkspaceCounts | null
}

export interface RemoteWorkspaceCounts {
  collections: number
  folders: number
  requests: number
  environments: number
  /** true when the workspace is larger than the counting limit (the numbers are lower bounds). */
  truncated: boolean
}

export type SyncState =
  | 'unlinked'
  | 'signedOut'
  | 'idle'
  | 'syncing'
  | 'offline'
  | 'error'
  | 'accessRevoked'
  | 'serverUnsupported'

export interface SyncProgress {
  phase: 'snapshot' | 'pull' | 'push'
  done: number
  /** null when unknown (pull). */
  total: number | null
}

export interface SyncStatus {
  workspaceId: string
  linked: boolean
  state: SyncState
  apiBaseUrl: string | null
  remoteWorkspaceId: string | null
  remoteName: string | null
  role: CloudRole | null
  /** True when local writes are blocked (viewer role). Mutations reject with code 'read_only'. */
  readOnly: boolean
  autoSync: boolean
  /** Entities with local changes not yet acknowledged by the cloud. */
  pendingChanges: number
  openConflicts: number
  /** true until the first upload/download after link/publish completed. */
  initialSyncPending: boolean
  lastSyncedAt: number | null // epoch seconds
  lastError: { code: string; message: string } | null
  /** Epoch seconds of the next automatic retry while backing off, else null. */
  nextRetryAt: number | null
  progress: SyncProgress | null
}

export type SyncConflictKind =
  | 'edit_edit'
  | 'remote_deleted'
  | 'local_deleted'
  | 'duplicate_key'
  | 'immutable_clash'
  | 'rejected'

export type SyncResolution = 'keep_local' | 'keep_remote' | 'merge' | 'duplicate'

/** One field group of a conflicting entity. Values are display strings; secret values never appear. */
export interface SyncConflictGroup {
  group: 'name' | 'content' | 'location' | 'order' | 'key' | 'value'
  label: string
  conflicting: boolean
  base: string | null
  local: string | null
  remote: string | null
  /**
   * Additive (request `content` group only): JSON text of `{name, method, url, document_json}` for each side, so the
   * renderer can diff headers/body/auth instead of only comparing the fingerprint in `base`/`local`/`remote`.
   * Never contains secret values (secret variables carry none on the wire).
   */
  baseDetail?: string | null
  localDetail?: string | null
  remoteDetail?: string | null
}

export interface SyncConflict {
  id: string
  workspaceId: string
  entityType: SyncEntityType
  entityId: string
  kind: SyncConflictKind
  status: 'open' | 'resolved' | 'auto_resolved'
  /** Entity name at detection time. */
  label: string
  /** Breadcrumb, e.g. ['Payments API', 'Auth', 'Create token']. */
  path: string[]
  message: string
  groups: SyncConflictGroup[]
  allowedResolutions: SyncResolution[]
  createdAt: number
  resolvedAt: number | null
  resolution: SyncResolution | null
}

export interface ResolveSyncConflictInput {
  conflictId: string
  resolution: SyncResolution
  /** Required for 'merge': per conflicting group, which side to keep. */
  fieldChoices?: Partial<Record<SyncConflictGroup['group'], 'local' | 'remote'>>
  /** Required for kind 'immutable_clash' + 'duplicate': the new semver label for the recreated version. */
  newVersion?: string
}

export interface LinkRemoteWorkspaceInput {
  remoteWorkspaceId: string
  /** Local workspace to merge into, or null to create a new local workspace from the cloud one. */
  localWorkspaceId: string | null
}

export type SyncEvent =
  | { type: 'status'; status: SyncStatus }
  | {
      type: 'applied'
      workspaceId: string
      /** Ids changed by pull/resolution; renderer refetches the affected lists. Capped at 500, then truncated = true. */
      changed: Array<{ entityType: SyncEntityType; entityId: string; change: 'upsert' | 'delete' }>
      truncated: boolean
    }
  | { type: 'conflicts'; workspaceId: string; open: number }
  | { type: 'auth'; session: CloudSession }
  | { type: 'signInResult'; result: 'approved' | 'expired' | 'denied' | 'cancelled' | 'error'; message: string | null }

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
    | 'read_only'
    | 'unauthenticated'
    | 'sync_blocked'
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
