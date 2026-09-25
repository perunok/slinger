# Slinger user guide

Slinger is a local-first API client. Everything is stored on your computer; nothing leaves it except the requests you send.
On Windows/Linux the shortcut modifier is Ctrl; on macOS Cmd works as well.

## Layout

- **Top bar:** workspace switcher, "Go to request" (Ctrl+K), environment switcher (with a gear to manage environments), the sync chip, Cloud,
  Keyboard shortcuts, Settings.
- **Sidebar:** two tabs, **Collections** and **History**.
- **Main area:** request tabs, the request editor, and the response pane below it.

## Workspaces

A workspace is the top-level container for collections, environments and history. Slinger creates one called "Personal" on
first launch. Open the workspace switcher in the top bar to switch, or open the Workspaces dialog to create, rename or delete
workspaces. Deleting a workspace removes its collections, requests, environments (and their keychain secrets) from view. If you
delete every workspace, "Personal" is recreated the next time you start the app.

## Collections, folders and requests

In the **Collections** sidebar:

- **New collection** (plus button), then right-click a collection for **Overview & docs**, **New request**, **New folder**,
  **Run collection...**, **Scripts...**, **Versions...**, **Export as Postman JSON...**, **Rename**, **Delete**.
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
- **Authorization:** No Auth, Basic Auth, Bearer Token, or API Key (added to a header or as a query parameter). Fields accept
  `{{variables}}`. Imported Postman requests with other auth types (for example OAuth 2.0) are sent without authorization and a
  warning says so; OAuth 2.0 is not implemented.
