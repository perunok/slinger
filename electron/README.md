# Slinger main process (Electron + TypeScript)

Local-first API client. This directory is the Electron **main process**; it replaces the old
Rust/Tauri backend in `src-tauri/` (kept only as a behavior reference).

## Layout

```
electron/
  main.ts            app lifecycle, window, app:// protocol + CSP, session hardening   (imports electron)
  preload.ts         contextBridge -> window.slinger                                     (imports electron)
  ipc/handlers.ts    ipcMain.handle for every channel, sender check, error envelope      (imports electron)
  ipc/api.ts         createIpcApi(): zod validation + dispatch to services (pure, testable)
  ipc/envelope.ts    { ok, value } | { ok:false, error } wire type
  db/                database.ts (open + pragmas), migrate.ts (migration runner)
  migrations/        numbered .sql files
  repositories/      SQL access per aggregate (workspaces, collections, tree=folders+requests, environments, history)
  services/          httpExecutor/httpService, postmanImport, collectionVersions, semver, secrets,
                     exportFiles, externalUrl, authCallback, core (wiring)
  lib/               errors, ids (UUID), text helpers, csp
  __tests__/         vitest suites (run under plain Node, in-memory SQLite)
shared/              types.ts + ipc-contract.ts (the fixed contract), ipc-errors.ts (renderer helpers)
```

Only `main.ts`, `preload.ts` and `ipc/handlers.ts` import `electron`. Everything else is plain
Node, which is why the whole business layer is covered by vitest without launching Electron.

Request path: renderer -> `window.slinger.x()` (preload) -> `ipcRenderer.invoke('x')` ->
`handlers.ts` (trusted-sender check) -> `api.ts` (zod parse of every argument) -> repository or
service (UUID validation again, then SQL) -> envelope back -> preload resolves or rejects.

## Commands

| Command | What it does |
| --- | --- |
| `npm test` | vitest (switches `better-sqlite3` to the Node build first via `pretest`) |
| `npm run typecheck` | `tsc` over `electron/`, `shared/` |
| `npm run electron:dev` | rebuilds the main bundle, starts Vite on :5173, launches Electron pointed at it |
| `npm run electron:build` | Vite build of the renderer, bundle main/preload, rebuild native module for Electron, `electron-builder` (win/mac/linux per `electron-builder.yml`) |
| `npm run rebuild:node` / `rebuild:electron` | force the native `better-sqlite3` binary for Node or Electron |

