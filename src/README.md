# Slinger renderer (`src/`)

Svelte 5 (runes) + TypeScript (strict) + Vite + Tailwind + CodeMirror 6. The renderer talks to the
outside world **only** through `window.slinger`, typed by `shared/ipc-contract.ts` /
`shared/types.ts`. Outside Electron (plain `npm run dev` in a browser) `src/main.ts` installs the
in-memory mock backend from `src/dev/`.

## Commands

| Command                      | What it does                                             |
| ---------------------------- | -------------------------------------------------------- |
| `npm run dev`                | Vite dev server on :5173 (mock backend when not Electron) |
| `npm run build`              | Production build to `dist/`                              |
| `npm run typecheck:renderer` | `svelte-check` over `src/`, `shared/`, `test/`           |
| `npm run test:renderer`      | Vitest (jsdom), all `src/**/*.test.ts`                   |

## Layout

```
main.ts                     boot: install mock if no window.slinger, mount <App/>
app/                        shell + cross-feature state
  App.svelte TopBar Sidebar EmptyState shortcuts.ts
  state.svelte.ts           workspaces, collections/folders/requests, environments, active env
  ui.svelte.ts              which dialogs are open (one place, any feature can open any other)
  scope.svelte.ts           the {{variable}} scope every template input reads
  settings.svelte.ts        theme / font size / editor wrap (localStorage, applied to <html>)
  toast.svelte.ts           toast store
components/
  ui/                       Button, IconButton, Icon(+icons.ts), Dialog (focus trap), ConfirmDialog,
                            NameDialog, ContextMenu, Tabs, SplitPane, ToastHost, InlineError, Spinner
  editor/                   CodeEditor (multi-line CM6), TemplateInput (single-line CM6),
                            cm/{theme,languages,template,sync}.ts
  kv/KeyValueTable.svelte   params / headers / form-data / urlencoded tables
features/
  workspaces/  collections/ (tree, DnD, actions)  requests/ (tabs store, editor panels, send)
  response/    environments/ history/ runner/ importexport/ versions/ cloud/ (account, sign-in)
  sync/ (store, chip, publish/link flows, conflict center, read-only banner, tab notices)  settings/
lib/                        pure logic, no DOM: template, urlParams, kv, request (document model),
                            prepare (draft -> HttpRequestInput), response, snippets, postman, tree,
                            semver, versionDiff, jsonTemplate, headers, autoHeaders, hex, exportFile, ipc
dev/                        mockBackend.ts + mock/*: full in-memory SlingerIpcApi with seed data
styles/                     themes.css (tokens) + app.css (tailwind, CM overlays)
```

Rules of thumb: state lives in `*.svelte.ts` stores; components take data + callback props; anything
that can be pure goes in `lib/` with a colocated `*.test.ts`; every IPC call is wrapped in try/catch
(`guarded`/`errorInfo` from `lib/ipc.ts` or an inline error in a dialog that stays open on failure).

## Templates (`{{variables}}`)

One implementation everywhere: `lib/template.ts` (parse/resolve/status), `components/editor/cm/template.ts`
(CM extension: highlight, hover popover, autocomplete on `{{`, "create variable"), used by
`TemplateInput` (single line) and `CodeEditor templates` (bodies). The scope is the active
environment (`scopeStore`); secrets are only known by name and masked. `lib/prepare.ts` is the single
place templates are applied before sending (URL, headers, body, form fields, auth), fetching secret
values via `revealEnvironmentVariable` just-in-time (`features/requests/execute.ts`). Unresolved
variables abort the send with an inline list.

## Themes

`styles/themes.css` defines the palettes as CSS variables on `[data-theme='<id>']`; `<html data-theme>` selects
one (persisted in `localStorage['slinger.theme']`, `system` follows `prefers-color-scheme`). Components use
tokens only (Tailwind classes `bg-surface`, `text-fg`, `border-border`... map to the variables in
`tailwind.config.js`; CodeMirror themes use `var(--...)` so they follow automatically).

Token groups: surfaces `--bg --surface --surface-raised --surface-hover`, borders `--border --border-strong`, text
`--text --text-muted --text-faint`, semantic `--accent(-fg/-soft) --danger(-soft) --success(-soft) --warning(-soft)`,
template tokens `--var-ok(-bg) --var-bad(-bg) --var-secret(-bg)`, syntax `--syn-keyword|string|number|bool|comment|property|tag|attr|punct`,
HTTP methods `--m-get|post|put|patch|delete|other`, misc `--overlay --shadow-pop --selection --preview-bg`.

Add a theme: add a `[data-theme='name']` block (copy an existing one) in `themes.css`, then add `{ id, label }` to `lib/themes.ts`.

## Adding a feature

1. Create `features/<name>/` with a top-level component that renders nothing unless it is open
   (`{#if ui.<flag>}`), plus stores/logic next to it.
2. Add its open-flag to `app/ui.svelte.ts`, mount the component once in `app/App.svelte`, and open it from wherever
   (top bar, context menu, shortcut).
3. Call IPC through `api()`; show failures inline (dialogs) or with `toast.error`. Never close a dialog before the
   save succeeded.
4. Put pure logic in `lib/`, test it; component tests use `createMockBackend({ latencyMs: 0 })` as `window.slinger`
   (see any `*.test.ts` under `features/`). `window.__slingerMock.failNext(method, error)` injects failures.

## Data notes

* `ApiRequest.documentJson` keeps the Postman v2.1 item shape (headers[], body{mode}, auth{type}); unknown keys
  (scripts, responses, source, settings) are preserved on save. Our own additions: `params` (rows incl. disabled ones)
  and `settings.timeoutMs`. See `lib/request.ts`.
* Cloud tokens, HTTP and the sync engine live in the main process; the renderer only calls the account/sync IPC methods and subscribes to `onSyncEvent` (`features/sync/syncStore.svelte.ts`). Tokens never reach the renderer.
* Renderer-driven contract additions (`pickFile`, `writeExportFile(..., encoding)`, `historyUrl` on `HttpRequestInput`) are implemented in the main process.
* Cloud API URL and device name are stored by the main process (`getCloudConfig`/`setCloudConfig`). The old `localStorage` keys `slinger.cloud.config` and
  `slinger.cloud.links` are migrated/removed once on startup (`features/cloud/legacy.ts`); links only survive as a dismissible relink hint (`slinger.cloud.legacyHints`).
* Read-only workspaces: edit affordances read `sync.blocked` (`features/sync/syncStore.svelte.ts`); the main process still rejects writes with `read_only`.
* Browser dev mode: `window.__slingerMock.cloud` scripts the fake cloud (`approveSignIn()`, `scenario('conflicts' | 'readonly' | 'signedin')`, `setOffline()`,
  `expireAuth()`, `setRole()`, `remoteEdit()`, `injectConflict()`, ...); see `src/dev/mock/sync.ts`.
* Other `localStorage` keys: `slinger.theme`, `slinger.fontSize`, `slinger.editorWrap`, `slinger.activeEnv.<workspaceId>`.
* Open request tabs are in memory only and are not restored on restart.
* Whole-app docs: [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md), [../docs/USER_GUIDE.md](../docs/USER_GUIDE.md).
