# Slinger architecture

Slinger is an Electron 33 app: a Node main process that owns all I/O (SQLite, HTTP, keychain, files), a sandboxed preload
script, and a Svelte 5 renderer that can only reach the outside world through `window.slinger`.

## Directory map

```
electron/            main process (TypeScript, bundled by esbuild to dist-electron/main.cjs + preload.cjs)
  main.ts            lifecycle, single-instance lock, BrowserWindow, app:// protocol + CSP, session hardening, smoke test
  preload.ts         contextBridge: builds window.slinger from IPC_CHANNELS
  ipc/               handlers.ts (ipcMain.handle + sender check), api.ts (zod validation + dispatch), envelope.ts
  db/                database.ts (open + pragmas), migrate.ts (runner)
  migrations/        0001_init.sql, 0002_collection_versions.sql, 0003_integrity.sql
  repositories/      SQL per aggregate: workspaces, collections, tree (folders + requests), environments, history, common
  services/          core (wiring), httpExecutor, httpService, postmanImport, collectionVersions, semver, secrets,
                     exportFiles, externalUrl, authCallback
  lib/               errors, ids, text, csp, permissions
  __tests__/         vitest suites (plain Node, in-memory SQLite)
shared/              types.ts, ipc-contract.ts (the API), ipc-errors.ts - imported by main AND renderer, no Node/DOM deps
src/                 renderer (Svelte 5 runes, Tailwind, CodeMirror 6); see src/README.md
  app/  components/  features/  lib/  dev/  styles/
e2e/                 Playwright-driven tests of the built app (support/app.ts, support/server.ts)
scripts/             build-main.mjs, electron-dev.mjs, ensure-native.mjs
test/                renderer test setup
```

Only `main.ts`, `preload.ts` and `ipc/handlers.ts` import `electron`; everything else is plain Node so the whole business layer
is unit-tested without launching Electron.

## Process model and isolation

| Process | Runs | Capabilities |
| --- | --- | --- |
| Main | `electron/**` | SQLite, network (`fetch`), keychain, filesystem, dialogs, loopback listener |
| Preload | `electron/preload.ts` | Sandboxed; only `contextBridge.exposeInMainWorld('slinger', ...)` |
| Renderer | `src/**` | UI only; no Node, no direct network |

Window preferences: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`,
`allowRunningInsecureContent: false`. A single-instance lock focuses the existing window on a second launch.

**Renderer origin.** Production loads `app://slinger/index.html`. The `app` scheme is registered as privileged
(standard, secure, fetch-capable). Its handler serves files only from `dist/` (path traversal returns 403, missing files 404)
and adds `Content-Security-Policy` and `X-Content-Type-Options: nosniff`. In dev (`SLINGER_DEV_SERVER_URL` set by
`electron:dev`) the Vite server is loaded and the CSP is attached via `webRequest.onHeadersReceived`.

**CSP** (`electron/lib/csp.ts`): `default-src 'none'`; `script-src 'self'` (no inline or eval scripts);
`style-src 'self' 'unsafe-inline'` plus Google Fonts; `font-src 'self' data:` plus Google Fonts; `img-src 'self' data: blob:`;
`worker-src 'self' blob:`; `connect-src 'self'` (dev adds the Vite ws origin); `frame-src blob:`; `object-src 'none'`;
`base-uri 'none'`; `form-action 'none'`; `frame-ancestors 'none'`. The renderer therefore cannot fetch anything itself; all HTTP
goes through `executeHttpRequest`. HTML response previews are `<iframe sandbox="" srcdoc>` and PDF previews a `blob:` iframe.

**Other hardening.** Permission requests are denied except `clipboard-sanitized-write` from the app origin. `will-navigate` to
untrusted URLs is prevented; `window.open` is denied and http/https URLs are handed to the OS browser. Every IPC handler checks
`event.senderFrame.url` against the app origin (or the dev server) and otherwise answers `invalid_input`.

## IPC contract

