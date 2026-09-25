# Slinger main process (Electron + TypeScript)

Local-first API client. This directory is the Electron **main process** (SQLite, HTTP executor, keychain, files, dialogs).
See [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) for the whole-app picture and
[../NOTES-FOR-FRONTEND.md](../NOTES-FOR-FRONTEND.md) for behavior notes for callers of `window.slinger`.

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
  services/          httpExecutor/httpService, scriptService, postmanImport, collectionVersions, semver, secrets,
                     exportFiles, externalUrl, authCallback, core (wiring)
  scripts/           pre-request/test script sandbox: QuickJS (WASM) runner, pm API prelude, worker-thread pool
  cloud/             cloud HTTP client (http.ts), device-flow sign-in + token refresh (auth.ts), typed API (api.ts)
  sync/              collection sync engine: index.ts (SyncService, IPC methods), engine (cycle, status, backoff),
                     outbox (push side), apply (pull side), merge, mapping, conflicts, linking, scheduler, store
  lib/               errors, ids (UUID), text helpers, csp
  __tests__/         vitest suites (run under plain Node, in-memory SQLite); sync/ uses an in-process fake
                     cloud server, sync-it/ the real slinger-admin server (opt-in)
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
| `npm test` | vitest for `electron/**` then the renderer suite (switches `better-sqlite3` to the Node build first via `pretest`); `npm run test:main` runs only this directory |
| `npm run typecheck` | `tsc` over `electron/` + `shared/`, `tsc` over `e2e/`, `svelte-check` over the renderer |
| `npm run test:e2e` | builds, then drives the real Electron app with Playwright (`e2e/`); the cloud/sync specs need `SLINGER_E2E_CLOUD_URL` (+ `_EMAIL`, `_PASSWORD`) |
| `SLINGER_SYNC_IT_SERVER_DIR=../slinger-admin/server npm run test:sync-it` | sync engine against the real server + a throwaway `postgres:16-alpine` container (removed afterwards); `node scripts/sync-it-server.mjs` starts the same server by hand and prints its URL and admin login |
| `npm run electron:dev` | rebuilds the main bundle, starts Vite on :5173, launches Electron pointed at it |
| `npm run electron:build` | Vite build of the renderer, bundle main/preload, rebuild native module for Electron, `electron-builder` (win/mac/linux per `electron-builder.yml`) |
| `npm run rebuild:node` / `rebuild:electron` | force the native `better-sqlite3` binary for Node or Electron |

`better-sqlite3` is compiled against one ABI at a time. `scripts/ensure-native.mjs` records which
one is installed (`node_modules/.slinger-native-target`) and switches on demand, so `npm test` and
`npm run electron:dev` can be used back to back. (`better-sqlite3` 13 requires Node 22 and crashes
inside Electron 33's Node 20, so the project pins `^12`.)

`SLINGER_SMOKE_TEST=1 SLINGER_USER_DATA_DIR=<tmp> electron .` runs a headless self-check
(preload, IPC, error transport, HTTP, keychain, CSP header, script worker incl. `require('crypto-js')`) and prints
`SMOKE_RESULT {...}`.

## Database and migrations

* File: `<userData>/slinger.db` (WAL, `foreign_keys=ON`).
* `db/migrate.ts` applies `electron/migrations/NNNN_name.sql` in numeric order, each in its own
  transaction, and records `id, name, checksum (SHA-256), applied_at` in `_migrations`.
  Re-running applies nothing. Startup aborts if an applied file was edited (checksum) or if the
  database contains a migration the app does not ship (database newer than app).
  **Never edit a released migration; add the next number.**
* `0001_init.sql` base schema, `0002_collection_versions.sql` semver snapshots,
  `0003_integrity.sql` unique env-var keys, ordering indexes, immutability trigger,
  `0004_sync.sql` cloud sync: `cloud_links` bookkeeping, `sync_entities` (merge base), `sync_dirty` (outbox),
  `sync_sent_ops`, `sync_conflicts`, `app_settings`, `secret_missing`, and the capture / read-only triggers.
* Timestamps are Unix **seconds**.

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
* `secureStoreGet/Set/Delete` are a generic passthrough for other keys. The `slinger:env-var:` and
  `slinger.cloud.tokens:` namespaces are refused there, so they cannot be used to bypass the mask or read
  the cloud tokens (which only the main process uses).
* Collection version snapshots contain folders and requests only, never environments.
* If the keychain is unavailable (e.g. headless Linux without a Secret Service) secret operations
  fail with `io_error`; the rest of the app keeps working.

## Cloud sync

Design and protocol: [../docs/SYNC_DESIGN.md](../docs/SYNC_DESIGN.md) (section 20 = implementation notes),
overview in [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md#cloud-sync-main-process).

* Tokens live only in the keychain (`slinger.cloud.tokens:<baseUrl>`, reserved: `secureStore*` refuses the prefix) and never
  reach the renderer. Cloud calls never write request history.
* Everything that changes a linked workspace's collections, folders, requests, environments, variables or versions is captured
  by triggers into `sync_dirty`; nothing in the repositories has to remember to call the engine. Writes to a read-only (viewer)
  link fail with `read_only`.
* The engine talks protocol v2 only (`protocol_version >= 2` at client registration, else `serverUnsupported`) and branches
  on the push rejection `reason` (legacy `code` as fallback).
* `SLINGER_KEYCHAIN_NAMESPACE=<ns>` uses keychain service `Slinger.<ns>` (e2e: one per profile).

## HTTP executor

`services/httpExecutor.ts` (pure `fetch`): URL normalization (adds `http://`, only http/https
allowed), rejection of unresolved `{{ }}` anywhere on the wire (URL, header names/values, auth,
raw/urlEncoded/form bodies; disabled rows are ignored), server-side auth (basic, bearer, apiKey in
header or query), body modes `none | raw | formData (multipart incl. files) | urlEncoded | binary`,
timeouts (default 60 s), cancellation through `requestRunId`, and text-vs-base64 response bodies
(`bodyText` when the bytes decode, else `bodyBase64`; `bodyByteLength` always set). `HttpService`
wraps it, tracks cancellable runs and records **every** attempt in `history`
(successes, HTTP errors, network failures, cancellations, validation failures). The history URL is
stored without API-key query parameters added by auth, and with secret values that scripts of the
request's `scriptSessionId` read replaced by `{{name}}`.

## Scripts

`runScripts` runs Postman pre-request/test scripts in QuickJS inside a worker thread
(`scripts/`, bundled separately to `dist-electron/script-worker.cjs` by `scripts/build-main.mjs`; main
reads it as text and starts it with `eval: true` so it also works inside the asar). `ScriptService`
loads the environment, applies the environment writes the scripts made, serves secret reads on demand
through a synchronous `Atomics.wait` bridge, and keeps per-session secret values for history redaction.
`cancelHttpRequest(runId)` cancels a script run too. Design, limits and threat model:
[docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md#scripts-sandbox). Tests: `__tests__/scripts/` (the worker test
bundles the real worker with esbuild).

## IPC security

* `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; preload exposes only the
  channels in `IPC_CHANNELS`.
* Every handler rejects frames that are not the app's own origin (`app://slinger/` or the dev server).
* The renderer is served from a privileged `app://` scheme with a strict CSP
  (`default-src 'none'; script-src 'self'; ...`, see `lib/csp.ts`; it also allows Google Fonts stylesheets/fonts and inline styles), only `clipboard-sanitized-write` is permitted among permission requests, navigation away
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
