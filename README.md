# Slinger

A local-first desktop API client (in the spirit of Postman) built with Electron, Svelte 5 and TypeScript.
Your workspaces, collections, environments and history live in a SQLite file on your machine; secret values
live in the operating system keychain. There is no account requirement and nothing is synced anywhere unless
you opt into the (still minimal) cloud panel.

Small, fast, yours: read [the Sling Manifesto](#manifesto).

![Slinger main window: collection tree, request editor and a pretty-printed JSON response (Tokyo Night theme)](docs/screenshots/01-main.png)

## Screenshots

All shots are the real app with a fictional "Acme Store API" collection imported from Postman. Regenerate them with `npm run screenshots`.

| | |
|---|---|
| ![Variables](docs/screenshots/02-variables.png)<br>**`{{variables}}`** highlighted everywhere, with a masked secret in the hover card | ![Environments](docs/screenshots/03-environments.png)<br>**Environments** with secrets kept in your OS keychain |
| ![Form data](docs/screenshots/04-body-form-data.png)<br>**Every body type**, here multipart form-data with a file | ![HTML preview](docs/screenshots/05-html-preview.png)<br>**Response viewer** with a sandboxed HTML preview |
| ![Scripts](docs/screenshots/06-scripts.png)<br>**Pre-request and test scripts** with `pm.*` autocomplete | ![Tests](docs/screenshots/07-tests.png)<br>**Test results** for every send |
| ![Console](docs/screenshots/08-console.png)<br>**Console** with `pm.sendRequest` calls, secrets redacted | ![Runner](docs/screenshots/09-runner.png)<br>**Collection runner** with pass/fail counts |
| ![Loading](docs/screenshots/10-loading.png)<br>**Loading characters**: a runner, shuttle or slingshot pebble while you wait | ![Versions](docs/screenshots/11-versions.png)<br>**Semver collection versions** with a side-by-side diff |
| ![Import](docs/screenshots/12-import.png)<br>**Import** Slinger or Postman files, or just paste the JSON | ![Docs](docs/screenshots/13-docs.png)<br>**Markdown docs** for collections, folders and requests |
| ![Themes](docs/screenshots/14-settings-themes.png)<br>**31 themes and 18 accent colours** | ![Command palette](docs/screenshots/15-command-palette.png)<br>**Ctrl+K** to jump anywhere or switch themes |
| ![About](docs/screenshots/16-about.png)<br>**About Slinger** and the Sling Manifesto | ![Saved example](docs/screenshots/17-example.png)<br>**Saved examples**, kept from Postman |
| ![Code snippet](docs/screenshots/18-code-snippet.png)<br>**Code snippets**: cURL, fetch, axios, Python, Go and more | ![History](docs/screenshots/19-history.png)<br>**History** of every request you send |

## Features

- Workspaces, collections, nested folders and requests, with drag-and-drop ordering and a "Go to request" quick open.
- Request editor with query params, headers, body (none, form-data incl. files, x-www-form-urlencoded, raw with
  JSON/text/XML/HTML/JavaScript, binary), authorization (none, Basic, Bearer, API key in header or query), per-request timeout,
  description, and generated code snippets (cURL, fetch, axios, Python, Go, PHP, PowerShell).
- Multiple request tabs with dirty tracking, conflict detection (optimistic concurrency) and unsaved-changes prompts.
- Environments with `{{variables}}`, secret variables kept in the OS keychain, and built-in dynamic variables
  (`{{$guid}}`, `{{$timestamp}}`, ...). Variables are highlighted, hoverable and autocompleted in every input.
- Response viewer: Pretty / Raw / Preview (HTML, image, PDF, CSV table), headers, cookies, search, copy, save to file,
  hex preview for binary bodies.
- Pre-request and test scripts with a Postman-compatible `pm` API (`pm.environment`, `pm.variables`, `pm.request`,
  `pm.response`, `pm.test`, `pm.expect`, ...) at collection, folder and request level, run in a QuickJS (WebAssembly) sandbox in
  the main process with time, memory and output limits; Tests and Console tabs in the response area. Postman's built-in
  libraries work (`require('crypto-js')`, `lodash`/`_`, `moment`, `uuid`, `chai`, `ajv`, `tv4`, `xml2js`/`xml2Json`,
  `csv-parse/lib/sync`, `cheerio`). `pm.sendRequest` (callback and promise forms, e.g. a collection-level token fetch) runs
  through the app's own HTTP engine; scripts have no other network access.
- Collection runner (sequential, delay, stop on first failure) that runs the scripts, carries variables from one request to the
  next and reports test counts.
- Request history per workspace (every attempt is recorded, secrets are not).
- Collection versions: immutable semver snapshots (`1.4.0`, `2.0.0-beta.1`) with compare and restore (as a copy or replacing
  the live collection).
- Import Postman collections (including collection, folder and request scripts) and environments (v2.x), export collections as
  Postman v2.1 JSON.
- Five themes plus "follow the OS", adjustable font size, keyboard shortcuts.
- Cloud panel: device-code sign-in to a Slinger Cloud server, publishing/linking a workspace and collection sync
  ([docs/SYNC_DESIGN.md](docs/SYNC_DESIGN.md)).

## Requirements

- Node.js 20 or newer and npm (`engines.node >= 20` is declared; Electron 33 embeds Node 20 and the main bundle targets it).
- A working native toolchain is only needed if a prebuilt `better-sqlite3` / `@napi-rs/keyring` binary is unavailable for your platform.
- Linux: a Secret Service provider (GNOME Keyring, KWallet, ...) for secret variables and cloud tokens. Without one the app
  still runs; only secret operations fail with a clear error.

## Getting started

```bash
npm install
npm run electron:dev      # Vite dev server + Electron (rebuilds the main bundle on start)
```

`npm run dev` alone starts only the Vite renderer on http://localhost:5173 in a normal browser. Outside Electron the
renderer installs an in-memory mock backend (`src/dev/`), flagged "Mock backend" in the top bar; nothing is persisted.

### Commands

| Command | Purpose |
| --- | --- |
| `npm run electron:dev` | Development app (Vite on :5173, override with `SLINGER_VITE_PORT`) |
| `npm run dev` | Renderer only, mock backend |
| `npm run build` | Build renderer to `dist/` and bundle main/preload to `dist-electron/` |
| `npm run electron:build` | Build, rebuild native modules for Electron, run `electron-builder` (output in `release/`) |
| `npm test` | Vitest for main process (`electron/**`) then renderer (`src/**`) |
| `npm run test:e2e` | Build, then drive the real Electron app with Playwright + Vitest (`e2e/`) |
| `npm run screenshots` | Build, drive the real app against a local fictional API and write the README gallery to `docs/screenshots/` (fixtures in `docs/screenshots/fixtures/`; dev-only in-memory keychain, `SLINGER_INSECURE_TEST_KEYCHAIN=1`) |
| `npm run typecheck` | `tsc` for main and e2e, `svelte-check` for the renderer |
| `npm run rebuild:node` / `rebuild:electron` | Force the native `better-sqlite3` build for Node or Electron |

`better-sqlite3` is compiled for one ABI at a time; `scripts/ensure-native.mjs` switches automatically before `npm test`,
`electron:dev` and `electron:build`.

At the time of writing, `npm run typecheck` reports 0 errors and `npm test` passes 469 main-process tests
(26 files) and 710 renderer tests (55 files); the main e2e spec (`e2e/slinger.e2e.test.ts`) passes 38 steps.

## Where your data lives

The Electron user-data directory holds one file, `slinger.db` (SQLite, WAL mode):

| OS | Packaged app | Unpackaged dev (`electron:dev`) |
| --- | --- | --- |
| Linux | `~/.config/Slinger/` | `~/.config/Slinger/` |
| macOS | `~/Library/Application Support/Slinger/` | `~/Library/Application Support/Slinger/` |
| Windows | `%APPDATA%\Slinger\` | `%APPDATA%\Slinger\` |

Dev and packaged builds share this directory (`productName` is set in `package.json`); an older lowercase `slinger` dev directory is moved over once on first start. Set `SLINGER_USER_DATA_DIR` to use a different directory (used by tests). Theme, font size, wrap, the active environment per
workspace, cloud API URL/device name and cloud workspace links are stored in the renderer's `localStorage`
(inside the same Electron profile), not in the database.

Secrets never touch the database or `localStorage`: environment secret values and cloud tokens are stored in the OS keychain
(macOS Keychain, Windows Credential Manager, Linux Secret Service) under the service name `Slinger`. Deleting a secret
variable, its environment or its workspace removes the keychain entries. Collection versions and exports never contain
environments or secret values.

Exports (Postman JSON, saved response bodies) go to the folder you chose in the export dialog, otherwise `~/Downloads`
(falling back to your home directory).

## Themes

Light, Dark, Midnight, Solarized Dark, High Contrast, or System (follows the OS light/dark preference). Choose in
Settings (Ctrl+,). Themes are CSS variable palettes in `src/styles/themes.css`; see [src/README.md](src/README.md) to add one.

## Cloud

The Cloud button in the top bar opens a panel where you set an API base URL (default `https://api.slinger.app`) and a device
name, sign in with a device-code flow in your browser, list your cloud workspaces, and either link a local workspace to one or
"Publish" (creates an empty remote workspace with the local name and links it). Access and refresh tokens are kept in the
OS keychain. Requests to the cloud go through the same main-process HTTP executor as normal requests.

The server lives in a separate repository, `slinger-admin` (Slinger Cloud: Fastify + PostgreSQL API and an admin dashboard).
See its root `README.md` and `server/README.md` (OpenAPI in `server/openapi.yaml`).

## Packaging

`npm run electron:build` uses [electron-builder](https://www.electron.build/) with `electron-builder.yml`:
NSIS installer (Windows), DMG (macOS), AppImage and deb (Linux). Native modules are unpacked from the asar archive.
`install.sh` installs a built AppImage for the current user and creates a desktop launcher (Linux). No code signing or
auto-update is configured.

## Documentation

- [docs/USER_GUIDE.md](docs/USER_GUIDE.md) - how to use the app.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - process model, IPC contract, database, security, testing, how to extend.
- [electron/README.md](electron/README.md) - main process details. [src/README.md](src/README.md) - renderer details.
- [NOTES-FOR-FRONTEND.md](NOTES-FOR-FRONTEND.md) - behavior notes for code calling `window.slinger`.
- [docs/go-api-implementation-guide.md](docs/go-api-implementation-guide.md) - pointer to the cloud API documentation.

## Roadmap / not built

These do not exist in the code today: OAuth 2.0 as a request auth type (only Basic, Bearer and API key),
Node modules / `postman-collection` in scripts, cloud sync of collection- and folder-level scripts (request scripts do sync), persisted
`pm.collectionVariables` / `pm.globals` (session-only), realtime collaboration and plugins/extensions.
Only HTTP/HTTPS requests are supported (no WebSocket, GraphQL or gRPC clients).

## Manifesto

**The Sling Manifesto**

1. **A sling is small.** Carry less, hit harder. No account, no telemetry, ready in a blink.
2. **The stone is yours.** Your collections live on your machine. Sync is a choice, never a leash.
3. **Aim before you release.** Every request is visible, inspectable and repeatable. No magic.
4. **One stone, one target.** Do one thing well: send requests, read responses, prove they work.
5. **Giants fall.** You don't need a heavyweight platform to take on a heavyweight API.
6. **Anyone can pick up a sling.** Open source, MIT licensed, built in the open, yours to fork.
7. **Practice makes the throw.** Scripts, runners and versions help you repeat what works.
8. **Leave no trace you didn't choose.** Secrets stay in your OS keychain, never in history.

*Aim true. Travel light. Sling on.*

The same text is in the app (About Slinger, the question-mark icon in the top bar); it lives in
`src/features/about/credits.ts`, so keep the two in step.

## Contributing

Work on a branch, keep `npm run typecheck` and `npm test` green, and add tests next to the code you change
(`electron/__tests__/` for main, `*.test.ts` beside renderer code, `e2e/` for whole-app flows). Never edit a released SQL
migration; add the next numbered file. Adding an IPC method is a four-file change, described in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#adding-an-ipc-method-end-to-end).

## License

Released under the [MIT License](LICENSE). The open-source packages Slinger builds on are listed in the app (About Slinger,
Acknowledgements); `vite build` writes their licence texts to `dist/THIRD_PARTY_LICENSES.txt`, which packaged apps ship in their
resources folder.