`better-sqlite3` is compiled against one ABI at a time. `scripts/ensure-native.mjs` records which
one is installed (`node_modules/.slinger-native-target`) and switches on demand, so `npm test` and
`npm run electron:dev` can be used back to back. (`better-sqlite3` 13 requires Node 22 and crashes
inside Electron 33's Node 20, so the project pins `^12`.)

`SLINGER_SMOKE_TEST=1 SLINGER_USER_DATA_DIR=<tmp> electron .` runs a headless self-check
(preload, IPC, error transport, HTTP, keychain, CSP header) and prints `SMOKE_RESULT {...}`.

## Database and migrations

* File: `<userData>/slinger.db` (WAL, `foreign_keys=ON`).
* `db/migrate.ts` applies `electron/migrations/NNNN_name.sql` in numeric order, each in its own
  transaction, and records `id, name, sha256, applied_at` in `_migrations`.
  Re-running applies nothing. Startup aborts if an applied file was edited (checksum) or if the
  database contains a migration the app does not ship (database newer than app).
  **Never edit a released migration; add the next number.**
* `0001_init.sql` base schema, `0002_collection_versions.sql` semver snapshots,
  `0003_integrity.sql` unique env-var keys, ordering indexes, immutability trigger.
* Timestamps are Unix **seconds** (same unit the old backend used).

### Soft delete and versions

Deleting workspaces, collections, folders, requests, environments, variables and collection
versions sets `deleted = 1` (and bumps `version`/`updated_at`); every read filters `deleted = 0` and
also requires live parents. Cascades (workspace -> everything, collection -> folders/requests/
versions, folder -> descendant folders and their requests) run in one transaction. History rows are
an append-only log and are removed for real by `clearHistory`/`deleteHistoryEntry`
(capped at 1000 rows per workspace).

`version` is bumped on every update/rename/move/soft delete of the affected row. `updateRequest`
requires `expectedVersion` and throws `version_conflict` (`details.currentVersion`) on mismatch.
Reordering siblings only rewrites their `sort_order`, not their `version`, so it never causes
false conflicts.

### Ordering

`sortOrder` is per sibling group: folders are ordered among folders with the same
`(collectionId, parentFolderId)`, requests among requests with the same `(collectionId, folderId)`.
`moveFolder` rejects moving a folder into itself or a descendant.

## Secret storage

* Service name `Slinger` in the OS keychain (`@napi-rs/keyring`: Keychain / Credential Manager /
  Secret Service).
* Secret environment variables: the SQLite row has `value = NULL`, `is_secret = 1` and
  `secret_ref = 'slinger:env-var:<variable id>'`; the value lives only in the keychain. Lists return
  `value: null, maskedValue: '••••••••'`. The only way to read one is
  `revealEnvironmentVariable(id)`. Deleting a variable, its environment or its workspace removes the
  keychain entries.
* `secureStoreGet/Set/Delete` are a generic passthrough for other keys (cloud tokens). The
  `slinger:env-var:` namespace is refused there, so it cannot be used to bypass the mask.
* Collection version snapshots contain folders and requests only, never environments.
* If the keychain is unavailable (e.g. headless Linux without a Secret Service) secret operations
  fail with `io_error`; the rest of the app keeps working.

## HTTP executor

`services/httpExecutor.ts` (pure `fetch`): URL normalization (adds `http://`, only http/https
allowed), rejection of unresolved `{{ }}` anywhere on the wire (URL, header names/values, auth,
raw/urlEncoded/form bodies; disabled rows are ignored), server-side auth (basic, bearer, apiKey in
header or query), body modes `none | raw | formData (multipart incl. files) | urlEncoded | binary`,
timeouts (default 60 s), cancellation through `requestRunId`, and text-vs-base64 response bodies
(`bodyText` when the bytes decode, else `bodyBase64`; `bodyByteLength` always set). `HttpService`
wraps it, tracks cancellable runs and records **every** attempt in `history`
(successes, HTTP errors, network failures, cancellations, validation failures). The history URL is
stored without API-key query parameters added by auth.

## IPC security

* `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; preload exposes only the
  channels in `IPC_CHANNELS`.
* Every handler rejects frames that are not the app's own origin (`app://slinger/` or the dev server).
* The renderer is served from a privileged `app://` scheme with a strict CSP
  (`default-src 'none'; script-src 'self'; ...`), permission requests are denied, navigation away
  from the app is blocked and `window.open` goes to the OS browser (http/https only).
* All IDs are validated as UUIDs before any query or path; all arguments are zod-validated in
  `ipc/api.ts`. Export writes accept only a file **name** which is reduced to a basename inside the
  chosen/default export directory; symlink targets are refused.
* Errors cross the bridge as `{ name: 'IpcError', code, message, details? }` plain objects
  (Electron drops custom Error properties); see `shared/ipc-errors.ts`.

## Collection versions

Immutable semver snapshots of a collection's folders and requests
(`services/collectionVersions.ts`, strict semver 2.0.0 in `services/semver.ts`: optional
prerelease, no build metadata, no leading `v`, no leading zeros). Duplicate labels per collection
are rejected (`invalid_input`, `details.reason = 'duplicate_version'`); a SQLite trigger blocks any
UPDATE other than the `deleted` flag. Restore modes: `replace` (soft-deletes current
folders/requests, recreates the snapshot with new ids, in one transaction) and `copy`
(new collection `"<name> (v<version>)"`).
