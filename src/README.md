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
  settings.svelte.ts        theme + accent (lib/appearance.ts) / font size / editor wrap / script time limit + continue-on-error (localStorage)
  toast.svelte.ts           toast store
components/
  ui/                       Button, IconButton, Icon(+icons.ts), Dialog (focus trap), ConfirmDialog,
                            NameDialog, ContextMenu, Tabs, SplitPane, ToastHost, InlineError, Spinner
  editor/                   CodeEditor (multi-line CM6), TemplateInput (single-line CM6),
                            cm/{theme,languages,template,sync,pmCompletion}.ts
  kv/KeyValueTable.svelte   params / headers / form-data / urlencoded tables
features/
  workspaces/  collections/ (tree, DnD, actions)  requests/ (tabs store, editor panels, send)
  response/    environments/ history/ runner/ importexport/ versions/ cloud/ (account, sign-in)
  sync/ (store, chip, publish/link flows, conflict center, read-only banner, tab notices)  settings/
  scripts/ (script editors, Tests/Console views, collection/folder Scripts dialog, session-only pm scopes)
lib/                        pure logic, no DOM: template, urlParams, kv, request (document model),
                            prepare (draft -> HttpRequestInput), scripts (Postman events, chain, scopes),
                            response, snippets, postman, tree,
                            semver, versionDiff, jsonTemplate, headers, autoHeaders, hex, exportFile, ipc,
                            themes (theme/accent registry), appearance (persisted theme settings), contrast + themeAudit (WCAG checks)
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

## Themes and accents

`styles/themes.css` is the only place colours live. Two attributes on `<html>` pick them:

* `data-theme='<id>'` selects a complete palette (31 themes, light and dark; registry in `lib/themes.ts`). Every theme block
  declares `color-scheme: light|dark` (native controls and scrollbars follow) and every token in `THEME_TOKENS`.