- **Scripts:** the request's **Pre-request** and **Tests** scripts (JavaScript, Postman's `pm` API); see [Scripts](#scripts).
- **Docs:** the request's documentation in Markdown, stored with the request and exported to Postman as its `description`;
  see [Documentation](#documentation-markdown).
- **Settings:** per-request timeout in milliseconds (default 60 000, maximum 600 000).
- **Code:** generates a snippet for the current request in cURL, JavaScript (fetch), JavaScript (axios), Python (requests), Go
  (net/http), PHP (cURL) or PowerShell, with a Copy button. Unresolved variables are left as-is in snippets.

Tabs: right-click a tab for Close / Close others / Close all / Save. Ctrl+W closes, Ctrl+Tab and Ctrl+Shift+Tab cycle. A tab
with unsaved edits shows a marker, and closing it asks before discarding. If a saved request changed underneath you (for
example in another window), Save reports "Request changed elsewhere" and lets you **Reload from stored** or **Overwrite**.
Open tabs are not restored after restarting the app. **Go to request** (Ctrl+K) searches saved requests; type `>` to list commands such as switching the theme, accent or loading animation.

## Variables and environments

Use `{{name}}` in the URL, headers, params, body, form fields and auth. Recognized names are highlighted; hover for the value
(secrets show as bullets), type `{{` for autocomplete, and unknown names offer to create the variable. A value can itself
reference other variables. If anything is unresolved when you press Send, the request is not sent and the response pane lists the
missing names ("define it in the active environment").

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
  of synced examples. Read-only (viewer) workspaces can open examples but not change them.

## Collection runner

Right-click a collection or folder and choose **Run collection...** / **Run folder...**. Pick which requests to run, set the delay
between requests (ms) and optionally **Stop on first failure**, then run. Requests run sequentially in tree order using the active
environment; each row shows status, time and, expanded, headers and a body preview. A row passes on a 2xx status only (redirects are followed first, so a remaining 3xx means the redirect did not end in a 2xx); 3xx, 4xx, 5xx and
network errors fail, unless you tick **Treat 3xx as pass**; requests with unresolved variables are skipped with the reason. You can stop a running run.
While the run is going, a small version of the loading character runs along the progress bar.
Runner requests are recorded in History.

Scripts run for every request exactly as for **Send** (collection, folder and request scripts). A failing test fails its row
("1 of 3 tests failed"); a failing pre-request script fails the row without sending it. Values set with `pm.variables.set` live for
the whole run, and `pm.environment.set` writes to the active environment, so the classic *login -> save token -> next request uses
`{{token}}`* flow works. The summary adds test counts (`Tests: 4 passed, 1 failed`), expanded rows list each test and the console
output, and **Export results as JSON** includes the tests. **Stop** also interrupts a running script.

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
  `graphql` (`{ query, variables }`), `auth` (`bearer`, `basic` or `apikey`, in Postman's format), and `timeout` in ms.
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
| Collection | `pm.collectionVariables.*` | kept in memory until the app restarts (not saved in v1) |
| Global | `pm.globals.*` | kept in memory per workspace until the app restarts (not saved in v1) |

`pm.variables.get(name)` and `{{name}}` in requests resolve with Postman's precedence: local, then environment, then collection
variables, then globals. Environment values are stored as text (numbers and objects are saved as JSON text); local, collection and
global values keep their JSON type within the session. Without an active environment, `pm.environment.set` lasts for the one send
and a console warning says so. In a **read-only (viewer) synced workspace** `pm.environment.set/unset` throw ("this workspace is
read-only"), which fails the script; reading still works, and the script editors are read-only. Variables that only scripts define
are shown as unresolved in the editors until a script has run, but they resolve at send time.

**Secret variables and scripts.** A script can read a secret environment variable, but only by asking for it by name:
`pm.environment.get('token')`, `pm.variables.get('token')` or `replaceIn('{{token}}')`. Secrets are left out of
`pm.environment.toObject()`, and the value is fetched from the keychain only when a script asks. `pm.environment.set` on a secret
keeps it secret (the new value goes to the keychain). Test scripts see `pm.request` with secret variables still written as
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
| `pm.collectionVariables.*`, `pm.globals.*` | same methods; session-only (see above) |
| `pm.iterationData.get/has/toObject` | always empty (no data files) |
| `pm.request.url`, `.method`, `.headers`, `.body`, `.name`, `.id` | editable in pre-request scripts |
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
| `pm.visualizer`, `pm.execution.*`, `postman.setNextRequest`, `require` of other modules | not supported: throw an error |

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
them. Collection- and folder-level scripts are included in collection versions and Postman export, but **cloud sync does not carry
them yet** (the cloud protocol has no field for them): they stay on the device where you wrote or imported them.

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

Right-click a collection and choose **Versions...**. A version is an immutable snapshot of that collection's folders and requests
(not environments) labelled with a semantic version. There is no git involved.

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
  count per method), buttons for **Run**, **Scripts**, **Versions**, and its documentation.
- **Preview / Edit / Split:** docs open rendered (**Preview**) when there is something to show; an empty doc offers **Add
  documentation**. **Edit** shows a Markdown editor (same font size and line-wrap setting as the other editors); **Split** shows the
  editor and the live preview side by side. The choice is remembered per tab.
- **Saving:** request docs save with the request (**Save**, Ctrl+S). Collection and folder docs save with the overview's **Save**
  button or Ctrl+S. They are kept on this device, included in collection versions and exported to Postman; **cloud sync does not
  carry collection and folder docs yet** (request docs sync with the request).
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

## Import and export (Postman)

- **Import:** use the upload button in the Collections header (or **Import from Postman** on the empty state). Drop or choose a
  Postman **collection (v2.x)** or **environment** `.json`: Slinger exports (`.slinger_collection.json`,
  `.slinger_environment.json`), Postman exports (`.postman_collection.json`, `.postman_environment.json`) or any other `.json`.
  The preview shows what will be imported. Collection-level variables
  can optionally become an environment named after the collection. If an environment with that name already exists
  (ignoring case), the import **merges into it** instead of creating a second one: only variables it does not have yet are
  added, and existing values are kept (they may hold tokens set by scripts or your edits); the preview says how many will be
  added. Importing an **environment** file whose name already exists also updates that environment: missing variables are
  added and existing ones take the file's value and secret flag, except that an empty value in the file never clears the
  current one (so a secret exported without its value keeps the stored secret). A secret without a value that is new is added
  as an empty plain variable. Re-importing the same file never creates duplicates, and the success message says what changed
  (for example `Environment "UAT" updated: 3 added, 16 kept`). Pre-request and test scripts are imported at every level (collection, folders,
  requests) and run like scripts written in Slinger; the preview and the success message show how many. Descriptions of the
  collection, folders and requests are imported as their documentation (Markdown, or plain text for `text/plain`). Postman "globals" files
  are rejected; export an environment instead. Disabled environment variables are skipped. Saved examples (`response[]`) are
  imported with their requests; the preview shows how many.
- **Importing a collection that already exists:** if the workspace already has the collection (same Postman `_postman_id`,
  which Slinger remembers from the earlier import on this device and which Slinger's own exports carry, otherwise the same name,
  ignoring case and surrounding spaces), the dialog asks what to do:
  - **Replace existing "X"** (default): the collection's folders, requests (with their saved examples), scripts and
    descriptions are replaced by the file's content. The collection itself stays, with its name, versions and sync link. First
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
  in (a string, or `{content, type}`); docs you did not edit are written back unchanged.
- **Versions in the export:** the file is a normal Postman Collection v2.1 file. `info.version` holds the collection's latest
  version (e.g. `1.2.0`) and Slinger's version history is stored alongside it in `info._slinger`, which Postman ignores, so the
  file imports into Postman unchanged. **Include version history snapshots** (on by default, the dialog shows how much it adds)
  stores each version's full content so it can be restored after import; untick it to keep only the version list (number,
  notes, date). Snapshots contain the collection's folders and requests only, never environment values or secrets. If you
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
everything in it (collections, folders, requests, environments and variables, versions) with progress; you can close the window
and it continues. **Link a cloud workspace...** connects an existing one: you can download it into a new team workspace (the
recommended choice when both sides have content) or merge it into the current workspace. A merge keeps collections, folders and
requests from both sides side by side (nothing is matched by name, so duplicates are possible), combines environments and variables
with the same name (a plain variable that differs takes the cloud value) and never moves secret values. If a cloud workspace is
read-only for you (viewer), it can only be downloaded into a new, read-only workspace. **Unlink** stops syncing and keeps
everything on both sides. If publishing says items "already exist in another cloud workspace" (the same workspace was published
before), **Publish a copy** uploads a fresh-id copy instead.

**Status chip.** Synced (with pending changes and last-synced time in its tooltip), Syncing, Offline (edits are kept and upload
later), Sync error (with a Retry toast), conflicts, Read-only, Signed out, Access revoked. Click it for **Sync now** and the
**Auto sync** switch (on by default: Slinger checks for cloud changes regularly and uploads your edits shortly after you save).

**Conflicts.** Changes are merged automatically when they do not overlap. When they do, the item is kept as you have it, is not
uploaded, and appears in **Review conflicts**, grouped by kind: changed in both places, deleted in the cloud (you have unsent
changes), deleted here (edited in the cloud), version number clash, and changes the cloud rejected. Each shows mine and the cloud
side by side. Choose **Keep mine**, **Use cloud version**, **Keep both** (a request only: your version becomes a "(conflict copy)"),
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
    **When the OS is dark** (for example Catppuccin Latte by day and Catppuccin Mocha at night).
- **Accent colour.** Buttons, selected items, focus rings and text selection use the accent. **Theme default** keeps each
  theme's own accent; or pick Blue, Indigo, Violet, Purple, Fuchsia, Pink, Rose, Red, Orange, Amber, Yellow, Lime, Green,
  Emerald, Teal, Cyan, Sky or Slate, which then applies on top of whatever theme is active (it adapts to light and dark themes).
- **Loading animation**, shown while a request is in flight: **Random** (default; a different character for each send),
  **Runner** (a little pixel-art runner), **Shuttle** (a space shuttle with a flickering flame among faint stars), **Pebble** (a
  pebble shot from a slingshot, bouncing off a target) or **Classic spinner**. The characters are drawn in the accent colour, so
  they suit every theme. The chosen character runs in its card as a preview. With *reduce motion* turned on in the operating
  system the character stands still (slowly pulsing) instead of running, and nothing moves while the window is hidden.
- **Font size** (11-20 px), **Wrap long lines in editors**, and for scripts the **Time limit per script** (default 5000 ms,
  100-60000) and **Send the request even when a pre-request script fails** (off by default). The dialog also shows the app version.

Changes apply instantly and are remembered. Quick switch without opening Settings: press Ctrl+K and type `>` followed by
`theme`, `accent` or `loading` (for example `> theme nord`, `> accent teal` or `> loading shuttle`), then Enter.

All themes are checked for readable contrast (WCAG AA, 4.5:1 for text) with every accent colour; the two High Contrast themes
meet AAA (7:1). A theme chosen in version 0.2.0 carries over automatically.

## Keyboard shortcuts

Taken from the shortcut handler and the in-app list (Ctrl+/):

| Shortcut | Action |
| --- | --- |
| Ctrl+Enter | Send the current request |
| Ctrl+S | Save the current request (Save as, if it is not saved yet) |
| Ctrl+T | New request tab |
| Ctrl+W | Close the current tab |
| Ctrl+K | Go to request; type `>` for commands (switch theme, accent or loading animation; export a collection or an environment) |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous tab |
| Ctrl+, | Settings |
| Ctrl+/ | Show or hide the shortcut list |
| Enter (in a table cell) | Move to the cell below |
| F2 / Delete (in the tree) | Rename / delete the selected item |

While a dialog is open, only Ctrl+, and Ctrl+/ are handled globally.
