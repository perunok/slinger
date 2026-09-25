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

## Behavior
* Timestamps are Unix **seconds**.
* Secret variables: lists return `value: null, maskedValue: '••••••••'`. When you upsert an
  existing variable, an **empty `value` means "keep the current value"** (also when toggling
  `isSecret`); a new secret needs a non-empty value. Upserting without `variableId` updates the
  variable with the same key if there is one. Resolve `{{secrets}}` in the renderer via
  `revealEnvironmentVariable` right before sending; `executeHttpRequest` rejects any request that
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
  collection.
* Collection versions: `createCollectionVersion` needs strict semver ("1.2.3", "2.0.0-beta.1";
  no `v`, no `+build`). `listCollectionVersions` is newest-first by semver precedence.
  `restoreCollectionVersion(id, 'replace')` recreates folders/requests with **new ids** (refetch
  folders/requests and close tabs of the old ones); `'copy'` returns the new collection.
* `openExternalUrl` only accepts http/https. `secureStore*` cannot touch the reserved
  `slinger:env-var:` key prefix.
* Content-Security-Policy: `script-src 'self'` (no inline/eval scripts), no network access from the
  renderer (`connect-src 'self'`): all HTTP goes through `executeHttpRequest`. Inline styles and
  data:/blob: images/workers are allowed.
* Vite `base` is now `'./'` (vite.config.ts) so the built renderer loads from the `app://` origin.
  `npm run electron:dev` starts Vite itself on port 5173.
