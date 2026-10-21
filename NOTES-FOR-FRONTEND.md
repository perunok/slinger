# Notes for the renderer (Svelte) side

`window.slinger` implements `SlingerIpcApi` (shared/ipc-contract.ts). Things you need to know
that are not obvious from the types:

## Errors
* Failures reject with a **plain object** `{ name: 'IpcError', code, message, details? }`, not an
  `Error` (Electron's contextBridge strips custom properties from Error objects). It is not
  `instanceof Error`/`IpcError`. Use `isIpcErrorPayload(e)` and `errorMessage(e)` from
  `shared/ipc-errors.ts`.
* Codes: `not_found`, `version_conflict` (`details.expectedVersion/currentVersion`),
  `invalid_input`, `io_error`, `network_error` (`details.cancelled` / `details.timedOut`),
  `internal_error`. Duplicate collection version label = `invalid_input` with
  `details.reason === 'duplicate_version'`.

## Additions to the contract (additive only)
* `revealEnvironmentVariable(variableId): Promise<string>` (only way to get a secret's value).
* `chooseExportDirectory(): Promise<string | null>` opens a native folder picker; afterwards
  `defaultExportPath(name)` / `writeExportFile(name, contents)` use that folder (default:
  Downloads, else home). `writeExportFile` takes a file *name* only and returns nothing; call
  `defaultExportPath` first if you want to show the user where the file went.
* `HttpRequestInput.requestRunId?: string | null` (1-128 chars `[A-Za-z0-9._:-]`): pass the same id
  to `cancelHttpRequest`. A run id cannot be in flight twice.
* `shared/ipc-errors.ts` (helpers above).
* Scripts: `runScripts(input)` runs a chain of pre-request or test scripts in the main-process sandbox and resolves with
  `RunScriptsResult` (script failures are in `errors[]`, not rejections; environment writes are already saved when it resolves,
  `environmentChanged` says to reload variables). `cancelHttpRequest(runId)` also cancels a script run with that `runId`.
  `setCollectionScripts(id, json|null)` / `setFolderScripts(id, json|null)` store the Postman `event` array (`[]` is stored as
  null); `Collection.scriptsJson` / `ApiFolder.scriptsJson` carry it (synced with cloud workspaces when the server supports it). `HttpRequestInput.scriptSessionId`
  names the script session whose secret reads are redacted from history.
* Persisted variables (synced with cloud workspaces when the server supports it; secret globals as metadata, `GlobalVariable.secretMissing` like environment variables): `list/upsert/delete/reorder/replaceCollectionVariables` (per collection, never
  secret: `isSecret: true` is rejected) and `list/upsert/delete/reorder/replaceGlobalVariables` + `revealGlobalVariable` (per
  workspace, secrets like environment variables). Pass `RunScriptsInput.collectionId` (null for a request outside a collection):
  main loads the collection's variables and the globals itself and saves script writes; `RunScriptsResult.collectionVariablesChanged`
  / `globalsChanged` say what to reload. `RunScriptsInput.globals` is ignored and `collectionVariables` is only the in-memory scope
  of a request without a collection.

* OAuth 2.0 (request auth): `getOAuth2Token(config, {flowId?, timeoutMs?})`, `cancelOAuth2Flow(flowId)`,
  `refreshOAuth2Token(config, {ifExpiring?})`, `getOAuth2TokenStatus(config)`, `deleteOAuth2Token(tokenKey)`,
  `revealOAuth2Token(tokenKey)`. `config` is `OAuth2Config` with every `{{variable}}` already resolved (zod-strict: all keys,
  no extras; `grantType` excludes `implicit`). They resolve with `OAuth2TokenStatus` (never the token): `tokenKey` (64 hex),
  `hasToken`, `expiresAt`/`obtainedAt` (Unix seconds or null), `expired`, `hasRefreshToken`, `scope`, `tokenType`,
  `maskedToken`. To send, put the key into `HttpRequestInput.auth = { kind: 'oauth2', oauth2: { tokenKey, addTo:
  'header' | 'query', headerPrefix } }`; main reads the token from the keychain and rejects with `invalid_input`
  (`details.reason` `oauth2_no_token` / `oauth2_expired`) when there is none or it has expired. Call
  `refreshOAuth2Token(config, { ifExpiring: true })` before a send: it refreshes only when the token expires within 30 s and
  has a refresh token, otherwise it just returns the status; a failed refresh rejects (`details.reason === 'refresh_failed'`,
  message says to get a new token). Errors: `invalid_input` for bad settings, provider errors (`details.oauthError`,
  `details.status`), state mismatch (`details.reason === 'state_mismatch'`), non-loopback redirect URI
  (`redirect_not_loopback`); `io_error` for keychain failures and a busy redirect port (`details.reason === 'port_in_use'`);
  `network_error` with `details.cancelled` / `details.timedOut` for a cancelled / timed-out browser sign-in (default 5 min).
  Tokens are keyed by workspace + identifying settings (not secrets), so requests with the same settings share one token;
  `deleteWorkspace` also deletes the workspace's tokens.
* `RunScriptsInput.request.auth` (optional `ScriptAuthData`): read-only `pm.request.auth` for scripts.
* Mock servers (local-only, in main memory): `startMockServer({workspaceId, collectionId, collectionName, port, examples,
  options?})` with the examples already resolved by the renderer (`lib/mockServers.ts collectMockExamples`; main never parses
  request documents). Starting a running collection on the same port only swaps the examples (and options); on another port
  the new one is bound first, so a failure keeps the old one. A busy port rejects with `io_error` and
  `details.reason === 'port_in_use'` (`'port_denied'` below 1024 without rights). `updateMockServer(collectionId, examples,
  collectionName?)` (live edits and renames; `not_found` when not running), `setMockServerOptions(collectionId, {cors,
  delayMs})` (live; `not_found` when not running), `stopMockServer` (no-op when not running), `listMockServers` (all
  workspaces), `getMockServerLog` / `clearMockServerLog` (at most `MOCK_LOG_LIMIT` = 200 entries, oldest first; each with the
  request's headers and a 64 KB body preview). `onMockServerEvent` pushes `started`, `updated` (options or name changed, also
  from the tray), `stopped` (`by`: 'user' from the window or the tray, 'quit', 'error' with a `reason`, 'replaced' when it
  moved port) and `request` (one log entry plus the server's `requestCount`).
* Team (who is in a shared cloud workspace): `SyncStatus.members` is the number of active members of the linked cloud workspace
  (you included), `null` when the workspace is not linked or the count was never read; it is stored (`cloud_links.member_count`,
  migration 0013), so it is right at startup, and main re-reads it at most once a minute per sync cycle (cycles run every minute while the window is focused, every 5 minutes otherwise; a manual Sync now, link, publish and
  `listWorkspaceMembers` always read it; a failed read keeps the old number). A change arrives as a normal `status` event.
  `listWorkspaceMembers(workspaceId): Promise<WorkspaceMember[]>` is a live fetch of all pages (at most 500) of
  `{ id, userId, email, displayName, role, joinedAt (Unix seconds), isYou }`; it also refreshes `members`. It rejects with
  `sync_blocked` when the workspace is not linked, `unauthenticated` when signed out, `network_error` when the cloud cannot be
  reached (and `sync_blocked`/`not_found` when access was lost). The workspace type does not change when a workspace is shared:
  show "team" with `isTeamWorkspace(ws, status)` (`features/team/team.ts`: `workspaceType === 'team' || members > 1`).

## Behavior
* Timestamps are Unix **seconds**.
* Collection variables / globals upsert: addressed by `variableId`, else by key; `enabled` / `description` left undefined keep
  the stored value; unlike environment variables a plain value is stored **exactly** (`''` empties it), only an existing
  *secret* global keeps its value on `''`. `expectedVersion` (optional) gives `version_conflict`. `replace*` is the bulk editor:
  the list becomes exactly the given entries in that order (ids of existing keys kept, missing keys deleted, a secret entry with
  `''` keeps the stored secret of that key). `reorder*` takes every live id once and does not bump versions. Lists are ordered by
  `sortOrder` and include disabled variables (`enabled: false`), which do not resolve.
* Secret variables: lists return `value: null, maskedValue: '••••••••'`. When you upsert an
  existing variable, an **empty `value` means "keep the current value"** (also when toggling
  `isSecret`); a new secret needs a non-empty value. Upserting without `variableId` updates the
  variable with the same key if there is one. Resolve `{{secrets}}` in the renderer via
  `revealEnvironmentVariable` (or `revealGlobalVariable` for a secret global) right before sending; `executeHttpRequest` rejects any request that
  still contains `{{ }}` (URL, header names/values, auth, body, enabled form rows).
* `executeHttpRequest`: only `enabled` form rows are sent; disabled rows are ignored. Send a
  `workspaceId` (history). Non-2xx responses resolve normally; failures reject and are still
  written to history. Response: use `bodyText` when non-null, else decode `bodyBase64`;
  `bodyByteLength` is the decoded size. GET/HEAD with a body is rejected.
* `updateRequest` needs the request's current `version` as `expectedVersion`; on
  `version_conflict` re-fetch (`listRequests`) and retry/merge. Every rename/move/update bumps
  `version`, so keep the returned object.
* Ordering: `sortOrder` is per sibling group, folders and requests separately (a folder's requests
  are ordered among themselves; child folders among themselves). `moveFolder`/`moveRequest`
  `targetIndex` is the index within the target group's siblings of the same kind (clamped).
  Folders cannot move into themselves or a descendant (`invalid_input`, `details.code ===
  'folder_cycle'`); folders cannot change collection.
* Deletes are soft on the backend but final from the UI's point of view; deleted ids return
  `not_found` afterwards. `deleteWorkspace` can leave zero workspaces; the app recreates
  "Personal" on next launch only.
* Postman import: the request `documentJson` keeps Postman-shaped `headers`, `body`, `auth`
  (falls back to the nearest folder/collection auth), `scripts` (item `event`), `responses`,
  `description` and the raw `source` item. An import with no requests fails without creating a
  collection. The collection's `variable` array becomes its collection variables
  (`PostmanImportResult.variableCount`); `replaceCollectionFromPostman` replaces them too.
* Collection versions: `createCollectionVersion` needs strict semver ("1.2.3", "2.0.0-beta.1";
  no `v`, no `+build`). `listCollectionVersions` is newest-first by semver precedence.
  `restoreCollectionVersion(id, 'replace')` recreates folders/requests with **new ids** (refetch
  folders/requests and close tabs of the old ones); `'copy'` returns the new collection. Both also set the collection variables
  from the snapshot (`snapshot.collectionVariables`, absent in older snapshots = none): reload them.
* Version authors: every `CollectionVersion` has `createdBy: {id: string | null, name: string} | null` (and `createdAt` in Unix
  seconds). It is set by main (the signed-in cloud user at creation; `createCollectionVersion` takes no author input) or by sync (the
  server's value, which can arrive after the version was created); `null` = unknown (signed out, older version, older server; authors from teammates need Slinger Cloud 0.4.0 or newer). `id` is
  `null` for an author whose account was deleted; compare `id` with `getCloudSession().user.id` for "(you)" and never match `null`.
  A sync `applied` event for a `collection_version` can mean only the author changed.
* `openExternalUrl` only accepts http/https. `secureStore*` cannot touch the reserved
  `slinger:env-var:`, `slinger:global-var:`, `slinger.cloud.tokens:` and `slinger:oauth2:` key prefixes.
* Content-Security-Policy: `script-src 'self'` (no inline/eval scripts), no network access from the
  renderer (`connect-src 'self'`): all HTTP goes through `executeHttpRequest`. Inline styles and
  data:/blob: images/workers are allowed.
* Vite `base` is now `'./'` (vite.config.ts) so the built renderer loads from the `app://` origin.
  `npm run electron:dev` starts Vite itself on port 5173.