`shared/ipc-contract.ts` is the single source of truth: the `SlingerIpcApi` interface and the `IPC_CHANNELS` array
(`satisfies readonly (keyof SlingerIpcApi)[]`). The channel name equals the method name. Currently 52 methods, grouped as
workspaces, environments (+ `revealEnvironmentVariable`), collections, folders, requests, history, HTTP
(`executeHttpRequest`, `cancelHttpRequest`, `cloudFetch`), Postman import / export files (`importPostmanCollection`, `defaultExportPath`,
`writeExportFile`, `chooseExportDirectory`), collection versions, secure store (`secureStoreGet/Set/Delete`),
`openExternalUrl`, browser-auth loopback (`prepareBrowserAuthCallback`, `waitForBrowserAuthCallback`), `getAppVersion`, `pickFile`, `grantedFiles`.
Types live in `shared/types.ts`; timestamps are Unix seconds; ids are UUID strings.

Call path:

```
renderer  window.slinger.x(...)               (src/lib/ipc.ts api() wraps it; mock backend when not in Electron)
preload   ipcRenderer.invoke('x', ...args)
main      handlers.ts   sender-frame check -> api[channel](...args) -> { ok: true, value }  |  { ok: false, error }
          api.ts        zod-parses every argument list (uuid, lengths, enums), asserts URLs/keys
          service / repository   validates again (UUID), runs SQL in transactions
preload   resolves value, or throws { name: 'IpcError', code, message, details? }
```

**Error transport.** `ipcMain.handle` rejections keep only the message text, and `contextBridge` strips custom properties from
`Error` objects. So handlers always resolve with an `IpcEnvelope` (`electron/ipc/envelope.ts`) and the preload throws a **plain
object** `{ name: 'IpcError', code, message, details? }`. It is not `instanceof Error`; renderer code uses `isIpcErrorPayload` /
`errorMessage` from `shared/ipc-errors.ts` (wrapped by `errorInfo` / `guarded` in `src/lib/ipc.ts`). Codes: `not_found`,
`version_conflict` (`details.expectedVersion/currentVersion`), `invalid_input` (e.g. `details.reason === 'duplicate_version'`,
`details.code === 'folder_cycle'`), `io_error`, `network_error` (`details.cancelled` / `details.timedOut`), `internal_error`.
Non-`IpcError` exceptions become `internal_error` with only the message (no stack) and are logged in main.

Behavior notes for callers are in `NOTES-FOR-FRONTEND.md` at the repository root.

## Database

`<userData>/slinger.db`, opened by `db/database.ts` with `journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000`.

**Migrations** (`db/migrate.ts`): files `electron/migrations/NNNN_name.sql` are applied in numeric order, each in its own
transaction, and recorded in `_migrations (id, name, checksum, applied_at)` where `checksum` is the SHA-256 of the file
(line endings normalized). Re-running applies nothing. Startup aborts if an applied file was edited, or if the database records
a migration the app does not ship (database newer than app). Never edit a released migration; add the next number. The build
copies `electron/migrations/**` into the package (`electron-builder.yml`).

| Migration | Adds |
| --- | --- |
| `0001_init` | `workspaces`, `collections`, `folders`, `requests` (`document_json`), `environments`, `environment_variables`, `history`, `cloud_links` (created but not used by any code) |
| `0002_collection_versions` | `collection_versions` (semver columns, `snapshot_json`, counts), unique index on `(collection_id, version)` among live rows |
| `0003_integrity` | unique live `(environment_id, key)`, sibling-order indexes, trigger `collection_versions_immutable` |

**Soft delete.** Workspaces, collections, folders, requests, environments, variables and collection versions carry
`deleted INTEGER`. Deleting sets `deleted = 1` (and bumps `version` / `updated_at`); every read filters `deleted = 0` and also
requires live parents. Cascades (workspace to everything, collection to folders/requests/versions, folder to descendants) run in
one transaction. Soft-deleted rows are never purged. `history` has no `deleted` column: rows are removed for real by
`clearHistory` / `deleteHistoryEntry`, and pruned to the newest 1000 per workspace (`HISTORY_LIMIT_PER_WORKSPACE`).