* `data-accent='<id>'` (absent = the theme's own accent) layers one of 18 accents over any theme. An accent block only sets
  raw colours per scheme (`--a-light`, `--a-light-fg`, `--a-light-text`, `--a-dark`, `--a-dark-fg`, `--a-dark-text`); the shared
  `[data-accent]` rule derives the accent tokens from them with `light-dark()` (so the theme's `color-scheme` picks the variant)
  and `color-mix()` against the theme's `--surface` / `--bg`. `[data-theme^='contrast'][data-accent]` pushes the accent towards
  the text colour so the high-contrast themes stay AAA.

Settings (`app/settings.svelte.ts`) apply both attributes; persisted as JSON in `localStorage['slinger.appearance']`
(`{ theme, accent, systemLight, systemDark }`, see `lib/appearance.ts`). `theme: 'system'` follows `prefers-color-scheme`
using the chosen `systemLight` / `systemDark` themes. The 0.2.0 key `slinger.theme` is migrated once and removed.
`public/theme-init.js` applies the same settings before first paint (keep it in step with `lib/appearance.ts`).
Components use tokens only: Tailwind classes (`bg-surface`, `text-fg`, `border-border`, `bg-accent text-accent-fg`,
`text-accent-text`, `ring-focus`, ...) map to the variables in `tailwind.config.js`; CodeMirror (`components/editor/cm/theme.ts`)
uses `var(--...)` so editors follow automatically.

Tokens (`THEME_TOKENS`):

| Group | Tokens |
| --- | --- |
| Surfaces / borders | `--bg --surface --surface-raised --surface-hover --border --border-strong` |
| Text | `--text --text-muted --text-faint` |
| Accent (replaced by a chosen accent) | `--accent` (fills, selected borders) `--accent-fg` (text on accent) `--accent-soft` (selected rows, badges; `--text` sits on it) `--accent-text` (accent-coloured text) `--focus-ring` `--selection` |
| Status | `--danger --danger-fg --danger-soft --success --success-soft --warning --warning-soft` |
| Templates | `--var-ok(-bg) --var-bad(-bg) --var-secret(-bg)` |
| Syntax | `--syn-keyword|string|number|bool|comment|property|tag|attr|punct` |
| HTTP methods | `--m-get|post|put|patch|delete|other` |
| Misc | `--overlay --shadow-pop --preview-bg` |

Contrast is enforced by `styles/themes.test.ts` (using `lib/themeAudit.ts` + `lib/contrast.ts`, which parse and evaluate
themes.css): for every theme x (theme default + 18 accents) it checks the pairs in `CHECKS` - text/muted/syntax/method/status
text 4.5:1 on the backgrounds they appear on, text on `--accent-soft`/`--selection`/status soft backgrounds 4.5:1,
`--accent-fg` on `--accent` 4.5:1, `--accent`/`--focus-ring` against `--bg`/`--surface` 3:1, `--text-faint` 3:1. High-contrast
themes use 7:1 (and 4.5:1 for the UI pairs). It also checks that each theme declares every token and `color-scheme`, that the
registry matches the CSS, that each accent's `-fg` is the better of light/dark ink, and that no component contains a literal colour
or an unknown `var(--token)`.

**Add a theme:** copy a block of the same scheme in `themes.css`, change the colours (keep all tokens), add
`{ id, label, scheme }` to `THEMES` in `lib/themes.ts`, run `npm run test:renderer` and fix any contrast failure it lists
(darken/lighten the failing colour; do not relax `CHECKS`). The gallery, quick-open commands and System pickers pick it up.

**Add an accent:** add a `[data-accent='<id>']` block with the six `--a-*` colours (light variant: dark enough for 3:1 on light
backgrounds; dark variant: bright enough for 3:1 on dark ones; `-fg` = `#ffffff` or `#10121a`, whichever contrasts more;
`-text` = same hue, adjusted until it reads at 4.5:1), add `{ id, label }` to `ACCENTS`, run the tests.

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
  and `settings.timeoutMs`. See `lib/request.ts`. Request scripts are the Postman `event` array under `scripts`; edit them
  with `lib/scripts.ts` `withScript` (returns the same array when nothing changed, so untouched documents stay byte-identical).
* Scripts run only in the main process (`runScripts`); `features/requests/execute.ts` is the one place that calls it (single send
  and runner). The browser mock does not execute scripts (it answers with a console note).
* Cloud tokens, HTTP and the sync engine live in the main process; the renderer only calls the account/sync IPC methods and subscribes to `onSyncEvent` (`features/sync/syncStore.svelte.ts`). Tokens never reach the renderer.
* Renderer-driven contract additions (`pickFile`, `writeExportFile(..., encoding)`, `historyUrl` on `HttpRequestInput`) are implemented in the main process.
* Cloud API URL and device name are stored by the main process (`getCloudConfig`/`setCloudConfig`). The old `localStorage` keys `slinger.cloud.config` and
  `slinger.cloud.links` are migrated/removed once on startup (`features/cloud/legacy.ts`); links only survive as a dismissible relink hint (`slinger.cloud.legacyHints`).
* Read-only workspaces: edit affordances read `sync.blocked` (`features/sync/syncStore.svelte.ts`); the main process still rejects writes with `read_only`.
* Browser dev mode: `window.__slingerMock.cloud` scripts the fake cloud (`approveSignIn()`, `scenario('conflicts' | 'readonly' | 'signedin')`, `setOffline()`,
  `expireAuth()`, `setRole()`, `remoteEdit()`, `injectConflict()`, ...); see `src/dev/mock/sync.ts`.
* Other `localStorage` keys: `slinger.appearance` (theme/accent), `slinger.fontSize`, `slinger.editorWrap`, `slinger.activeEnv.<workspaceId>`.
* Open request tabs are in memory only and are not restored on restart.
* Whole-app docs: [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md), [../docs/USER_GUIDE.md](../docs/USER_GUIDE.md).
