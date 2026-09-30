# Slinger user guide

Slinger is a local-first API client. Everything is stored on your computer; nothing leaves it except the requests you send.
On Windows/Linux the shortcut modifier is Ctrl; on macOS Cmd works as well.

## Layout

- **Menu bar:** File, Edit, View, Help (plus the Slinger and Window menus on macOS); see [Menus](#menus).
- **Top bar:** workspace switcher, "Go to request" (Ctrl+K), environment switcher (with a gear to manage environments), the sync chip, Cloud,
  Right panel, Keyboard shortcuts, Settings, About Slinger (the question-mark icon).
- **Sidebar:** two tabs, **Collections** and **History**.
- **Main area:** request tabs, the request editor, and the response pane below it (or beside it, see below).
- **Status bar** (bottom, can be hidden): see [Status bar](#status-bar).
- **Right panel** (closed by default): see [Right panel](#right-panel).

### Status bar

The thin bar at the bottom of the window shows, from left to right:

- **Cloud sync** of the open workspace: *Local only*, *Synced*, *N pending*, *Offline*, *N conflicts*, *Sync error*, *Read-only*,
  *Signed out* and so on (the same state as the sync chip in the top bar). Click it to open the conflict center when there are
  conflicts, otherwise the Cloud dialog.
- **Environment:** the active environment (or *No environment*). Click it to open the Environments dialog.
- **Activity:** *Running <collection>… 3/10* while a collection run goes on (also in the background), *Run finished:
  <collection>* when one finished in the background; click it to open the run (with several runs, choose one from the list).
  *Sending…* while requests are in flight.
- On the right, for the active request tab, the **last response**: status (coloured like in the response pane), time and size;
  *Not sent* when the last send failed before a response.
- The **response position** button (same as the button on the divider, see below) and the **right panel** button.

Hide it with **Settings > Layout > Show status bar** or **View > Toggle Status Bar** (also in the command palette,
`> status bar`).

### Right panel

A panel on the right of the main area with more about the active request or example tab. Open or close it with the
panel icon in the top bar or at the right end of the status bar, **Ctrl+Alt+B** (Cmd+Option+B on macOS), **View > Toggle
Right Panel**, or the command palette (`> right panel`, which can also open it directly on one view). It has four views:

- **Variables:** every `{{variable}}` the request uses (URL, enabled headers, body, authorization) with its current value and
  where it comes from (environment, collection, globals, built-in). Secret values are masked; variables that are not defined
  anywhere are highlighted and have a **Create** button. Below: all variables in scope.
- **Docs:** the request's documentation, rendered. **Edit in Docs** switches the request to its Docs section (for an example,
  **Open request** opens the parent request).
- **Code:** the code snippet for the request (the same generator as the request's Code section), with a language picker and
  **Copy**.
- **Info:** name, method, URL, collection/folder, saved or unsaved, ID, created and updated times, version, and the workspace's
  sync state.

With no request tab active (or a collection overview), the views say so. Drag the panel's left edge to resize it (or focus
the edge and use Left/Right). Whether it is open, the view and the width are remembered. The panel only shows when the request
editor keeps a usable width next to it (about 500 px, 640 px with the response beside the request); in a narrower window it
hides until there is room again (the status bar icon turns amber), so widen the window or drag the sidebar narrower.

### Response below or beside the request

The response pane sits below the request editor by default. To put it side by side with the request, click the small
button at the right end of the divider between the two panes (when they are side by side, the button sits at the bottom
end of the vertical divider), press **Ctrl+Alt+V** (Cmd+Option+V on macOS), use **View > Toggle Response Position**, pick
**Layout: Response beside the request** in the command palette (Ctrl+K, `> layout`), or choose it under **Settings > Layout**.
The choice applies to every request and example tab and is remembered. Each layout remembers its own divider position, so
switching back and forth does not lose your preferred sizes. Dragging the divider (or focusing it and using the arrow keys)
still resizes the panes; the button itself never starts a drag.

## Workspaces

A workspace is the top-level container for collections, environments and history. Slinger creates one called "Personal" on
first launch. Open the workspace switcher in the top bar to switch, or open the Workspaces dialog to create, rename or delete
workspaces. Deleting a workspace removes its collections, requests, environments (and their keychain secrets) from view. If you
delete every workspace, "Personal" is recreated the next time you start the app.

## Collections, folders and requests

In the **Collections** sidebar:

- **New collection** (plus button), then right-click a collection for **Overview & docs**, **New request**, **New folder**,
  **Run collection...**, **Variables...**, **Scripts...**, **Versions...**, **Export as Postman JSON...**, **Rename**, **Delete**.
- Right-click a folder for **Overview & docs**, **New request**, **New subfolder**, **Run folder...**, **Scripts...**, **Rename**, **Delete**.
- Hovering a collection or folder shows an (i) button that also opens its overview (see [Documentation](#documentation-markdown)).
- Right-click a request for **Open**, **Duplicate**, **Rename**, **Delete**.
- Drag and drop to reorder or move folders and requests (a folder cannot be dropped into itself or its own subfolders).
- In the tree, F2 renames and Delete deletes the selected item. Deleting asks for confirmation and cannot be undone from the UI.

## Requests

Ctrl+T opens a new tab. The URL bar has the method selector, the URL, **Send** (Ctrl+Enter, becomes cancel while running) and
**Save** (Ctrl+S). Saving a request that is not in a collection yet asks where to put it ("Save as").

The editor sections are **Params**, **Authorization**, **Headers**, **Body**, **Scripts**, **Docs**, **Settings** and **Code**.

- **Params:** query parameters as a table; edits stay in sync with the URL. Disabled rows are kept but not sent.
- **Headers:** a key/value table. "Auto-generated headers" lists headers Slinger adds by itself (for example `Content-Type` from
  the body mode and `User-Agent: Slinger`); a header you set yourself wins.
- **Body:** `none`, `form-data` (text and file fields; pick files with the native dialog; a saved file must be chosen again after restarting the app: the field then shows "file not granted"), `x-www-form-urlencoded`, `raw`
  (JSON, XML, Text, HTML, JavaScript; **Beautify** formats JSON) and `binary` (send one file). GET and HEAD requests cannot have
  a body.
- **Authorization:** No Auth, Basic Auth, Bearer Token, API Key (added to a header or as a query parameter) or
  [OAuth 2.0](#oauth-20). Fields accept `{{variables}}`. Imported Postman requests with other auth types (for example Digest or
  AWS Signature) are sent without authorization and a warning says so.
- **Scripts:** the request's **Pre-request** and **Tests** scripts (JavaScript, Postman's `pm` API); see [Scripts](#scripts).
- **Docs:** the request's documentation in Markdown, stored with the request and exported to Postman as its `description`;
  see [Documentation](#documentation-markdown).
- **Settings:** per-request timeout in milliseconds (default 60 000, maximum 600 000).
- **Code:** generates a snippet for the current request in cURL, JavaScript (fetch), JavaScript (axios), Python (requests), Go
  (net/http), PHP (cURL) or PowerShell, with a Copy button. Unresolved variables are left as-is in snippets.

### OAuth 2.0

Choose **OAuth 2.0** in the Authorization section, pick a **grant type** and fill in the provider's settings (every field
accepts `{{variables}}`; put the client secret and passwords in secret variables):

| Grant type | Settings used |
| --- | --- |
| Authorization Code (With PKCE) (recommended for desktop apps) | Auth URL, Access Token URL, Client ID, Client Secret (optional for public clients), Scope, Redirect URI |
| Authorization Code | the same, without PKCE |
| Client Credentials | Access Token URL, Client ID, Client Secret, Scope |
| Password Credentials | Access Token URL, Client ID, Client Secret, Username, Password, Scope |

Click **Get New Access Token**. For the authorization code grants Slinger opens your system browser at the Auth URL; sign in
there, and the browser is redirected back to Slinger (the tab then says *Authorization received*). The panel shows *Waiting for
you to sign in in the browser…* meanwhile; **Cancel** stops waiting, and it gives up after 5 minutes. The other grants ask the
token endpoint directly. The status line then shows how long the token is valid, its scope and a masked preview; **Reveal**
shows the token itself, **Refresh** uses the refresh token, **Clear** deletes the token.

- **Redirect URI.** A desktop app can only receive the browser's redirect on your own computer, so the redirect URI must be a
  loopback address: `http://127.0.0.1:<port>/<path>` or `http://localhost:<port>/<path>`. When the field is empty Slinger uses
  **`http://127.0.0.1:47125/oauth2/callback`**. Register exactly the URI you use with the provider (most providers compare it
  character for character). Slinger listens on that port only while it waits for a sign-in; if another program uses the port you
  get a clear error. Postman's `https://oauth.pstmn.io/v1/callback` cannot work here: register a loopback URI instead.
- **State and PKCE.** Slinger sends a random `state` (unless you set one in *Advanced*) and rejects a redirect whose state does
  not match. With PKCE it generates a fresh code verifier for every sign-in (SHA-256 challenge by default; *Advanced* lets you
  choose `plain` or set a fixed verifier).
- **Advanced:** client authentication (*Send as Basic Auth header*, the default, or *Send client credentials in body*), add the
  token to the **request header** (`Authorization: <prefix> <token>`, prefix `Bearer` by default; an empty prefix sends the
  token alone) or as the `access_token` **query parameter**, State, Refresh Token URL (defaults to the Access Token URL),
  **Audience** and **Resource** (extra parameters some providers such as Auth0 or Azure AD need), and a token name (a label).
- **Sending.** A request with OAuth 2.0 uses the stored token. When it has expired, or expires within 30 seconds, and there is a
  refresh token, Slinger refreshes it automatically before sending; if that fails, or there is no token yet, the request is
  not sent and an inline error says to click **Get New Access Token**. Requests with the same settings share one token (for
  example every request of an imported collection whose collection-level auth was OAuth 2.0), per workspace. The collection
  runner behaves the same. Code snippets show `<access token>` in place of the token.
- **Where tokens live.** Tokens are stored only in your OS keychain (like secret variables), never in the request, history,
  exports, version snapshots or cloud sync; the settings (without any token) are saved with the request like other auth. If
  the keychain is not available, getting a token fails with a message and the rest of the app keeps working.
- **Not supported:** the implicit grant (deprecated; Slinger keeps imported settings and asks you to use Authorization Code
  (With PKCE)), and `pm.sendRequest` with OAuth 2.0 auth in scripts.

Tabs: right-click a tab for Close / Close others / Close all / Save. Ctrl+W closes, Ctrl+Tab and Ctrl+Shift+Tab cycle. A tab
with unsaved edits shows a marker, and closing it asks before discarding. If a saved request changed underneath you (for
example in another window), Save reports "Request changed elsewhere" and lets you **Reload from stored** or **Overwrite**.
Open tabs (including new, never-saved ones, and any unsaved edits) are restored per workspace the next time you start Slinger
or switch back to that workspace, unless you turn this off in Settings (see [Themes and settings](#themes-and-settings)); a
tab whose request, example, collection or folder was deleted meanwhile is simply not brought back, and if the request changed
underneath a restored unsaved edit, Save reports "Request changed elsewhere" exactly as above. Response panes are never
restored. **Go to request** (Ctrl+K) searches saved requests; type `>` to list commands such as switching the theme, accent or loading animation.

## Variables and environments

Use `{{name}}` in the URL, headers, params, body, form fields and auth. Recognized names are highlighted; hover for the value
(secrets show as bullets) and where it comes from (*Environment: Local*, *Collection: Payments*, *Globals*), type `{{` for
autocomplete, and unknown names offer to create the variable in the active environment, the request's collection or the
globals. A value can itself reference other variables. If anything is unresolved when you press Send, the request is not sent
and the response pane lists the missing names and the scopes that were checked ("Not defined in the environment "Local", the
collection "Payments" or the globals").

**Edit from the hover.** The hover of a defined variable has **Edit value** (**Set new value** for a secret). It opens a small
editor that stays open while you type: the stored value as written (references such as `{{region}}` stay unresolved), or an
empty password field for a secret, whose current value is never shown. **Enter** or **Save** writes it to the scope the value
comes from, the one named under it (the active environment, the request's collection or the globals), and every `{{}}` updates
right away; **Escape**, **Cancel** or clicking elsewhere closes it without saving. Built-in variables and script variables
(`pm.variables`) cannot be edited, and in a read-only (viewer) synced workspace the button is disabled.

**Scopes and precedence** (as in Postman, the narrowest wins):

| Scope | Where you edit it | Applies to | Secrets |
| --- | --- | --- | --- |
| Globals | Environments dialog, **Globals** (top of the list) | every request of the workspace | yes |
| Collection variables | the collection's overview, **Variables** section (or right-click the collection, **Variables...**) | requests of that collection | no |
| Environment | Environments dialog | every request, while the environment is active | yes |
| Iteration data | the runner's **Data file** (see [Collection runner](#collection-runner)) | one iteration of a data-driven run | no |
| Local | scripts only (`pm.variables.set`) | one send, or one collection run | no |

A name defined in several scopes takes the value of the narrowest one: local over iteration data over environment over collection
over globals.
Disabled collection variables and globals are kept but do not resolve (untick **On** in the table). Collection variables and
globals are saved on this device (they survive restarts) and, in a workspace linked to the cloud, synced like the rest of it (secret
globals: only the name travels, see "What syncs" under Cloud account and sync); in a read-only (viewer) synced workspace they cannot
be changed, except for setting a secret global's value on this device.

**Collection variables.** They belong to the collection: imported from and exported to a Postman collection's `variable` list,
included in version snapshots and restored with them. Because they travel with the collection file, they are never secret; put
tokens and passwords in an environment or in the globals. The table works like the environment table (autosave, bulk edit); in
bulk edit the order of the lines becomes the order of the variables, and disabled variables are edited in the table.

**Globals.** Workspace-wide variables with the same table as environments, including **Secret** (stored in the keychain, masked,
revealed on request) and **On**. They are not part of any collection export; import a Postman globals file to fill them.

**Environments.** Click the gear next to the environment switcher (or use the switcher) to open the Environments dialog: create,
rename, duplicate and delete environments, **Set active**, and edit variables in a table (or **bulk edit** as text). Changes
save automatically with a status indicator. The active environment is remembered per workspace. Variable names are unique
within an environment, and environment names are unique within a workspace (ignoring case and surrounding spaces; renaming
an environment to its own name in a different case is fine). The create/rename dialog flags a taken name as you type. Only
sync can bring two same-named environments into one workspace (for example when two devices created one offline); rename or
delete one of them.

**Secret variables.** Tick **Secret** on a variable to store its value in your operating system keychain instead of the
database. The table then shows masked bullets; use the reveal control to look at it, and leave the value empty when editing to
keep the stored one. Secrets are never written to history, collection exports or version snapshots, and an environment export
contains them only if you tick **Include secret values** (see below). If no keychain is available (typical on
headless Linux without a Secret Service) saving a secret fails with an error while everything else keeps working.

**Built-in dynamic variables** (generated fresh at each send, same value wherever repeated within one send):
`{{$guid}}` and `{{$randomUUID}}` (UUID v4), `{{$timestamp}}` (Unix seconds), `{{$isoTimestamp}}`, `{{$date}}` (UTC),
`{{$time}}` (UTC), `{{$randomInt}}` (0-999999), `{{$randomString}}`, `{{$randomBoolean}}`, `{{$randomEmail}}`.

## Reading the response

While a request is in flight the pane shows a small animated character running back and forth along a track (see **Loading
animation** in Settings), "Sending request…" with the elapsed time, and **Cancel**. When the response arrives it is shown at
once; the character plays a short finish on top (under half a second): the runner cheers, the shuttle lands, the pebble hits
its target. On an error (no response, or a 4xx/5xx status) it stumbles in the error colour; on Cancel it simply disappears.

After Send the pane shows status, time and size. Views: **Pretty** (formatted, foldable JSON/XML/HTML; CSV as a table), **Raw**
(hex preview for binary content), **Preview** (HTML in a fully sandboxed frame, images, PDF), **Headers** and **Cookies**
(parsed from `Set-Cookie`). Toolbar: search in response, toggle word wrap, copy body, **Save response to file** (to the export
folder). Non-2xx responses are shown normally; network errors, timeouts and cancellations appear as inline errors.

When the request (or its folder or collection) has scripts, two more views appear: **Tests** (every `pm.test` with pass/fail/skip,
the assertion message of failures, script errors, a filter, and a `passed/total` badge on the tab that turns red when something
failed) and **Console** (`console.log/info/warn/error` output with level, time and which script printed it; **Clear** empties it).
Both belong to the last send and are kept in memory only: they are not saved, not written to history and gone after a restart.

## Saved examples

A saved example is a request/response pair kept with a request, like Postman's "examples": documentation of what an endpoint
returns, a fixture to compare against, or a response you want to keep.

- **In the tree:** a request with examples shows a count badge and a chevron. Click the chevron (or press **→** / **←** on the
  row) to show or hide its examples; clicking the request itself still opens the request. Each example row shows the saved status
  code. Right-click an example for **Open**, **Duplicate**, **Rename** (**F2**) and **Delete** (**Del**, asks first). Right-click a
  request for **Add example** (an empty 200 example based on the stored request). Deleting a request deletes its examples and the
  confirmation says how many.
- **Example tab:** opening an example shows its saved request on top (method, URL, params, authorization, headers, body) and its
  saved response below: status code and text, body language, and the normal response viewer (Pretty/Raw/Preview/Headers/Cookies),
  plus **Edit body** and **Edit headers**. Everything is editable; the tab shows the unsaved dot and **Save** (**Ctrl+S**) writes
  the example back into its request. Examples imported without a saved request of their own show the request they belong to
  (marked "request from parent"); editing that part stores a copy in the example.
- **Saving** only changes that one example. Edits made meanwhile to the request or to its other examples (in another tab, or
  pulled by sync) are kept. If this example itself was changed or deleted elsewhere, Save asks: **Reload** (discard your edits),
  **Overwrite** (write yours, re-adding a deleted example) or **Cancel**. Closing a tab with unsaved edits asks first, as for
  requests.
- **Try** (**Ctrl+Enter**) sends the example's request from a new, unsaved request tab. The example is not changed.
- **Save as example:** after a Send, the response toolbar has **Save as example** (default name: status and reason, e.g.
  `201 Created`). It stores the response (status, headers, body, time) with the request as it is in the tab, variables left as
  `{{name}}`. Unsaved edits to the request itself are not saved by this; save the request first if you need to (a new, never
  saved tab cannot keep examples). Binary bodies (images, PDFs, ...) are stored as base64 with a Slinger marker
  (`_slinger_body_encoding`) and shown as the original bytes again; Postman shows the base64 text. A binary body above about
  3.5 MB (5 million base64 characters) keeps a short note instead of the bytes; a text body above 5 million characters is
  refused.
- **Where they live:** examples are part of the request, so collection versions, cloud sync and Postman export carry them. A
  request with its examples can hold at most 10 MB locally; cloud sync accepts about 900 KB per request, so keep large bodies out
  of synced examples. In a workspace linked to cloud sync, the request editor warns right in the tab once a request's saved
  examples and response bodies push it over that 900 KB limit, since an oversized one is skipped by sync instead of blocked -
  remove or shrink examples to bring it back under the cap. Read-only (viewer) workspaces can open examples but not change them.

## Collection runner

Right-click a collection or folder and choose **Run collection...** / **Run folder...**. Pick which requests to run, set the delay
between requests (ms) and optionally **Stop on first failure**, then run. Requests run sequentially in tree order using the active
environment; each row shows status, time and, expanded, headers and a body preview. A row passes on a 2xx status only (redirects are followed first, so a remaining 3xx means the redirect did not end in a 2xx); 3xx, 4xx, 5xx and
network errors fail, unless you tick **Treat 3xx as pass**; requests with unresolved variables are skipped with the reason. You can stop a running run.
While the run is going, a small version of the loading character runs along the progress bar.
Runner requests are recorded in History.

**Running in the background.** A run does not have to hold up the app. Start it with **Run in background** instead of
**Run N requests**, or press **Run in background** (or close the dialog) while it runs: the dialog closes and the run goes on
while you keep working, including sending other requests. The status bar shows *Running <collection>… 3/10*; click it to open
the run again with its live progress. When a run finishes in the background, a notification says how it went (*8 passed,
2 failed*) with **View results**, and the status bar keeps *Run finished: <collection>* until you open them. Several collections
can run at the same time; with more than one, clicking the status bar lists them. Closing the dialog of a finished run discards
its results, as before; **Stop** stops a run at any time.

A run keeps the environment it started with (shown under the progress bar), so you can switch environments while it runs
without affecting it; scripts that write with `pm.environment.set` also write to that environment. A run needs the workspace it
started in: switching workspaces asks first and then stops the runs of the workspace you leave.

**Iterations and data files.** **Iterations** runs the whole selection that many times (1 to 10000). **Data file** makes a
data-driven run: choose a **CSV** (the first line names the columns, each further line is one iteration) or a **JSON** array of
objects (one object per iteration). The dialog shows the file's row and column counts and a preview of its first rows, and sets
**Iterations** to the number of rows (you can lower it to run only the first rows). In iteration *n*, each column of row *n* is a
variable: `{{customerName}}` in a URL, header or body is that row's value, scripts read it with `pm.iterationData.get('customerName')`
(also `pm.variables.get`, and the old `data` object), and `pm.info.iteration` / `pm.info.iterationCount` say which iteration is
running. Row values override the environment, collection variables and globals, while a value set with `pm.variables.set` still
overrides them (Postman's order); variables set by scripts carry over from one iteration to the next. CSV values are text (quoted
values may contain commas, `""` and line breaks); JSON values keep their types, and objects or arrays read as JSON text in
`{{}}`. Files are limited to 10000 rows and 5 MB; the dialog names the line of a malformed row.

Results of a run with several iterations are grouped: *Iteration 2 · customerName: Globex · 4 passed, 1 failed*; expand one to see
its requests (the first 100 iterations are listed, **Show 100 more** adds more). The progress, the status bar (*Running
Drive Automation… iteration 37/200*) and the summary count iterations, and **Export results as JSON** records each result's
iteration and the data rows that ran. **Stop on first failure** stops the whole run. In a run of more than 1000 requests, headers
and body previews are kept only for failed requests, so large runs do not fill the memory. Reopening a data-driven run keeps its
data file and iteration count for **Configure** and **Run again**.

Scripts run for every request exactly as for **Send** (collection, folder and request scripts). A failing test fails its row
("1 of 3 tests failed"); a failing pre-request script fails the row without sending it. Values set with `pm.variables.set` live for
the whole run, and `pm.environment.set` writes to the run's environment, so the classic *login -> save token -> next request uses
`{{token}}`* flow works. The summary adds test counts (`Tests: 4 passed, 1 failed`), expanded rows list each test and the console
output, and **Export results as JSON** includes the tests. **Stop** also interrupts a running script.

`pm.execution.setNextRequest(nameOrId)` (or the older `postman.setNextRequest`) changes what runs next, as in Postman: after the
current request (and its test scripts), the run continues at the named request (matched by id, else by the first request with that
name) and goes on in tree order from there. Only requests picked for the run can be targets; requests jumped over are listed as
skipped, and jumping back runs requests again (a loop ends when a script stops calling it, or after 10000 requests).
`setNextRequest(null)` ends the run, and so does a name that matches no request of the run. With several iterations, jumps stay
within the current iteration, and `null` or an unknown name ends that iteration: the next one starts as usual. The last call of a send wins, whether
it came from a pre-request or a test script. A single **Send** ignores it.

## Scripts

Slinger runs Postman-style JavaScript **pre-request scripts** (before a request is sent) and **test scripts** (after its
response arrives), using a Postman-compatible subset of the `pm` API. Scripts imported from Postman run unchanged as long as they
stay within that subset.

**Where scripts live.** Every request has them in its **Scripts** section (sub-tabs **Pre-request** and **Tests**). Collections and
folders have them too: right-click, **Scripts...**. The editors are JavaScript with autocomplete for `pm.` members and snippets
(type `test`, `status`, `setenv`, `getenv`, `header`, `setvar`, `jsonprop`, `responsetime`). Request scripts are saved with the
request (Save); collection and folder scripts are saved in their dialog.

**Order.** For each send: collection pre-request -> folder pre-request scripts from the outermost folder to the innermost ->
request pre-request -> *templates are resolved and the request is sent* -> collection tests -> folder tests (outer to inner) ->
request tests. Because pre-request scripts run before `{{templates}}` are resolved, variables they set are used in the request.

**Errors and limits.**

- A pre-request script that throws (or times out) stops the send: the response pane says which script failed, with the error and
  its line, and the console output is shown. Turn on *Send the request even when a pre-request script fails* in Settings to send
  anyway (the remaining pre-request scripts then still run).
- A test script that throws counts as a failed test; the other test scripts still run.
- Each script has a time limit (default 5 s, Settings), 64 MB of memory and a limited stack; **Cancel** (and **Stop** in the
  runner) interrupts a running script and aborts its `pm.sendRequest` calls. Time spent waiting for `pm.sendRequest` responses does
  not count against the time limit (see below). Console output is capped at 1000 messages / 512 KB per send, a single message at 10 000
  characters, and 1000 tests; a response body larger than 8 MB is cut to its first 8 MB for `pm.response`.
- Scripts run in an isolated sandbox (see "Security" below): no network of their own (only `pm.sendRequest`, which the app runs
  for them, see below), **no files**, no Node modules and no `import` (only Postman's built-in libraries, see below), no timers
  (`setTimeout`/`setInterval` throw), no access to the app or the operating system. Promises work (async `pm.test` callbacks are
  awaited while the script runs), and so does top-level `await`.

**`pm.sendRequest`.** Scripts can send HTTP requests of their own, typically a collection-level pre-request script that fetches
a token:

```js
pm.sendRequest({
  url: pm.environment.get('authUrl'),
  method: 'POST',
  header: { 'Content-Type': 'application/json' },
  body: { mode: 'raw', raw: JSON.stringify({ client_id: pm.environment.get('clientId'), client_secret: pm.environment.get('clientSecret') }) },
}, (err, res) => {
  if (err) throw err
  pm.environment.set('token', res.json().access_token)
})
// or: const res = await pm.sendRequest(pm.environment.get('baseUrl') + '/health')
```

- **Forms.** `pm.sendRequest(url, callback)` or `pm.sendRequest(request, callback)`; it also returns a promise
  (`await pm.sendRequest(...)`, `.then()`, `Promise.all([...])`). The callback gets `(err, res)`: `err` is an `Error` only for
  network failures, timeouts and invalid requests (then `res` is `null` and the promise rejects); an HTTP 4xx/5xx is a normal
  response (`err` is `null`), as in Postman.
- **Request object.** `url` (string, or Postman's URL object), `method` (default `GET`), `header` (a list of `{ key, value }`, an
  object `{ name: value }` or `"Name: value"` lines; `disabled` entries are skipped), `body` with `mode` `raw` (`raw`, and
  `options.raw.language` `json`/`xml`/`html`/`javascript`/`text` sets the Content-Type unless you set one), `urlencoded`
  (`[{ key, value }]`), `formdata` (`[{ key, value }]`, or `{ key, type: 'file', src: '/path' }`), `file` (`{ src }`) or
  `graphql` (`{ query, variables }`), `auth` (`bearer`, `basic` or `apikey`, in Postman's format; `oauth2` is refused because
  scripts never get OAuth 2.0 tokens), and `timeout` in ms.
- **Response.** `res.code`, `res.status` (reason text), `res.headers.get/has/toObject/each`, `res.text()`, `res.json()`,
  `res.responseTime`, `res.responseSize`, `res.cookies.get/has/toObject`, and the same `pm.expect(res).to.have.status(200)`
  assertions as `pm.response`. Bodies over 8 MB are cut to the first 8 MB.
- **Variables.** Like Postman, `{{name}}` in the URL, headers, auth and body of a `pm.sendRequest` is resolved from the current
  variables (local, environment, collection, globals), so `url: '{{baseUrl}}/token'` works; `pm.environment.get(...)` and
  `pm.variables.replaceIn(...)` work too. An unresolved `{{name}}` fails that request with an error naming it.
- **When it runs.** Requests from one script run in parallel. The script (and so the main request) waits until every
  `pm.sendRequest` it started has answered and its callbacks ran, including requests started from callbacks.
- **Limits.** At most 20 `pm.sendRequest` calls per script run; only `http`/`https` URLs (a URL without a scheme gets `http://`,
  like the main request). Each call times out after the request's own timeout (its Settings tab), 60 s by default, at most 120 s;
  a call's `timeout` can only lower that. Waiting for responses does not use the script's time limit, but a script is stopped if it
  is still waiting after its time limit + 20 × the request timeout (5 minutes at most). Redirects are followed.
- **Files.** A form-data file field or a `file` body may only use files you chose with the file picker in this session (like the
  request editor); any other path is refused.
- **Privacy.** These requests are **not recorded in history** (as in Postman). Each one adds one line to the Console,
  `→ POST https://auth.example.com/token 200 (123 ms)`, with secret values replaced by `{{name}}` and `user:password@` masked;
  headers and bodies are never logged.
- `pm.sendRequest` also works in read-only (viewer) synced workspaces: it changes nothing locally.

**Variables.**

| Scope | API | Lifetime in Slinger |
| --- | --- | --- |
| Local | `pm.variables.set/get` | one send; in the collection runner, the whole run |
| Environment | `pm.environment.*` | the active environment; `set`/`unset` are saved immediately |
| Collection | `pm.collectionVariables.*` | the request's collection; `set`/`unset`/`clear` are saved immediately |
| Global | `pm.globals.*` | the workspace's globals; `set`/`unset`/`clear` are saved immediately |

`pm.variables.get(name)` and `{{name}}` in requests resolve with Postman's precedence: local, then environment, then collection
variables, then globals. Stored values are text (numbers and objects are saved as JSON text); within one send a value keeps the
JSON type the script set. Scripts only see enabled variables; `set` on a disabled variable enables it, `clear()` removes every
variable of that scope. Without an active environment, `pm.environment.set` lasts for the one send and a console warning says so;
likewise `pm.collectionVariables.set` for a request that is not saved in a collection. In a **read-only (viewer) synced
workspace** `set/unset/clear` of the environment, collection variables and globals throw ("this workspace is read-only"), which
fails the script; reading still works, and the script editors are read-only. Variables that only scripts define are shown as
unresolved in the editors until a script has run, but they resolve at send time.

**Secret variables and scripts.** A script can read a secret environment variable or secret global, but only by asking for it by
name: `pm.environment.get('token')`, `pm.globals.get('token')`, `pm.variables.get('token')` or `replaceIn('{{token}}')`. Secrets
are left out of `toObject()`, and the value is fetched from the keychain only when a script asks. `set` on a secret keeps it
secret (the new value goes to the keychain). Test scripts see `pm.request` with secret variables still written as
`{{name}}`. Anything a script prints with `console.log` appears in the Console tab (in memory only; never in history, logs or files),
so avoid printing secrets. History never stores a secret a script read or wrote: it is replaced by `{{name}}` in the recorded URL,
even if the script put it into the URL. Copying a secret into a *non-secret* variable (`pm.environment.set('plain', secret)`)
stores it as plain text, like typing it there would.

**Request changes.** In pre-request scripts `pm.request` is editable: `pm.request.url` (assign a string, or `update()`,
`query.add/upsert/remove`), `pm.request.method`, `pm.request.headers.add/upsert/remove`, `pm.request.body.update()` (sets a raw
body; objects become JSON). Changes apply to **this send only**: the saved request and the editor are not changed.

**API reference** (Postman-compatible names; anything not listed is not available):

| API | Notes |
| --- | --- |
| `pm.environment.get/set/unset/has/toObject/clear/replaceIn`, `.name` | active environment; secrets as described above |
| `pm.variables.get/set/has/unset/toObject/replaceIn` | `get`/`has`/`toObject` look through all scopes |
| `pm.collectionVariables.*`, `pm.globals.*` | same methods (plus `clear`); saved, see above |
| `pm.iterationData.get/has/toObject`, legacy `data` | the current row of a data-driven collection run (read-only); empty otherwise |
| `pm.request.url`, `.method`, `.headers`, `.body`, `.name`, `.id` | editable in pre-request scripts |
| `pm.request.auth.type`, `.parameters().get(key)`, `.toJSON()` | read-only; the request's auth settings with `{{variables}}` unresolved, typed-in credentials masked, never an OAuth 2.0 token |
| `pm.response.code`, `.status`, `.responseTime`, `.responseSize`, `.headers.get()`, `.text()`, `.json()` | test scripts |
| `pm.response.to.have.status(code or reason)`, `.header(name[, value])`, `.body([text or regexp or object])`, `.jsonBody([path[, value]])` | response assertions |
| `pm.response.to.be.ok / success / error / clientError / serverError / notFound / json / withBody` (and `.not`) | response assertions |
| `pm.cookies.get/has/toObject` | from the response's `Set-Cookie` headers |
| `pm.test(name, fn)`, `pm.test.skip(name)` | `fn` may return a promise or take a `done` callback |
| `pm.expect(value[, message])` | chai-style: `to.equal/eql/deep.equal`, `a/an`, `include/contain`, `have.property` (also `nested`, `own`), `oneOf`, `above/below/least/most/within`, `length/lengthOf` (also `.lengthOf.above(n)`), `match`, `keys/members`, `exist`, `true/false/null/undefined/NaN/empty`, `throw`, `satisfy`, `closeTo`, `instanceOf`, `not` |
| `pm.info.eventName/requestName/requestId/iteration/iterationCount` | |
| `console.log/info/warn/error/debug` | Console tab |
| `btoa`, `atob` | Latin-1 base64 |
| `require(name)`, `_`, `CryptoJS`, `tv4`, `cheerio`, `xml2Json`, `crypto.getRandomValues/randomUUID` | built-in libraries, see below |
| Legacy: `postman.setEnvironmentVariable/getEnvironmentVariable/clearEnvironmentVariable`, `postman.setGlobalVariable/...`, `tests["name"] = bool`, `responseBody`, `responseCode`, `responseHeaders`, `responseTime`, `environment`, `globals`, `request`, `iteration` | old Postman sandbox names |
| `pm.sendRequest(request[, callback])` | see above; returns a promise |
| `pm.execution.setNextRequest(nameOrId or null)`, `postman.setNextRequest` | collection runner only, see [Collection runner](#collection-runner) |
| `pm.visualizer`, `pm.execution.skipRequest`, `require` of other modules | not supported: throw an error |

**Built-in libraries.** The libraries Postman's sandbox provides are available through `require()` (and Postman's globals), so
scripts like `const CryptoJS = require('crypto-js')` run unchanged. They run inside the same sandbox as your script, are loaded
the first time a script uses them (roughly 2-50 ms each; a script that uses none pays nothing), and count towards the script's
time and memory limits.

| Module | `require` name / global | Notes |
| --- | --- | --- |
| crypto-js 4.2 | `require('crypto-js')`, global `CryptoJS` | all algorithms: `MD5`, `SHA1`, `SHA256`, `SHA512`, `SHA3`, `HmacSHA256`, ..., `AES`/`TripleDES` encrypt and decrypt, `enc.Base64/Hex/Utf8/Latin1`, `PBKDF2`. Random values (salts, `WordArray.random`) come from the operating system's secure generator. `PBKDF2` without options uses Postman's crypto-js 3 defaults (SHA1, 1 iteration); it costs about 0.2 ms per iteration, so keep `iterations` in the thousands |
| lodash 4 | `require('lodash')`, global `_` | both are lodash 4 |
| moment 2 | `require('moment')` | English locale only |
| uuid | `require('uuid')` | `uuid.v4()` (also `uuid()`), `v1`, `v3`, `v5`, `v6`, `v7`, `validate`, `version`; v4 uses the secure generator |
| atob, btoa | `require('atob')`, `require('btoa')`, globals | Latin-1 base64 |
| chai 4 | `require('chai')` | the real chai (`expect`, `assert`, `should`); `pm.expect` is Slinger's own chai-style implementation |
| tv4 1.3 | `require('tv4')`, global `tv4` | JSON Schema draft 4 |
| ajv 6 | `require('ajv')` | the same major version as Postman (`new Ajv({ logger: console })`, `validate`, `compile`) |
| xml2js 0.6 | `require('xml2js')`, global `xml2Json(text)` | `xml2Json` uses Postman's options (`explicitArray: false`, `trim: true`); invalid XML gives `{}` |
| csv-parse 4 | `require('csv-parse/lib/sync')` | synchronous API only; option names as in csv-parse 4 (`columns`, `skip_empty_lines`, `cast`, ...) |
| cheerio 0.22 | `require('cheerio')`, global `cheerio` | Postman's (deprecated) version: `cheerio.load(html)` |
| Web Crypto subset | global `crypto` | `crypto.getRandomValues(typedArray)` (at most 65536 bytes) and `crypto.randomUUID()` only; no `crypto.subtle` |

Not available: `postman-collection` (too large for the sandbox), `require('crypto-js/sha256')`-style sub-paths (use
`require('crypto-js').SHA256`), and Node modules (`fs`, `http`, `crypto`, `path`, `os`, `buffer`, `url`, `util`, ...). Requiring
anything else fails with an error that lists the available modules.

**Examples.**

```js
// Tests of a "Login" request: keep the token for the next requests.
const body = pm.response.json()
pm.test('Status code is 200', () => pm.response.to.have.status(200))
pm.test('Returns a token', () => pm.expect(body).to.have.property('token').that.is.a('string'))
pm.environment.set('authToken', body.token)
```

```js
// Pre-request script on a folder: sign every request inside it.
const CryptoJS = require('crypto-js')
const ts = pm.variables.replaceIn('{{$timestamp}}')
const signature = CryptoJS.HmacSHA256(pm.request.method + '\n' + ts, pm.environment.get('apiSecret')).toString(CryptoJS.enc.Base64)
pm.request.headers.upsert({ key: 'X-Timestamp', value: ts })
pm.request.headers.upsert({ key: 'X-Signature', value: signature })
pm.request.headers.upsert({ key: 'X-Request-Id', value: require('uuid').v4() })
```

**Sync and versions.** Request scripts are part of the request, so cloud sync, collection versions and Postman export carry
them. Collection- and folder-level scripts are included in collection versions and Postman export, and cloud sync carries them too
(with a cloud server that supports it; an older server leaves them on the device where you wrote or imported them).

**Security.** Scripts from an imported collection are code from someone else. Slinger never runs them in the app window: they run
in the main process, in a separate worker thread, inside QuickJS (a JavaScript engine compiled to WebAssembly) with nothing but
the `pm` API described here. Details are in [ARCHITECTURE.md](ARCHITECTURE.md#scripts-sandbox). Scripts still act with your data:
a script can read the environment and send what it reads in the request it is attached to, **or to any http(s) address with
`pm.sendRequest`** (exactly as in Postman), so review scripts from sources you do not trust before sending their requests.

## History

The **History** sidebar tab lists recent requests of the current workspace grouped by day (last 200 shown; the app keeps up to 1000
per workspace), with a filter box. Click an entry to open the saved request, or a new tab pre-filled with method and URL if it was
not saved. Delete single entries or clear all. Secret values are never stored; the URL is recorded with secrets as `{{name}}`.
Cloud sync traffic is not recorded here.

## Collection versions

Right-click a collection and choose **Versions...**. A version is an immutable snapshot of that collection's folders, requests,
scripts, documentation and collection variables (not environments or globals) labelled with a semantic version. There is no git
involved. Restoring a version also restores its collection variables (a version made before Slinger stored collection
variables restores the collection without any).

- **Create version:** enter `MAJOR.MINOR.PATCH` (optionally `-prerelease`, e.g. `1.2.0` or `2.0.0-beta.1`; no leading `v`, no
  build metadata) and optional notes; buttons suggest the next patch, minor and major. A label can be used once per collection.
- The list is ordered newest first by semantic-version precedence and shows folder and request counts.
- **Compare:** pick a version and compare it against another version or the current collection to see added, removed and changed
  requests and folders.
- **Restore:** *as a new collection* named `<name> (vX.Y.Z)` (the live collection is untouched), or *replace the live collection*
  (asks for confirmation; suggests creating a version first). Replacing gives requests new ids, so open tabs for them are closed.
- **Delete** removes a version (it cannot be edited).
- **Versions travel with exports:** exporting a collection writes its version history into the file, and importing that file
  into Slinger (on this or another machine) restores every version with its number, notes, date and snapshot, so you can
  compare and restore them there. This works for any collection, including ones originally imported from Postman. See below.

## Documentation (Markdown)

Requests, folders and collections can carry documentation written in Markdown (Postman calls it the *description*; imported
collections keep theirs).

- **Where:** a request's **Docs** section; for a collection or folder, **Overview & docs** in its context menu (or the (i) button
  when hovering it in the tree). The overview tab shows the name, where it lives, how many requests and folders it holds (with a
  count per method), buttons for **Run**, **Scripts**, **Versions**, and its documentation. A collection's overview also has a
  **Variables** section with its collection variables (see [Variables and environments](#variables-and-environments)).
- **Preview / Edit / Split:** docs open rendered (**Preview**) when there is something to show; an empty doc offers **Add
  documentation**. **Edit** shows a Markdown editor (same font size and line-wrap setting as the other editors); **Split** shows the
  editor and the live preview side by side. The choice is remembered per tab.
- **Saving:** request docs save with the request (**Save**, Ctrl+S). Collection and folder docs save with the overview's **Save**
  button or Ctrl+S. They are included in collection versions, exported to Postman and synced with a linked cloud workspace (with a
  cloud server that supports it; request docs always sync with the request).
- **What renders:** GitHub-flavoured Markdown: headings (hover one for a `#` link to it), **bold**, *italic*, ~~strikethrough~~,
  lists and task lists (`- [x] done`), tables, block quotes, horizontal rules, inline `code` and fenced code blocks with syntax
  colours for JSON, JavaScript/TypeScript, XML, HTML and CSS (in the current theme's colours). Bare URLs become links.
- **Variables:** `{{name}}` in docs is shown as a highlighted token. Docs never resolve variables, so no value (and no secret) is
  ever shown there.
- **Links:** web (`http`, `https`) and `mailto:` links open in your system browser or mail app; `#section` links scroll within the
  doc. Other links (relative paths, custom schemes) do nothing.
- **Images:** images embedded as `data:` URLs are shown. Remote images are **not loaded** (the app never fetches content for docs);
  they appear as a placeholder with their alt text and an **Open image** link that opens the image in your browser.
- **HTML:** simple formatting HTML (for example `<b>`, `<br>`, `<details>`, `<kbd>`) is kept; scripts, styles, forms, frames and
  event handlers are removed.
- **Plain-text docs:** Postman descriptions imported as `text/plain` are shown exactly as written (no Markdown) and are marked
  "Plain text"; they stay plain text when edited and exported.
- **Read-only workspaces:** docs are view-only (Preview) for viewers of a shared cloud workspace.

## Import and export (Slinger and Postman)

- **Import:** open the **Import** dialog with the upload button in the Collections header (*Import collection or
  environment*), **Import…** on the empty state, or **Ctrl+K** > *Import collection or environment…*. It takes a
  **collection**, an **environment** or Postman **globals** from Slinger or Postman (collection v2.0/v2.1): Slinger exports
  (`.slinger_collection.json`, `.slinger_environment.json`), Postman exports (`.postman_collection.json`,
  `.postman_environment.json`, `.postman_globals.json`) or any other `.json`. Either drop or choose a file, or **paste the JSON**: into the
  *Or paste JSON* box, or press **Ctrl+V** anywhere in the dialog when no text field has focus. Whichever you gave last is
  imported. Very large pastes (megabytes) are not shown in the box; a size indicator and **Clear** stand in for them. Text you
  type into the box is checked once you pause. Invalid JSON, or JSON that is neither a collection nor an environment, shows an
  error in the dialog.
- **Paste into the URL bar:** pasting a whole collection or environment export into a request's URL field does not put it in
  the URL: the Import dialog opens with it, marked *Detected pasted collection — review and import*. Only an export is taken
  over (an object with `info` and `item[]`, or an environment with `values[]`, at least 200 characters); URLs, `{{variables}}`,
  query strings and other JSON paste as usual, and the URL field's undo history is unchanged.
- **Preview:** the preview shows the detected format (for example *Slinger collection v1.2.0*, *Postman collection v2.1*,
  *Postman environment*, *Slinger environment*) and what will be imported. Everything below works the same for a file and for
  pasted JSON (a replaced collection's safety version then says `re-import from pasted JSON`). A collection's `variable` list is
  stored as its **collection variables** (disabled ones stay disabled), so `{{placeholders}}` work without any environment.
  Optionally (off by default) the enabled ones are also copied into an environment named after the collection, for example to
  override them per environment. If an environment with that name already exists
  (ignoring case), the import **merges into it** instead of creating a second one: only variables it does not have yet are
  added, and existing values are kept (they may hold tokens set by scripts or your edits); the preview says how many will be
  added. Importing an **environment** file whose name already exists also updates that environment: missing variables are
  added and existing ones take the file's value and secret flag, except that an empty value in the file never clears the
  current one (so a secret exported without its value keeps the stored secret). A secret without a value that is new is added
  as an empty plain variable. Re-importing the same file never creates duplicates, and the success message says what changed
  (for example `Environment "UAT" updated: 3 added, 16 kept`). Pre-request and test scripts are imported at every level (collection, folders,
  requests) and run like scripts written in Slinger; the preview and the success message show how many. Descriptions of the
  collection, folders and requests are imported as their documentation (Markdown, or plain text for `text/plain`). OAuth 2.0
  settings are imported (a collection's or folder's auth is copied into its requests); an access or refresh token that Postman
  embedded in the file is dropped, so click **Get New Access Token** once. A Postman
  **globals** file (`*.postman_globals.json`) is imported into the workspace's **Globals** with the environment-file rules
  (missing variables added, existing ones updated, an empty value keeps the stored one); `secret` values become secret globals and
  disabled ones stay disabled. Disabled environment variables are skipped. Saved examples (`response[]`) are
  imported with their requests; the preview shows how many.
- **Importing a collection that already exists:** if the workspace already has the collection (same Postman `_postman_id`,
  which Slinger remembers from the earlier import on this device and which Slinger's own exports carry, otherwise the same name,
  ignoring case and surrounding spaces), the dialog asks what to do:
  - **Replace existing "X"** (default): the collection's folders, requests (with their saved examples), scripts,
    descriptions and collection variables are replaced by the file's content. The collection itself stays, with its name, versions and sync link. First
    an automatic version snapshot of the current content is created (the next patch version, notes
    `Automatic snapshot before re-import from <file>`), so you can get it back from **Versions...** with **Restore**. Expanded
    folders stay expanded and open request tabs without unsaved changes switch to the new content; tabs with unsaved changes keep
    your edits (save them again to keep them). If several collections match, pick which one to replace. Not available in a
    read-only (viewer) workspace.
  - **Import as a copy** named `X (2)`, `X (3)`, ... so the names stay distinguishable. The existing collection is untouched.
  - **Cancel.**

  Environments are handled the same way in both cases (merged into a same-named environment, see above). If the file carries
  Slinger version history, **Replace** adds those versions to the collection's existing ones (after the automatic snapshot):
  a version already present with the same content is skipped, one with the same number but different content is added as
  `<version>-imported`; the message lists what happened.
- **Version history on import:** when the file is a Slinger collection export with version history, the preview shows the
  number of versions and the import restores them on the new collection (same version numbers, notes, dates and snapshots; a
  message says how many). A file exported *without* snapshots lists its versions but they cannot be restored (the message says
  so). If the history block is damaged or was made by a newer Slinger, it is ignored with a note and the collection is still
  imported. A Postman collection (no history) imports exactly as before.
- **Export:** right-click a collection, **Export as Postman JSON...** (or Ctrl+K, `> export collection`), then **Save to file**
  (optionally **Choose folder...** first) or **Copy to clipboard**. Only saved requests are exported. The default folder is Downloads (else your home directory). Saved examples are
  exported in each item's `response` list; examples you did not edit are written back exactly as they were imported. Scripts are
  exported as Postman `event` lists on the collection, folders and requests; scripts you did not edit are written back exactly as
  imported. Documentation is exported as the `description` of the collection, folders and requests, in the shape it was imported
  in (a string, or `{content, type}`); docs you did not edit are written back unchanged. Collection variables are exported as the
  collection's `variable` list, in order (`disabled: true` for disabled ones). OAuth 2.0 settings are exported in Postman's
  format without any token. Globals and environments are never part of a collection export.
- **Versions in the export:** the file is a normal Postman Collection v2.1 file. `info.version` holds the collection's latest
  version (e.g. `1.2.0`) and Slinger's version history is stored alongside it in `info._slinger`, which Postman ignores, so the
  file imports into Postman unchanged. **Include version history snapshots** (on by default, the dialog shows how much it adds)
  stores each version's full content so it can be restored after import; untick it to keep only the version list (number,
  notes, date). Snapshots contain the collection's folders, requests, scripts, docs and collection variables only, never
  environment values, globals or secrets. If you
  import the file into Postman and export it again from Postman, the history is gone (Postman drops fields it does not know);
  the collection itself still imports into Slinger.
- **File names:** a collection is saved as `<collection name> v<latest version>.slinger_collection.json` (for example
  `enat uat v1.2.0.slinger_collection.json`), or `<collection name>.slinger_collection.json` when it has no versions; an
  environment as `<environment name>.slinger_environment.json`. The real name is kept, including spaces, capital letters,
  Amharic and other scripts and emoji. Only characters that Windows, macOS or Linux do not allow in file names (`/ \ : * ? " < > |`
  and control characters) become `_`, leading/trailing dots and spaces are dropped, Windows device names such as `CON` or `NUL`
  get a `_` appended, and very long names are shortened (about 150 characters) without cutting a character in half.
- **Environment export:** in the Environments dialog select an environment and click **Export environment...** (download
  icon), or press Ctrl+K and type `> export environment`. The file is a Postman environment file, so Postman and Slinger can
  both import it. Secret variables are exported **by name only** (type `secret`, empty value) unless you tick **Include secret
  values**, which shows a warning: the file then contains the secret values in plain text, so do not commit or share it. Importing
  the file back into Slinger merges into the environment with the same name (a secret exported without its value keeps the one
  already stored); with secret values included, secrets are recreated as secrets.

## Cloud account and sync

The **Cloud** button (and the sync chip next to the workspace switcher) opens the cloud panel.

**Account.** Set the **API base URL** of your Slinger Cloud server (default `https://api.slinger.app`) and a **device name**, then
**Sign in**: Slinger shows a code and a button to open the verification page in your browser, and completes by itself once you
approve there (the code expires; you can cancel). Sign-in, tokens and all cloud traffic live in the app's main process; tokens are
kept in your OS keychain and never reach the interface. Plain `http://` servers get a warning unless they run on this machine. If
the server is too old for collection sync, the panel says so and syncing stays off; your workspaces keep working locally.

**Publish or link a workspace.** For the current workspace, **Publish to cloud...** creates a cloud workspace and uploads
everything in it (collections, folders, requests, environments and their variables, versions) with progress; you can close the window
and it continues. **Link a cloud workspace...** connects an existing one: you can download it into a new team workspace (the
recommended choice when both sides have content) or merge it into the current workspace. A merge keeps collections, folders and
requests from both sides side by side (nothing is matched by name, so duplicates are possible), combines environments and variables
with the same name (a plain variable that differs takes the cloud value) and never moves secret values. If a cloud workspace is
read-only for you (viewer), it can only be downloaded into a new, read-only workspace. **Unlink** stops syncing and keeps
everything on both sides. If publishing says items "already exist in another cloud workspace" (the same workspace was published
before), **Publish a copy** uploads a fresh-id copy instead.

**What syncs.** Collections, folders and requests (with their scripts, docs and saved examples), collection- and folder-level scripts
and documentation, collection variables, environments and their variables, globals, and collection versions. Secret values
(secret environment variables and secret globals) never leave the device: the cloud and other devices only learn the name, and a
secret that arrives from another device shows **Value not set on this device** until you enter a value here. Request history,
app settings and cloud tokens never sync. If the same variable was added on two devices before they synced (for example after
importing the same Postman collection on both), identical ones become one; different ones are both kept and yours is renamed
`<name>_conflict` (noted in the conflict history). An older cloud server that does not know collection/folder scripts and docs,
collection variables or globals simply leaves them on each device (nothing is reported); they upload by themselves once the
server is updated.

**Status chip.** Synced (with pending changes and last-synced time in its tooltip), Syncing, Offline (edits are kept and upload
later), Sync error (with a Retry toast), conflicts, Read-only, Signed out, Access revoked. Click it for **Sync now** and the
**Auto sync** switch (on by default: Slinger checks for cloud changes regularly and uploads your edits shortly after you save).

**Conflicts.** Changes are merged automatically when they do not overlap. When they do, the item is kept as you have it, is not
uploaded, and appears in **Review conflicts**, grouped by kind: changed in both places, deleted in the cloud (you have unsent
changes), deleted here (edited in the cloud), version number clash, and changes the cloud rejected (for example a request whose
saved examples pushed it over the 900 KB per-request limit - see "Where they live" under Saved examples; the request editor warns
about this before it ever reaches that point). Each shows mine and the cloud side by side. Choose **Keep mine**, **Use cloud
version**, **Keep both** (a request only: your version becomes a "(conflict copy)"),
or **Choose per part** to pick mine or the cloud value for each conflicting part. Select several and use **Keep mine** / **Use
cloud** for bulk resolution (asks first). Keyboard: arrow keys, Home and End move through the list, Space selects, Tab reaches the
details and buttons. If a request open in a tab is changed in the cloud while you have unsaved edits in it, the tab keeps your edits
and shows a banner with **Reload from cloud** or **Keep my edits** (your next Save then overwrites on purpose); if it was deleted
you can **Save as new request** or close the tab. Clean tabs simply reload.

**Read-only workspaces.** With viewer access (or after access was revoked) the workspace shows a banner and every editing control
is disabled: new/rename/delete/move in the tree, import, saving requests, environments, creating and restoring versions. You can
still browse, send requests and export. Use **Unlink and keep as local copy** to work on it freely; **Discard local changes** resets
edits that can no longer be uploaded.

**Secret variables** never leave your device. A secret variable created on another device shows "Value not set on this device"
with a **Set value** button.

Server setup is documented in the separate `slinger-admin` repository.

## Themes and settings

Settings (Ctrl+, or the sun icon):

- **Theme.** A gallery of 31 themes with a live thumbnail of each (sidebar, URL bar, JSON response in that theme's colours),
  grouped **Light** and **Dark**. Type in **Filter themes** or use **All / Light / Dark** to narrow the list; arrow keys move
  between themes and apply them immediately.
  - Light: Light, Paper, GitHub Light, Solarized Light, Gruvbox Light, Catppuccin Latte, Rosé Pine Dawn, One Light, Nord Light,
    Ayu Light, High Contrast Light.
  - Dark: Dark, Midnight, Solarized Dark, GitHub Dark, Dracula, Nord, Gruvbox Dark, Catppuccin Mocha, Catppuccin Frappé,
    Tokyo Night, One Dark, Monokai, Rosé Pine, Ayu Mirage, Ayu Dark, Everforest, Kanagawa, Synthwave '84, Oceanic, High Contrast.
  - **System** follows your OS light/dark setting. Next to it, choose which theme it uses **When the OS is light** and
    **When the OS is dark** (for example Catppuccin Latte by day and Catppuccin Mocha at night). Your custom themes of the
    matching scheme are offered there too.
  - **Custom** lists your own themes (see [Custom themes](#custom-themes)) above the built-in ones.
- **Accent colour.** Buttons, selected items, focus rings and text selection use the accent. **Theme default** keeps each
  theme's own accent; or pick Blue, Indigo, Violet, Purple, Fuchsia, Pink, Rose, Red, Orange, Amber, Yellow, Lime, Green,
  Emerald, Teal, Cyan, Sky or Slate, which then applies on top of whatever theme is active (it adapts to light and dark themes).
- **Loading animation**, shown while a request is in flight: **Random** (default; a different character for each send),
  **Runner** (a little pixel-art runner), **Shuttle** (a space shuttle with a flickering flame among faint stars), **Pebble** (a
  pebble shot from a slingshot, bouncing off a target) or **Classic spinner**. The characters are drawn in the accent colour, so
  they suit every theme. The chosen character runs in its card as a preview. With *reduce motion* turned on in the operating
  system the character stands still (slowly pulsing) instead of running, and nothing moves while the window is hidden.
- **Layout:** the response **Below the request** (default) or **Beside the request** (see
  [Response below or beside the request](#response-below-or-beside-the-request)), and **Show status bar** (default on).
- **Font size** (11-20 px), **Wrap long lines in editors**, and for scripts the **Time limit per script** (default 5000 ms,
  100-60000) and **Send the request even when a pre-request script fails** (off by default). The dialog also shows the app version.
- **Restore open tabs on startup** (default on): reopens each workspace's tabs, in the same order with the same unsaved
  changes and dirty markers, the next time you start Slinger or switch to that workspace. Turning it off stops saving tabs
  and erases what is already stored; response panes are never part of what is saved or restored either way.

Changes apply instantly and are remembered. Quick switch without opening Settings: press Ctrl+K and type `>` followed by
`theme`, `accent` or `loading` (for example `> theme nord`, `> accent teal` or `> loading shuttle`), then Enter.

All themes are checked for readable contrast (WCAG AA, 4.5:1 for text) with every accent colour; the two High Contrast themes
meet AAA (7:1). A theme chosen in version 0.2.0 carries over automatically.

### Custom themes

A custom theme starts from a built-in **base theme** and overrides any of its colours; everything you leave out keeps
following the base theme. You can have up to 50.

- **New custom theme** (top right of the theme gallery) starts from the theme you are using now. Hover a built-in theme and
  click its copy icon to **duplicate it as a custom theme**. Each custom theme's card has **Edit**, **Duplicate**, **Export**
  and **Delete** (asks first; if it was in use, Slinger switches to its base theme).
- The editor has a **Name**, the **Base theme**, the **Scheme** (light or dark: native controls, scrollbars and accent colours
  follow it) and two views of the same colours:
  - **CSS**: one declaration per line, for example

    ```css
    /* Base: Midnight (dark). Tokens you leave out come from the base theme. */
    color-scheme: dark;
    --bg: #0b1020;
    --surface: #121a2e;
    --accent: #7c5cff;
    ```

    Only `color-scheme: light|dark;` and `--<token>: <colour>;` declarations are allowed (comments are fine). A value can be any
    CSS colour your system supports: `#rgb`/`#rrggbb`/`#rrggbbaa`, colour names, `rgb()`, `hsl()`, `hwb()`, `lab()`, `lch()`,
    `oklab()`, `oklch()`, `color()`, `color-mix()` and `light-dark()`. `--shadow-pop` takes a box-shadow instead (for example
    `0 8px 28px rgba(0, 0, 0, 0.4)`). Selectors and `{ }` blocks, `@` rules, other properties, unknown tokens, `url()`,
    `var()` and other functions, quotes, backslashes, `!important`, duplicates and values over 160 characters are rejected;
    each problem is listed with its line number, and the theme cannot be saved until they are fixed. What you type is never
    used as CSS directly: Slinger reads the colours from it and writes the theme's CSS itself.
  - **Form**: every token grouped as below, with a colour picker, the value as text (empty = inherited; the base value shows
    greyed out) and a reset button. Editing here rewrites the CSS view.
  - **Add all tokens from base** writes out every token with its base value so you can see and tweak the whole palette.
- **Preview in the whole app** (on by default) shows the theme everywhere while you edit; **Cancel** puts your theme back.
- **Contrast**: the editor checks the same colour pairs as the built-in themes (text on each background, text on the accent,
  status colours, syntax and method colours, focus ring, ...) and lists each one below its WCAG AA target, for example
  "Muted text on Surface: 3.1:1, needs 4.5:1 (secondary text)". These are warnings only: you can save anyway, and the theme's
  card in the gallery shows a warning badge with the count (hover it for the list).
- **Accent colours** work with custom themes like with built-in ones: with **Theme default** the theme's own `--accent...`
  tokens are used; any other accent replaces them.
- **Export** saves `<name>.slinger-theme.json` to your export folder (Downloads by default):
  `{ "format": "slinger-theme", "version": 1, "label": ..., "scheme": ..., "base": ..., "tokens": { "bg": "#0b1020", ... } }`.
  **Import theme** reads such a file or pasted text (a theme file's JSON or CSS declarations as in the CSS view), checks it
  with the same rules (invalid tokens are skipped and listed) and opens it in the editor so you can review it before saving.
- Custom themes are stored on this computer only (not synced); the Ctrl+K palette lists them as `Theme: <name>` (custom).

Tokens:

| Group | Token | Used for |
| --- | --- | --- |
| Surfaces and borders | `--bg` | page background, input fields |
| | `--surface` | panels, editors, dialogs |
| | `--surface-raised` | sidebar, toolbars, default buttons |
| | `--surface-hover` | hovered rows and buttons |
| | `--border`, `--border-strong` | dividers and control outlines; emphasised outlines |
| Text | `--text`, `--text-muted`, `--text-faint` | body text; secondary text and labels; hints and placeholders |
| Accent | `--accent` | primary buttons, selected borders |
| | `--accent-fg` | text on primary buttons |
| | `--accent-soft` | selected rows, badges (`--text` sits on it) |
| | `--accent-text` | links and accent-coloured text |
| | `--focus-ring`, `--selection` | keyboard focus outline; selected text in editors |
| Status | `--danger`, `--danger-fg`, `--danger-soft` | errors and 4xx/5xx status; text on delete buttons; error banners |
| | `--success`, `--success-soft` | 2xx status, passed tests; success badges |
| | `--warning`, `--warning-soft` | warnings, 3xx status; warning banners |
| Misc | `--preview-bg` | background of the HTML response preview |
| | `--overlay` | backdrop behind dialogs (usually translucent) |
| | `--shadow-pop` | box-shadow of menus and popovers (not a colour) |
| `{{variable}}` highlighting | `--var-ok`, `--var-ok-bg` | a resolved variable |
| | `--var-bad`, `--var-bad-bg` | an unresolved variable |
| | `--var-secret`, `--var-secret-bg` | a secret variable |
| Syntax | `--syn-keyword`, `--syn-string`, `--syn-number`, `--syn-bool`, `--syn-comment`, `--syn-property`, `--syn-tag`, `--syn-attr`, `--syn-punct` | code in bodies, responses and scripts |
| HTTP methods | `--m-get`, `--m-post`, `--m-put`, `--m-patch`, `--m-delete`, `--m-other` | method labels |

## About Slinger

The question-mark icon at the right of the top bar (or Ctrl+K, then `about`) opens **About Slinger**:

- The app version and **Copy version info**, which copies the Slinger, Electron, Chromium, Node and V8 versions and the OS
  (name, release, architecture) for a bug report. Nothing else is included: no host name, user name, paths or data.
- The developer, and links to the source code, releases, the issue tracker, the licence and the cloud server. Links open in your
  web browser.
- Why Slinger exists and **The Sling Manifesto** (also in the [README](../README.md#manifesto)).
- **Acknowledgements:** the open-source projects Slinger is built on, with versions and licences (expand "Standing on the shoulders
  of"; each name links to the project). Installed apps also include their full licence texts in `THIRD_PARTY_LICENSES.txt` in the
  app's resources folder.

## Menus

Slinger has its own menu bar (on macOS at the top of the screen).

| Menu | Items |
| --- | --- |
| **Slinger** (macOS only) | About Slinger, Settings… (Cmd+,), Services, Hide Slinger, Hide Others, Show All, Quit Slinger |
| **File** | New Request (Ctrl+T), Close Tab (Ctrl+W), Import…, Export Collection…; on Windows/Linux also Settings… (Ctrl+,) and Exit/Quit |
| **Edit** | Undo, Redo, Cut, Copy, Paste (macOS: Paste and Match Style), Delete, Select All |
| **View** | Toggle Response Position (Ctrl+Alt+V), Toggle Right Panel (Ctrl+Alt+B), Toggle Status Bar, Actual Size (Ctrl+0), Zoom In (Ctrl+=), Zoom Out (Ctrl+-), Toggle Full Screen |
| **Window** (macOS only) | Minimize, Zoom, Close Window (Shift+Cmd+W), Bring All to Front |
| **Help** | User Guide, Keyboard Shortcuts (Ctrl+/), Release Notes, Report an Issue, View License; on Windows/Linux also About Slinger |

- **Export Collection…** exports the collection of the active tab (a request or a collection/folder overview). With no such tab
  open, Slinger tells you how to pick one; you can also use Export in a collection's menu in the sidebar.
- **Close Tab** (Ctrl/Cmd+W) closes the request tab, never the window. On macOS, Close Window is Shift+Cmd+W.
- The zoom level is remembered for the next launch.
- Help links open in your web browser.
- Menu items for dialogs do nothing while another dialog is open (Settings and Keyboard Shortcuts still open), the same as the
  keyboard shortcuts.
- Development builds also show Reload and Toggle Developer Tools under View.

## Keyboard shortcuts

Taken from the shortcut handler and the in-app list (Ctrl+/):

| Shortcut | Action |
| --- | --- |
| Ctrl+Enter | Send the current request |
| Ctrl+S | Save the current request (Save as, if it is not saved yet) |
| Ctrl+T | New request tab |
| Ctrl+W | Close the current tab |
| Ctrl+K | Go to request; type `>` for commands (switch theme, accent or loading animation; layout; export a collection or an environment; About Slinger) |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous tab |
| Ctrl+Alt+V | Show the response below / beside the request |
| Ctrl+Alt+B | Show / hide the right panel |
| Ctrl+, | Settings |
| Ctrl+/ | Show or hide the shortcut list |
| Enter (in a table cell) | Move to the cell below |
| F2 / Delete (in the tree) | Rename / delete the selected item |

While a dialog is open, only Ctrl+, and Ctrl+/ are handled globally.