**Optimistic concurrency.** Every row has `version` (starts at 1, bumped on update, rename, move and soft delete).
`updateRequest` requires `expectedVersion` and fails with `version_conflict` (`details.currentVersion`) when it is not current.
The renderer (`tabs.svelte.ts`, `ConflictDialog`) lets the user reload or overwrite. Reordering siblings only rewrites
`sort_order`, not `version`, so it never causes false conflicts. `sortOrder` is per sibling group (folders among folders,
requests among requests); moving a folder into itself or a descendant is refused (`folder_cycle`).

**Request documents.** `requests.document_json` holds a Postman v2.1 item-shaped document (headers, body, auth, plus Slinger
additions `params` and `settings.timeoutMs`). The main process treats it as an opaque string; the renderer model is
`src/lib/request.ts`, and unknown keys (scripts, responses, source) are preserved on save.

## Secrets

- Store: `@napi-rs/keyring` (`KeychainSecretStore`, service `Slinger`). If the module or keychain is unavailable the app still
  starts; secret operations fail with `io_error` (`loadKeychain()` in `main.ts`).
- A secret environment variable has `value = NULL`, `is_secret = 1`, `secret_ref = 'slinger:env-var:<variable id>'` in SQLite; the
  value exists only in the keychain. List calls return `value: null, maskedValue: '••••••••'`. The only way to read one is
  `revealEnvironmentVariable(id)`. Upserting an existing variable with an empty `value` keeps the stored value.
- `secureStoreGet/Set/Delete` are a generic passthrough (used for cloud tokens, keys like `slinger.cloud.tokens:<baseUrl>`);
  the `slinger:env-var:` prefix is refused so it cannot bypass the mask.
- History never contains secret values: the renderer sends `historyUrl` (variables resolved except secrets, which stay as
  `{{name}}`, and without API-key query parameters); main stores it instead of `url`. Collection versions and exports contain no
  environments.

## HTTP execution pipeline

1. **Renderer, template resolution.** `src/lib/prepare.ts` `prepareRequest(draft, ctx)` is the *only* place `{{variable}}`
   substitution happens (single send, collection runner and code snippets all use it, via `features/requests/execute.ts`). It
   fails early on unresolved names, reveals just the secrets the request references through `revealEnvironmentVariable`
   immediately before sending, resolves values that reference other variables (bounded to 6 passes, so cycles end and are
   reported), generates built-ins (`$guid`, `$timestamp`, ...), drops disabled rows, and moves an API key with `addTo: 'query'`
   into the URL. It produces a resolved `HttpRequestInput` including `requestRunId` and `historyUrl`.
2. **Main, validation.** `api.ts` zod-validates the input; `HttpService.execute` checks `workspaceId` and `requestRunId`
   (`[A-Za-z0-9._:-]{1,128}`, not already in flight) and registers an `AbortController`.
3. **Main, build** (`httpExecutor.buildRequest`): rejects any remaining `{{ }}` in URL, header names/values, auth, body and
   enabled form rows (`invalid_input` with `details.location`); normalizes the URL (adds `http://`; only http/https); builds
   headers; applies auth server-side (Basic, Bearer, API key header/query); builds the body for `raw`, `urlEncoded`,
   `formData` (files read from absolute paths), `binary`; fills a default `Content-Type` only when not set; rejects a body on
   GET/HEAD.
4. **Main, fetch.** Node `fetch` with an abort signal; timeout defaults to 60 s and is clamped to 10 min; cancellation via
   `cancelHttpRequest(runId)` also works while the body streams. Timeouts and cancellations are `network_error` with
   `details.timedOut` / `details.cancelled`.
5. **Response.** Non-2xx statuses resolve normally. Body is `bodyText` when the bytes decode (declared charset, else UTF-8),
   otherwise `bodyBase64`; `bodyByteLength` is always set; `durationMs` includes the body download.
6. **History.** Every attempt (success, HTTP error, network failure, cancel, validation failure) is recorded by `HttpService`;
   a history write failure never hides the HTTP outcome.

The cloud HTTP client, sign-in, token refresh and the sync engine run in the main process (`docs/SYNC_DESIGN.md`); the renderer
never sees tokens and does not call `executeHttpRequest` or `cloudFetch` for cloud purposes. Only `executeHttpRequest` (the user's
own requests) writes history.

