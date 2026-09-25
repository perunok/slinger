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
  migrations/        0001_init.sql ... 0005_scripts.sql
  scripts/           script sandbox: prelude.js (the pm API, runs inside QuickJS), host.ts (state + dispatcher),
                     sandbox.ts (QuickJS runner), worker.ts (worker-thread entry), executor.ts (worker pool), inline.ts (tests),
                     libs/ (build-time Node shims for the bundled script libraries)
  repositories/      SQL per aggregate: workspaces, collections, tree (folders + requests), environments, history, common
  services/          core (wiring), httpExecutor, httpService, scriptService, postmanImport, collectionVersions, semver,
                     secrets, exportFiles, externalUrl, authCallback
  lib/               errors, ids, text, csp, permissions
  __tests__/         vitest suites (plain Node, in-memory SQLite)
shared/              types.ts, ipc-contract.ts (the API), ipc-errors.ts - imported by main AND renderer, no Node/DOM deps
src/                 renderer (Svelte 5 runes, Tailwind, CodeMirror 6); see src/README.md
  app/  components/  features/  lib/  dev/  styles/
e2e/                 Playwright-driven tests of the built app (support/app.ts, support/server.ts)
scripts/             build-main.mjs (main, preload and script-worker bundles), sandbox-libs.mjs (script libraries), electron-dev.mjs, ensure-native.mjs
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
(`satisfies readonly (keyof SlingerIpcApi)[]`). The channel name equals the method name. Currently 75 methods, grouped as
workspaces, environments (+ `revealEnvironmentVariable`), collections and folders (+ `setCollectionScripts`, `setFolderScripts`,
`setCollectionDescription`, `setFolderDescription`),
requests, history, HTTP (`executeHttpRequest`, `cancelHttpRequest`, `cloudFetch`), scripts (`runScripts`), Postman import / export files (`importPostmanCollection`, `defaultExportPath`,
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
| `0004_sync` | sync bookkeeping tables, change-capture and read-only triggers (see Cloud sync) |
| `0005_scripts` | nullable `scripts_json` on `collections` and `folders` (Postman `event` array as text; local-only, not synced), read-only triggers for it |
| `0006_descriptions` | nullable `description` + `description_type` on `collections` and `folders` (documentation; local-only, not synced), read-only triggers for them |

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
`src/lib/request.ts`, and unknown keys (scripts, responses, source) are preserved on save. Request scripts are the Postman `event`
array under the key `scripts` (the key the importer has always used, so existing and synced documents need no migration).

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

0. **Pre-request scripts** (only when the collection, a folder on the path or the request has one): `features/requests/execute.ts`
   calls `runScripts` with the chain and the draft; environment writes are persisted in main, request mutations are applied to an
   outgoing copy of the draft, and `pm.variables` / collection variables / globals are layered into the template scope
   (local > environment > collection > globals). See [Scripts sandbox](#scripts-sandbox).
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
   a history write failure never hides the HTTP outcome. Secret values that scripts of the send's `scriptSessionId` read or wrote
   are replaced by `{{name}}` in the recorded URL and error message (`ScriptService.redact`).
7. **Test scripts** run after the response (same run id), with `pm.request` resolved except secrets (`{{name}}`), and the
   response body (capped at 8 MB). Results go to the tab / runner row only; nothing about them is persisted.

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

## Scripts sandbox

Postman `event` scripts come from imported, i.e. untrusted, collections. They never run in the renderer and never in Node's `vm`
(not a security boundary). They run in the **main process, in a worker thread, inside QuickJS compiled to WebAssembly**
(`quickjs-emscripten-core` + the `@jitl/quickjs-singlefile-cjs-release-sync` variant, WASM inlined in the JS, so the bundle needs
no file loading and works from the asar; same code under vitest in plain Node).

**Flow.** `runScripts(input)` (zod-validated) -> `ScriptService.run` (`services/scriptService.ts`) loads the active environment
(`value: null` for secrets), reads the workspace's read-only flag (`cloud_links.read_only`), and hands a `ScriptJob` to the
`WorkerExecutor` (`scripts/executor.ts`, up to 4 workers, 1 kept warm; the worker bundle `dist-electron/script-worker.cjs` is read
as text and started with `eval: true`, `resourceLimits` 256 MB old space / 4 MB stack). The worker runs `runScriptChain`
(`scripts/sandbox.ts`), returns scopes, request mutations, console, tests, errors and a list of environment operations, and main
applies the operations with `EnvironmentRepository.setValueFromScript` / `unsetFromScript` (secrets stay secret, the value goes to
the keychain; coalesced to the last write per key). The IPC call resolves with a `RunScriptsResult`; script failures are data
(`errors[]`), never rejections.

**Isolation.**

- Each script of a chain gets a **fresh QuickJS runtime and context**: nothing a collection script defines or pollutes
  (`Object.prototype`, `pm` itself) is visible to the folder or request script. Shared state (variables, environment, request) lives
  on the host side.
- The context has only ECMAScript built-ins plus `prelude.js`: no module loader (code is evaluated as global code, `import` is a
  syntax error, dynamic `import()` fails), no `std`/`os` modules, no `process`, `fetch`, timers (stubs that throw), file system
  or network. `pm.sendRequest` throws "not supported". `require` only knows the built-in libraries below; any other name
  (`fs`, `crypto`, `path`, `node:*`, ...) throws an error listing the available modules.
- The **only bridge** is one host function `__slinger_call(op, argsJson) -> resultJson`: strings in, strings out. The prelude
  captures it in a closure and deletes the global before user code runs. The host (`scripts/host.ts`) parses with its own
  `JSON.parse`, type-checks and size-limits every argument, and keeps scopes in `Map`s, so script-chosen keys like `__proto__`
  never touch a host prototype (results are built with `Object.fromEntries`).
- **Limits** (per script, `scripts/job.ts` `DEFAULT_LIMITS`): wall-clock deadline (default 5 s, 100 ms-60 s, from Settings) and
  cancellation enforced by the QuickJS interrupt handler; 64 MB QuickJS heap; 256 KB QuickJS stack (below V8's native stack, so deep
  recursion is a catchable `InternalError: stack overflow` instead of aborting the WASM module); console 1000 entries / 512 KB per
  run, 10 000 characters per message (flooding stops calling the host); 1000 tests; 1 MB per variable value; response body 8 MB.
  A watchdog in the executor terminates a worker that does not answer within the sum of the deadlines + 5 s; a cancelled worker that
  does not stop within 2 s is terminated too. A runtime that was interrupted (timeout, cancel) is never freed: freeing one that was
  interrupted inside a promise job trips a QuickJS assertion that aborts the whole WASM module, so the module instance is dropped
  instead (V8 reclaims its memory) and the next script loads a fresh one (about 10 ms). Any other engine failure does the same.
- **Built-in libraries** (Postman parity: `crypto-js`, `lodash`, `moment`, `uuid`, `chai`, `tv4`, `ajv`, `xml2js`,
  `csv-parse/lib/sync`, `cheerio`; versions pinned in `package.json` devDependencies). `scripts/sandbox-libs.mjs` bundles each one
  with esbuild at build time (browser platform, ES2020, minified) into a `(function (module, exports) {...})` text; Node built-ins
  they touch are pure-JS packages (`events`, `buffer`) or the throwing/no-op shims in `scripts/libs/`. The texts reach
  `sandbox.ts` as the virtual module `virtual:sandbox-libs` (esbuild plugin for the worker bundle, Vite plugin for vitest) and are
  **only ever evaluated inside QuickJS**: a second host function `__slinger_lib(name)` returns the text (strings only, captured and
  deleted by the prelude like `__slinger_call`), and the prelude evaluates it in the script's own context on the first `require`
  of that name (cached per context, so a script that uses none pays nothing; each script of a chain loads its own copy). The
  globals `_`, `CryptoJS`, `tv4`, `cheerio` are lazy getters for the same modules, `xml2Json` uses xml2js with Postman's options,
  `atob`/`btoa` are the prelude's. QuickJS has no secure random source, so `crypto.getRandomValues` / `crypto.randomUUID` (used
  by crypto-js and uuid) call host ops `random` (at most 65536 bytes, Node `randomBytes`) and `randomUUID`. Libraries get no other
  capability: they run under the same deadline, heap and stack limits as the script (tested for loading and after loading).
  Cost (worker bundle +~0.9 MB of text; first `require` in a script, warm engine, median): crypto-js 16 ms, lodash 20, moment
  12, uuid 2, chai 10, tv4 4, ajv 23, xml2js 18, csv-parse 9, cheerio 51, all ten 151 ms; all ten fit in a 4 MB heap, so the
  64 MB limit is unchanged. `postman-collection` is not bundled (1.2 MB, mostly iconv-lite and faker; ~100 ms to load).
- **Cancellation.** `cancelHttpRequest(runId)` also cancels a script run with that id: main sets a flag in a `SharedArrayBuffer`
  that the interrupt handler polls; a script waiting for a keychain read is woken up. The renderer uses one run id for a whole send
  (pre-request -> HTTP -> tests), so Cancel and the runner's Stop work at every stage.

**Secrets (policy: Postman parity, read by explicit name only).** The job carries no secret values. When a script calls
`pm.environment.get(name)` (or `pm.variables.get`, or `replaceIn('{{name}}')`) for a secret, the worker makes a **synchronous**
request to main: it posts the variable id on a `MessagePort` and blocks in `Atomics.wait`; main checks the id belongs to the
job's environment, reads the keychain (`EnvironmentRepository.reveal`), posts the value and notifies; the worker takes it with
`receiveMessageOnPort`. So a secret leaves the keychain only when a script asks for it by name, `toObject()` omits secrets, and a
script that never asks causes no keychain read (tested). `set` on a secret keeps it secret. Main remembers the values a session's
scripts read or wrote (`ScriptService`, per `sessionId`, 1 h TTL, 500 sessions max) and `HttpService` redacts them from history.
Script console output travels only in the IPC result; main never logs script output or values; the renderer keeps it in memory.

**Read-only workspaces.** `pm.environment.set/unset` throw inside the script (a clear error that fails it); ScriptService refuses
to apply environment operations for a read-only workspace as a second line of defence; the 0005 triggers refuse
`setCollectionScripts` / `setFolderScripts`; the renderer disables the script editors.

**Threat model.** In scope: a malicious or buggy collection script trying to reach the file system, network, OS, Electron or
Node APIs, other scripts' state, or the host process (escape, prototype pollution, resource exhaustion: CPU, memory, stack,
output). Out of scope / accepted: a script can read non-secret environment values and any secret it names, and can put them into
the request it is attached to (that is what pre-request scripts are for; users should review untrusted collections); it can write
the active environment of a writable workspace. The bundled libraries are third-party code but get no more trust than a
script: they are evaluated inside the same QuickJS context, after the host functions were hidden. QuickJS itself is the trust anchor for memory safety (WASM confines a QuickJS bug
to the worker's linear memory; the worker can be terminated).

**Storage and sync.** Request scripts: `requests.document_json` key `scripts` (synced, versioned, exported). Collection/folder
scripts: `scripts_json` (0005), included in version snapshots (`collectionScriptsJson`, folder `scriptsJson`, optional so older
snapshots stay valid and snapshots without scripts keep the old JSON shape) and Postman import/export (`event`), but **not synced**:
the server's collection/folder schema has no such field (it would drop it), so the column is classified as local-only in the sync
drift guard (`electron/__tests__/sync/triggers.test.ts`). `pm.collectionVariables` and `pm.globals` are session-only in the
renderer (`features/scripts/sessionVars.ts`).

**Renderer side.** `src/lib/scripts.ts` (pure: Postman `event` editing that returns the same array when nothing changed, chain
assembly, request/response snapshots, scope layering, test counts), `features/requests/execute.ts` (the pipeline),
`features/scripts/` (editors with `pm` completion, Tests and Console views, collection/folder dialog, session scopes). The browser
mock's `runScripts` does not execute scripts (it returns the scopes unchanged with a console note).

## Collection versioning

Versions are immutable snapshots stored inside the database, not git. `createCollectionVersion` serializes the collection's live
folders and requests (names, methods, URLs, `documentJson`, ordering, collection/folder scripts; no environments) into `snapshot_json` and records the counts.
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

**Documentation rendering** (`src/components/markdown`, `src/lib/description.ts`). Descriptions are Markdown (GFM via `marked`)
rendered to HTML and sanitised by DOMPurify before `{@html}`; nothing else in the app injects author HTML.

- *Storage.* A request's description stays inside `document_json` (`description`, verbatim: a string or Postman's
  `{content, type}`); an untouched value is written back unchanged, an edited one as a string except that an object keeps its shape
  (so `text/plain` stays plain). Collections and folders have `description` (text) and `description_type` (NULL for the string form,
  else the object's MIME type) from migration 0006, set by `setCollectionDescription` / `setFolderDescription` (the type is kept
  while there is text), imported from `info.description` / folder `description`, exported back in the same shape, and captured in
  version snapshots (`collectionDescription(Type)`, folder `description(Type)`). **Sync:** the cloud protocol has no field for
  collection/folder descriptions (the server's collection and folder schemas carry only name/location/order), so, like
  `scripts_json`, the columns are local-only in v1: the 0004 change-capture triggers ignore them (schema-drift test classifies them
  as ignored) and the read-only triggers still refuse edits for viewers. Request descriptions sync as part of `document_json`.
- *Sanitiser policy* (`render.ts`). Allowlisted tags only: text formatting, headings, lists, tables, `blockquote`, `pre`/`code`,
  `details`/`summary`, `hr`, `br`, `img`, `a`, and `input` (forced to a disabled checkbox, for task lists). Allowed attributes: `href`,
  `src`, `alt`, `title`, table `align`/`colspan`/`rowspan`, list `start`/`reversed`, `open`, `width`/`height`, `checked`/`disabled`,
  `aria-label`/`aria-hidden`, our `data-anchor`, and `class` filtered to the classes the renderer itself emits (`md-*`, `tok-*`), so
  author HTML cannot reuse app utility classes to overlay the UI. Everything else goes: `script`, `style` (tag and attribute),
  `iframe`/`object`/`embed`, `form`/`button`, SVG and MathML, `meta`/`base`/`link`, `template`, event handlers, `id`/`name` (no DOM
  clobbering; heading anchors use `data-anchor`), other `data-*`, `srcset`, `target`. URLs must match
  `http(s):`, `mailto:`, `#fragment` or a scheme-less relative reference; `javascript:`, `vbscript:`, `data:` links, `file:` and
  custom schemes are removed.
- *Links.* The rendered view (`MarkdownView.svelte`) intercepts every click (and middle click/drag) on a link: `http(s)`/`mailto`
  go to `openExternalUrl` (main re-validates: http, https and mailto only), `#fragment` scrolls to the matching `data-anchor`
  inside the doc, anything else shows a note and does nothing. The app window is never navigated (the main process additionally
  denies `window.open` and untrusted navigation).
- *Images.* Only `data:image/*` sources render (CSP `img-src 'self' data: blob:`). Remote and relative images are never fetched:
  they become a placeholder with the alt text and, for http(s) URLs, an **Open image** link (to the system browser). A main-process
  image proxy was considered and rejected for v1: it would let any imported collection make the app issue network requests.
- *Code and variables.* Fenced code is highlighted statically with the CodeMirror Lezer parsers (JSON, JS/TS, XML, HTML, CSS) into
  `tok-*` classes coloured by the `--syn-*` tokens. `{{variables}}` in prose, inline code and code blocks become `md-var` tokens;
  docs never resolve variables, so no value (or secret) can appear.
- *UI.* `DocsEditor.svelte` (Preview default / Edit / Split with a CodeMirror Markdown editor; preview-only when `sync.blocked`) is
  used by the request Docs section and by collection/folder overview tabs (`features/overview/OverviewView.svelte`: a `RequestTab`
  with `overview` set; `overviewDraft` holds unsaved text, Save/Ctrl+S calls the description IPC method).

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
| Main (`npm run test:main`) | Vitest, Node, in-memory SQLite, `MemorySecretStore`, real loopback HTTP servers | migrations, repositories, tree ordering, validation, HTTP executor, Postman import, versions/semver, secrets, export files, auth callback, script sandbox (`__tests__/scripts`: limits, isolation, pm API table, built-in libraries, the esbuild-bundled worker, ScriptService) |
| Renderer (`npm run test:renderer`) | Vitest + jsdom + Testing Library, `createMockBackend({ latencyMs: 0 })` as `window.slinger` | pure `lib/*`, stores, dialogs and panels |
| Types | `tsc` (main, e2e), `svelte-check` (renderer) | `npm run typecheck` |
| End to end (`npm run test:e2e`) | Playwright (`playwright-core`) drives the built Electron app with an isolated `SLINGER_USER_DATA_DIR` and local target servers | full flows incl. runner and error paths; `screenshots.e2e.test.ts` captures screenshots |
| Smoke | `SLINGER_SMOKE_TEST=1 SLINGER_USER_DATA_DIR=<tmp> electron .` | headless check of preload, IPC, error transport, HTTP, keychain, CSP header and the script worker (a test script plus `require('crypto-js')` HMAC checked against Node); prints `SMOKE_RESULT {...}` |

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

Not present in the code: OAuth 2.0 request auth, `pm.sendRequest` and `require` of Node modules or `postman-collection` in scripts,
cloud sync of collection/folder scripts and collection/folder documentation, loading remote images in docs, persisted collection
variables and globals, realtime collaboration, plugin system, non-HTTP protocols, code signing and auto-update.