## Cloud sync (main process)

Design: `docs/SYNC_DESIGN.md` (section 20 lists where the code differs). Code: `electron/cloud/` (HTTP client with 30 s timeout and
no history, device-flow sign-in, single-flight token refresh with persist-before-use, typed API) and `electron/sync/`
(`SyncService` in `index.ts` implements the account/sync IPC methods; no Electron imports, clock/timers/fetch/emit injected).

- **Capture**: SQLite triggers from `0004_sync.sql` mark changed rows of linked workspaces in `sync_dirty` in the same statement;
  engine writes run with `sync_control.applying = 1` and are not captured. Read-only (viewer) links are enforced by triggers too
  (`read_only` IPC error). The last state both sides agreed on is `sync_entities.base_payload` (the 3-way merge base).
- **Cycle** (`engine.ts`, one per workspace at a time): register client (refuses servers below protocol v2), re-read the role,
  snapshot download for a new link, then up to 4 rounds of pull (apply pages in one transaction each; the checkpoint only advances
  with the applied page) -> build ops from the dirty set (`outbox.buildOps`: no-op elimination, limits quarantine, cascade pruning,
  dependency order, chunks <= 200 ops / 700 KB) -> push. Push rejections branch on the v2 `reason`
  (`version_mismatch` merges the returned `current_payload` and pushes again without a pull; `not_found` pulls the tombstone;
  `duplicate_key`, `immutable`, `invalid`/`too_large`, `id_in_use`, `read_only` as in design section 20).
- **Conflicts** are detected locally (`apply.ts`, per field group) and stored in `sync_conflicts`; a conflicted entity is frozen
  (not pushed) until resolved (`conflicts.ts`: keep local / keep remote / merge per group / duplicate).
- **Scheduling** (`scheduler.ts`): 5 s dirty poll + 1.5 s debounce, full cycle every 60 s focused / 5 min blurred, on start, focus,
  resume, online and manual sync; exponential backoff with jitter honouring `Retry-After`. Local edits are announced to the renderer
  as `status` events (also with auto sync off), applied remote changes as `applied` events.
- **Secrets** never leave the device: secret variables travel as metadata (`value: null`); a variable that arrives from another
  device is `secretMissing` until a value is set locally.
- **Tests**: `electron/__tests__/sync/` (units, an in-process fake server that implements the same wire contract as the real one
  (`wireContract.ts` runs against both), a two-device convergence fuzzer with a racing third writer) and
  `electron/__tests__/sync-it/` (the same engine against the real slinger-admin server + throwaway PostgreSQL:
  `SLINGER_SYNC_IT_SERVER_DIR=../slinger-admin/server npm run test:sync-it`). Real-app specs: `e2e/cloud.e2e.test.ts`,
  `e2e/sync.e2e.test.ts` (two profiles = two devices, gated by `SLINGER_E2E_CLOUD_URL`).

## Collection versioning

Versions are immutable snapshots stored inside the database, not git. `createCollectionVersion` serializes the collection's live
folders and requests (names, methods, URLs, `documentJson`, ordering; no environments) into `snapshot_json` and records the counts.
Semver is strict 2.0.0 (`services/semver.ts`): optional prerelease, no build metadata, no leading `v`, no leading zeros. A
version label is unique per collection among live rows (`invalid_input`, `reason: 'duplicate_version'`); a SQLite trigger
aborts any UPDATE other than the `deleted` flag. `listCollectionVersions` sorts newest first by semver precedence (parsed
major/minor/patch/prerelease columns), not by creation time. Restore modes: `copy` creates a new collection named
`"<name> (v<version>)"`; `replace` soft-deletes the live folders/requests and recreates the snapshot in one transaction with
**new ids** (the renderer refetches and closes affected tabs). Deleting a version soft-deletes it. Compare (`lib/versionDiff.ts`)
runs in the renderer on snapshots.

## Files, dialogs and the OS

Export writes take a **file name** only (`ExportFiles`): reduced to a basename, control/reserved characters replaced, Windows
device names rejected, max 200 chars, written inside the chosen (`chooseExportDirectory`) or default (Downloads, else home)
directory, refusing symlinks and directories, capped at 256 MB, base64 strictly validated. `openExternalUrl` accepts http/https
only. `pickFile` opens a native open dialog and returns an absolute path (used for form-data files and binary bodies); the main
process then adds that file's real path to an in-memory allowlist (`FileGrants`). `executeHttpRequest` reads a local file only
if its real path (symlinks and `..` resolved) is on the list, otherwise it fails with `invalid_input`; grants reset on restart, so
file fields saved in a request show "file not granted, choose again" in a new session (`grantedFiles` reports which paths are
granted).
`prepareBrowserAuthCallback` binds a one-shot `127.0.0.1` listener on a random port at `/auth/callback/<id>` (10 minute
maximum lifetime) and `waitForBrowserAuthCallback` resolves with the query parameters; it exists in the API but the current
cloud panel signs in with the device-code flow instead.

## Renderer

State lives in Svelte 5 rune stores (`*.svelte.ts`): `app/state` (workspaces, tree, environments, active environment),
`ui` (which dialogs are open), `scope` (the `{{variable}}` scope), `settings`, `toast`, and `features/requests/tabs.svelte.ts`
(open tabs, drafts, save/send). Pure logic is in `src/lib/` with colocated tests. Open tabs are not persisted across restarts.
Details: `src/README.md`.

**Cloud sync in the renderer** (`src/features/sync`, `src/features/cloud`). `sync/syncStore.svelte.ts` is one reactive wrapper over
the account/sync IPC methods plus a single `onSyncEvent` subscription (`status`, `applied`, `conflicts`, `auth`, `signInResult`);
nothing polls the main process (the only timer refreshes "synced 2 min ago" labels, and the pending count is re-read once,
debounced, after the user's own writes). Status/gating logic is pure (`sync/status.ts`: chip priority
accessRevoked > serverUnsupported > signedOut > conflicts > error > offline > syncing > readOnly > idle; `blockReason`), as are the
conflict view model (`conflictDiff.ts`, reusing `lib/versionDiff.ts` renderings; `conflictUi.ts`) and the open-tab rules
(`tabNotices.ts`). An `applied` event refetches collections/environments of the open workspace; a dirty open tab whose request
changed or vanished gets a non-destructive banner (`RequestTab.remoteNotice`) and is never overwritten. Edit affordances are gated
on `sync.blocked` (read-only role or access revoked) and every mutation still rejects with `read_only` from the main process, which
`errorInfo` maps to one friendly message. Request-content conflicts are compared by name/method/URL plus a fingerprint from the
contract's summary text, and field by field (headers, body, auth) when a group carries the optional `localDetail`/`remoteDetail`
texts. "Publish a copy" is done in the renderer (`sync/duplicateWorkspace.ts`) with the ordinary IPC methods. The browser mock
(`src/dev/mock/sync.ts`) simulates the cloud server and the engine (pull/merge/push, every conflict kind, roles, offline, expired
sign-in, old server) and is scriptable through `window.__slingerMock.cloud`.

**Saved examples** (`src/lib/examples.ts`, `src/features/examples`). Examples are stored inside the request document as
`responses`, which is Postman v2.1's item `response[]` verbatim, so the database, IPC, sync, collection versions and Postman
import/export need nothing new. Postman examples usually have no `id`, and adding one would change untouched data, so the
renderer addresses an example by index plus a JSON snapshot (`ExampleLocator`, re-found after other examples moved); examples
Slinger creates get a UUID `id`. Editing is byte-faithful: `serializeExample` starts from the stored object and replaces only the
fields whose parsed value changed. An example tab is a `RequestTab` with `example`/`exampleDraft` set; its Save rewrites that one
element of `responses` on top of the latest stored request (`updateRequest` with its `expectedVersion`, one retry on a stale
cache) and is a conflict only when that example changed or vanished. Tree/menu mutations (`examples/actions.ts`) go through the
same single `updateRequest`, and open request tabs of the parent are rebased so their next Save neither conflicts nor restores the
old list. Binary bodies saved from a live response are base64 with `_slinger_body_encoding: "base64"`.

**Theming tokens.** `src/styles/themes.css` defines each palette as CSS variables on `[data-theme='<id>']`; `<html data-theme>`
selects one (`light`, `dark`, `midnight`, `solarized`, `contrast`; `system` resolves to light or dark from
`prefers-color-scheme`). `public/theme-init.js` applies the stored theme before first paint. Components use tokens only (Tailwind
classes such as `bg-surface`, `text-fg` map to the variables in `tailwind.config.js`; CodeMirror themes use `var(--...)`).
Token groups: surfaces, borders, text, semantic (`accent`, `danger`, `success`, `warning`), template tokens, syntax colours, HTTP
method colours, misc (`overlay`, `shadow-pop`, `selection`, `preview-bg`). Preferences are stored in `localStorage`
(`slinger.theme`, `slinger.fontSize`, `slinger.editorWrap`, `slinger.activeEnv.<workspaceId>`; the old `slinger.cloud.config` /
`slinger.cloud.links` keys are migrated once and removed, `slinger.cloud.legacyHints` holds the dismissible relink hint).

## Testing strategy

| Layer | Tooling | Scope |
| --- | --- | --- |
| Main (`npm run test:main`) | Vitest, Node, in-memory SQLite, `MemorySecretStore`, real loopback HTTP servers | migrations, repositories, tree ordering, validation, HTTP executor, Postman import, versions/semver, secrets, export files, auth callback |
| Renderer (`npm run test:renderer`) | Vitest + jsdom + Testing Library, `createMockBackend({ latencyMs: 0 })` as `window.slinger` | pure `lib/*`, stores, dialogs and panels |
| Types | `tsc` (main, e2e), `svelte-check` (renderer) | `npm run typecheck` |
| End to end (`npm run test:e2e`) | Playwright (`playwright-core`) drives the built Electron app with an isolated `SLINGER_USER_DATA_DIR` and local target servers | full flows incl. runner and error paths; `screenshots.e2e.test.ts` captures screenshots |
| Smoke | `SLINGER_SMOKE_TEST=1 SLINGER_USER_DATA_DIR=<tmp> electron .` | headless check of preload, IPC, error transport, HTTP, keychain and CSP header; prints `SMOKE_RESULT {...}` |

`better-sqlite3` is built for one ABI at a time; `scripts/ensure-native.mjs` records the current target and switches
between Node (tests) and Electron (app). Env vars used by tooling: `SLINGER_USER_DATA_DIR`, `SLINGER_DEV_SERVER_URL`,
`SLINGER_VITE_PORT`, `SLINGER_SMOKE_TEST`, `SLINGER_HIDE_WINDOW` (off-screen rendering for automation).

## Adding an IPC method end to end

Example: `renameFoo(fooId, name)`.

1. **Types and contract** - add any new input/output types to `shared/types.ts`; add the method to `SlingerIpcApi` and its name
   to `IPC_CHANNELS` in `shared/ipc-contract.ts`. The `satisfies` clause and `SlingerIpcApi` make the compiler flag every
   implementation that is now incomplete (preload and handlers loop over `IPC_CHANNELS`, so they need no edit).
2. **Main logic** - implement it in a repository/service under `electron/`; throw `IpcError` helpers from `lib/errors.ts`; if it
   touches the schema, add a **new** numbered migration.
3. **Validation and dispatch** - add the method to `createIpcApi` in `electron/ipc/api.ts`, parsing every argument with zod
   (`uuid`, `name`, ...). It must be a member of the returned `SlingerIpcApi`.
4. **Renderer** - call it via `api().renameFoo(...)` from `src/lib/ipc.ts`; add it to the mock backend in `src/dev/mockBackend.ts`
   (+ `src/dev/mock/*`) so the browser dev mode and component tests keep working; show failures inline or with `toast.error`.
5. **Tests** - a main test in `electron/__tests__/`, a renderer/mock test, and an e2e step if it is a user-facing flow. Run
   `npm run typecheck && npm test`.

## Roadmap / not built

Not present in the code: OAuth 2.0 request auth, pre-request/test scripts (kept in imported documents, never executed), realtime
collaboration, plugin system, non-HTTP protocols, code signing and auto-update.
