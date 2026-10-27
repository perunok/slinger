# Slinger user guide

Slinger is a local-first API client. Everything is stored on your computer; nothing leaves it except the requests you send (plus, unless you turn it off, a
check with GitHub for a new Slinger release at each start and once a day, see [Updates](#updates)).
On Windows/Linux the shortcut modifier is Ctrl; on macOS Cmd works as well.

## Layout

- **Title bar:** by default the top bar is the window's title bar: drag any empty part of it to move the window, double-click
  it to maximise. On Windows/Linux Slinger draws the minimise, maximise/restore and close buttons itself (at the right end by
  default; move them anywhere, for example to the left in macOS order: see **Arrange it** below), and the menu button (three
  lines) opens the File, Edit, View and Help menus; macOS keeps its traffic lights at the start. Settings > Layout & window >
  **Use the system title bar** brings
  back your system's title bar and menu bar instead (click **Reopen window** to apply it).
- **Menus:** File, Edit, View, Help (plus the Slinger and Window menus on macOS); see [Menus](#menus).
- **Top bar:** by default, at the left the menu button, the Sidebar toggle, the workspace switcher and the sync chip (cloud
  sync state; click it for Sync now, conflicts and **Cloud…**); at the right "Go to request" (Ctrl+K), the environment switcher
  (with a gear to manage environments), Right panel, Keyboard shortcuts, Settings (the gear icon), About Slinger (the
  question-mark icon) and the window buttons. Each of these has one place on screen; the menus and the command palette reach
  them too. **Arrange it** in Settings > Layout & window >
  **Title bar items** (or right-click an empty part of the bar > **Customize title bar…**): drag an item to the Left or Right
  list or to Hidden, or focus it and use the arrow keys (up/down: order; left/right: Left, Right, Hidden); **Reset** restores the
  default. Settings and the window buttons can be moved but not hidden.
- **Sidebar:** three tabs, **Collections**, **History** and **Workflows** (see [Workflows](#workflows)). Hide it for more room
  and bring it back with **Ctrl+B**, the Sidebar button in the title bar, View > Toggle Sidebar or Settings > Layout & window > **Show
  sidebar**; it comes back at the width it had.
- **Main area:** request tabs, the request editor, and the response pane below it (or beside it, see below). An MCP request
  has its own editor and result pane, see [MCP requests](#mcp-requests).
- **Status bar** (bottom, can be hidden): see [Status bar](#status-bar).
- **Right panel** (closed by default): see [Right panel](#right-panel).
- **Closing the window** keeps Slinger running in the system tray (macOS: the menu bar), so AI assistants, collection runs and
  sync go on. Click the tray icon (on desktops that support it; otherwise open its menu and choose **Open Slinger**) to bring
  the window back; starting
  Slinger again (or, on macOS, clicking its Dock icon) does the same: only one Slinger runs at a time for your user account,
  so starting it again never opens a second copy. **Quit Slinger** in the tray menu, File > Quit (Exit on
  Windows, Ctrl+Q on Linux) or Slinger > Quit Slinger (Cmd+Q) closes it completely: an assistant's request in progress gets up
  to 10 seconds to finish, then the MCP server stops, and connected assistants do not start Slinger again until you open it
  yourself. Turn this off in Settings > Layout & window (for example when your desktop shows no tray icons).

### Status bar

The thin bar at the bottom of the window shows status only (the cloud sync state and the environment are in the top bar):

- **Activity:** *Running <collection>… 3/10* while a collection run goes on (also in the background), *Run finished:
  <collection>* when one finished in the background; click it to open the run (with several runs, choose one from the list).
  *Sending…* while requests are in flight. *Mock 127.0.0.1:4010* while a [mock server](#mock-servers) runs; click it to
  open its dialog (with several, choose one from the list).
- On the right, for the active request tab, the **last response**: status (coloured like in the response pane), time and size;
  *Not sent* when the last send failed before a response.

Hide it with **Settings > Layout > Show status bar** or **View > Toggle Status Bar** (also in the command palette,
`> status bar`).

### Right panel

A panel on the right of the main area with more about the active request or example tab. Open or close it with the
panel icon in the top bar, **Ctrl+Alt+B** (Cmd+Option+B on macOS), **View > Toggle
Right Panel**, or the command palette (`> right panel`, which can also open it directly on one view). It has four views:

- **Variables:** every `{{variable}}` the request uses (URL, enabled headers, body, authorization; for an MCP request also the
  command, its arguments and environment, the tool arguments, URI and prompt arguments) with its current value and
  where it comes from (environment, collection, globals, built-in). Secret values are masked; variables that are not defined
  anywhere are highlighted and have a **Create** button. Below: all variables in scope.
- **Docs:** the request's documentation, rendered. **Edit in Docs** switches the request to its Docs section (for an example,
  **Open request** opens the parent request).
- **Code:** the code snippet for the request (the same generator as the request's Code section), with a language picker and
  **Copy** (plus **Save** for the `.http` file language). Every language is syntax-highlighted (cURL and the MCP Inspector
  command as shell). For an MCP request it is an MCP Inspector CLI command instead.
- **Info:** name, method, URL (for an MCP request: the transport and the server or command), collection/folder, saved or
  unsaved, ID, created and updated times, version, and the workspace's sync state.

With no request tab active (or a collection overview), the views say so. Drag the panel's left edge to resize it (or focus
the edge and use Left/Right). Whether it is open, the view and the width are remembered. The panel only shows when the request
editor keeps a usable width next to it (about 500 px, 640 px with the response beside the request); in a narrower window it
hides until there is room again (the top-bar icon turns amber), so widen the window or drag the sidebar narrower.

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

- **New collection** (plus button), then right-click a collection for **Overview & docs**, **New request**, **New MCP request**
  (see [MCP requests](#mcp-requests)), **New folder**,
  **Run collection...**, **Variables...**, **Scripts...**, **Versions...**, **Export...**, **Rename**, **Delete**.
- Right-click a folder for **Overview & docs**, **New request**, **New MCP request**, **New subfolder**, **Run folder...**, **Scripts...**,
  **Extract to new collection...**, **Rename**, **Delete**.
- Hovering a collection or folder shows an (i) button that also opens its overview (see [Documentation](#documentation-markdown)).
- Right-click a request for **Open**, **Duplicate**, **Copy URL**, **Copy as cURL** (HTTP requests), **Rename**, **Delete** (and
  **Add example**, except for MCP requests). Copy URL copies the URL as saved, with its `{{variables}}`; Copy as cURL copies the
  same command as the Code panel's cURL snippet.
- Drag and drop to reorder or move folders and requests (a folder cannot be dropped into itself or its own subfolders).
- **Extract to new collection** turns a folder into a collection of its own, named after it (you can change the name). Its
  requests move with it, keeping their history, examples and docs, its subfolders come along, and the folder leaves the original
  collection. The folder's scripts and docs become the new collection's. Two options (on by default) keep the requests working
  as before: **Copy the collection variables** of the original collection, and **Keep the scripts that ran before this
  folder's** (the original collection's and parent folders' scripts are placed ahead of the folder's own in the new
  collection's scripts, each part marked with where it came from). In a workspace synced to the cloud the new collection syncs
  like any other; read-only (viewer) workspaces do not offer it.
- In the tree, F2 renames and Delete deletes the selected item. Deleting asks for confirmation and cannot be undone from the UI.

## Requests

This section is about HTTP requests; for requests to MCP servers see [MCP requests](#mcp-requests).

Ctrl+T opens a new tab. The URL bar has the method selector, the URL, **Send** (Ctrl+Enter, becomes cancel while running) and
**Save** (Ctrl+S). Saving a request that is not in a collection yet asks where to put it ("Save as"). Saving again while a save
is still running (or holding Ctrl+S) does not save twice: one more save follows only if you changed something meanwhile. A URL typed without
`http://` or `https://` is sent as http, as in Postman (`localhost:3000/users`, `api.example.com/x`, `//cdn.example.com/a`);
with port 443 (`api.example.com:443/x`) as https. The same goes for the other address fields: MCP request URLs, OAuth 2.0
endpoints, the cloud server address (`172.16.0.236:8088`) and OpenAPI document URLs.

The editor sections are **Params**, **Authorization**, **Headers**, **Body**, **Scripts**, **Docs**, **Settings** and **Code**.

- **Params:** query parameters as a table; edits stay in sync with the URL. Disabled rows are kept but not sent. Below
  them, **Path Variables** (see [Path variables](#path-variables)) when the URL has `:name` segments.
- **Headers:** a key/value table. "Auto-generated headers" lists headers Slinger adds by itself (for example `Content-Type` from
  the body mode and `User-Agent: Slinger`); a header you set yourself wins.
- **Body:** `none`, `form-data` (text and file fields; pick files with the native dialog; a saved file must be chosen again after restarting the app: the field then shows "file not granted"), `x-www-form-urlencoded`, `raw`
  (JSON, XML, Text, HTML, JavaScript; **Beautify** formats JSON) and `binary` (send one file). GET and HEAD requests cannot have
  a body.
- **Authorization:** **Inherit auth from parent** (the default for new requests), No Auth, Basic Auth, Bearer Token, API Key
  (added to a header or as a query parameter) or [OAuth 2.0](#oauth-20). Fields accept `{{variables}}`. Imported Postman
  requests with other auth types (for example Digest or AWS Signature) are sent without authorization and a warning says so.
  See [Collection and folder authorization](#collection-and-folder-authorization) for inheriting.
- **Scripts:** the request's **Pre-request** and **Tests** scripts (JavaScript, Postman's `pm` API); see [Scripts](#scripts).
- **Docs:** the request's documentation in Markdown, stored with the request and exported to Postman as its `description`;
  see [Documentation](#documentation-markdown).
- **Settings:** per-request timeout in milliseconds (default 60 000, maximum 600 000).
- **Code:** generates a snippet for the current request in cURL, JavaScript (fetch), JavaScript (axios), Python (requests), Go
  (net/http), PHP (cURL), PowerShell or as an **HTTP file (.http)**, with a Copy button. Unresolved variables are left as-is in
  snippets. The `.http` language is the request format of the HTTP Client in IntelliJ IDEA and other JetBrains IDEs, VS Code
  REST Client and similar tools: a `### <request name>` line, `METHOD URL`, the headers, a blank line and the body
  (form-data as `multipart/form-data` parts, files and binary bodies as `< path` includes; Basic auth with a `{{variable}}`
  as `Basic <username> <password>`, which these tools encode themselves). **Save** writes it as `<request name>.http` to the
  export folder (Downloads unless you chose another one in an export dialog).

### Path variables

As in Postman, a whole path segment written `:name` is a **path variable**: `{{baseUrl}}/pets/:petId` has the variable
`petId`. Each one gets a row under **Params > Path Variables**, with its value and an optional description; typing or deleting
`:name` in the URL adds or removes its row (values of the names that stay are kept), and the key itself is only edited in the
URL. Values may contain `{{variables}}`.

When the request is sent, each `:name` segment is replaced by its value, with `{{variables}}` resolved and the result
URL-encoded (`a b/c` is sent as `a%20b%2Fc`). Only whole segments of the path count: not the host or port
(`localhost:3000`), not `::name`, not text after `?` or `#`. A path variable without a value is sent as written (`:petId`) and
the response shows a warning. The same values are used by the collection runner, workflows, the Code snippets (cURL and the
others; `.http` exports put the values, `{{variables}}` kept, into the URL) and assistants (`send_request`).

Path variables are imported from Postman (`url.variable`) and from OpenAPI documents (`/pets/{petId}` becomes `/pets/:petId`
with the documented example as its value), exported to Postman as `url.variable` and to OpenAPI as path parameters, and a
pasted cURL command with `:id` in its URL keeps it as a path variable. Mock servers treat a `:name` segment as a wildcard, as
before.

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
  runner behaves the same. Code snippets show `<access token>` in place of the token (`.http` snippets and exports use the
  variable `{{oauth2_access_token}}` instead, to define in the `.http` tool's environment).
- **Where a token may go.** A token is sent to the host (scheme, host and port) it was first used with. When a request would
  send it somewhere else (another environment's `{{baseUrl}}`, an edited URL), Slinger asks **Send the access token to a new
  host?** first; **Allow** adds that host for this token, **Cancel** sends nothing. The list is kept when the token is
  refreshed or replaced. Requests sent by an AI assistant or in the runner do not ask: they fail with that message, and you
  allow the host by sending the request once from its tab.
- **Where tokens live.** Tokens are stored only in your OS keychain (like secret variables), never in the request, history,
  exports, version snapshots or cloud sync; the settings (without any token) are saved with the request like other auth. If
  the keychain is not available, getting a token fails with a message and the rest of the app keeps working.
- **Not supported:** the implicit grant (deprecated; Slinger keeps imported settings and asks you to use Authorization Code
  (With PKCE)), and `pm.sendRequest` with OAuth 2.0 auth in scripts.

### Collection and folder authorization

Collections and folders have an **Authorization** setting of their own, as in Postman: open the collection's or folder's
overview (right-click > **Overview & docs**) and choose the **Authorization** section. It offers the same types and fields as a
request's Authorization tab, including OAuth 2.0 with **Get New Access Token**; **Save** (Ctrl+S) stores it together with the
documentation.

- A request set to **Inherit auth from parent** uses the authorization of the nearest folder above it that sets one, else the
  collection's. A folder is set to inherit by default too; a folder set to **No Auth** stops the lookup (its requests are sent
  without authorization). A collection cannot inherit: without a setting it has no authorization.
- The lookup happens when the request is sent, so changing the token on the collection changes it for every request that
  inherits it. Everything that sends a request does the same: Send, the collection runner, workflows, AI assistants
  (`send_request`), code snippets, the auto-generated headers list and the MCP connect of an MCP request.
- While a request inherits, its Authorization tab shows **Inherited from** *folder or collection* with the type in use; click
  the name to open that folder's or collection's Authorization section. The (i) next to it explains the lookup.
- OAuth 2.0: get the token in the collection's or folder's Authorization section. Requests that inherit the same settings use
  the same stored token.
- Credentials typed directly into a collection's or folder's authorization are stored like a request's (use `{{variables}}`,
  secret ones stay in your keychain); OAuth 2.0 tokens never are.
- New requests inherit; a request with **No Auth** is sent without authorization whatever its folders and collection say.
  Requests saved by Slinger 0.26 or older with "No Auth" are shown as **Inherit**: they keep behaving the same until you give
  their collection or a folder an authorization.
- Cloud sync: collection and folder authorization syncs with Slinger Cloud servers that support it (released together with
  this version); with an older server it stays on this device (nothing is sent, no warning), like scripts and docs did with
  older servers, and other devices send inheriting requests without it until the server is upgraded.

Tabs: right-click a tab (or Shift+F10 on it) for Close / Close others / Close to the right / Close all / Save, and on request
tabs Copy URL / Copy as cURL (of what the tab shows, unsaved edits included). Ctrl+W closes, Ctrl+Tab and Ctrl+Shift+Tab cycle. A tab
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
save automatically with a status indicator. If a variable changed elsewhere since the table loaded it (sync, a script, an
assistant), its row shows *Changed elsewhere* instead of overwriting it; **Retry** saves your value over it. The same applies to
collection variables and globals. The active environment is remembered per workspace. Variable names are unique
within an environment, and environment names are unique within a workspace (ignoring case and surrounding spaces; renaming
an environment to its own name in a different case is fine). The create/rename dialog flags a taken name as you type. Only
sync can bring two same-named environments into one workspace (for example when two devices created one offline); rename or
delete one of them.

**Secret variables.** Tick **Secret** on a variable to store its value in your operating system keychain instead of the
database. The table then shows masked bullets; use the reveal control to look at it, and leave the value empty when editing to
keep the stored one. Secrets are never written to history, collection exports or version snapshots, and an environment export
contains them only if you tick **Include secret values** (see below). If no keychain is available (typical on
headless Linux without a Secret Service) saving a secret fails with an error while everything else keeps working.

**Built-in dynamic variables** (generated fresh at each send, same value wherever repeated within one send; type `{{$` in
any field to pick one, hover one to see an example). Postman's names, plus `$date`, `$time` and `$randomString`:

- ids and time: `{{$guid}}` / `{{$randomUUID}}` (UUID v4), `{{$timestamp}}` (Unix seconds), `{{$isoTimestamp}}`, `{{$date}}`
  and `{{$time}}` (UTC), `{{$randomDatePast}}`, `{{$randomDateFuture}}`, `{{$randomDateRecent}}`;
- numbers and text: `{{$randomInt}}` (0-1000), `{{$randomBoolean}}`, `{{$randomString}}` (12 letters and digits),
  `{{$randomAlphaNumeric}}`, `{{$randomPrice}}`, `{{$randomSemver}}`, `{{$randomWord}}`, `{{$randomWords}}`,
  `{{$randomLoremWord}}`, `{{$randomLoremWords}}`, `{{$randomLoremSentence}}`, `{{$randomLoremParagraph}}`, `{{$randomLoremSlug}}`;
- people: `{{$randomFirstName}}`, `{{$randomLastName}}`, `{{$randomFullName}}`, `{{$randomNamePrefix}}`, `{{$randomJobTitle}}`,
  `{{$randomUserName}}`, `{{$randomEmail}}`, `{{$randomExampleEmail}}` (both at example.com), `{{$randomPassword}}`,
  `{{$randomPhoneNumber}}`;
- places and companies: `{{$randomCity}}`, `{{$randomStreetName}}`, `{{$randomStreetAddress}}`, `{{$randomCountry}}`,
  `{{$randomCountryCode}}`, `{{$randomLatitude}}`, `{{$randomLongitude}}`, `{{$randomCompanyName}}`, `{{$randomCurrencyCode}}`,
  `{{$randomBankAccount}}`, `{{$randomLocale}}`;
- internet: `{{$randomUrl}}`, `{{$randomDomainName}}`, `{{$randomDomainWord}}`, `{{$randomIP}}`, `{{$randomIPV6}}`,
  `{{$randomMACAddress}}`, `{{$randomUserAgent}}`, `{{$randomMimeType}}`, `{{$randomFileName}}`, `{{$randomHexColor}}`,
  `{{$randomColor}}`, `{{$randomAbbreviation}}`.

A variable you define with the same name wins. Scripts get the same values from `pm.variables.replaceIn('{{$guid}}')`, and
mock servers fill them into example responses.

## Reading the response

While a request is in flight the pane shows a small animated character running back and forth along a track (see **Loading
animation** in Settings), "Sending request…" with the elapsed time, and **Cancel**. When the response arrives it is shown at
once; the character plays a short finish on top (under half a second): the runner cheers, the shuttle lands, the pebble hits
its target. On an error (no response, or a 4xx/5xx status) it stumbles in the error colour; on Cancel it simply disappears.

After Send the pane shows status, time and size. Views: **Pretty** (formatted, foldable JSON/XML/HTML; CSV as a table; CSS, JavaScript, YAML and Markdown highlighted), **Raw**
(hex preview for binary content), **Preview** (HTML in a fully sandboxed frame, images, PDF), **Headers** and **Cookies**
(parsed from `Set-Cookie`). Toolbar: search in response, toggle word wrap, copy body, **Save response to file** (to the export
folder). Non-2xx responses are shown normally; network errors, timeouts and cancellations appear as inline errors.

**Large responses.** Slinger loads at most the **Maximum response size** (Settings > Requests, default 50 MB like Postman,
1-256 MB). For a larger body it stops the download and shows *Response larger than 50 MB — not loaded*, with the status and
headers still there. **Send and download to file** asks where to save, sends the request again and writes the whole body
straight to that file (no size limit); the response pane then shows where it was saved and how big it is. Test scripts do not
run for such a download (there is no body to test). In the collection runner and for AI assistants a body over the limit is
reported as not loaded.

When the request (or its folder or collection) has scripts, two more views appear: **Tests** (every `pm.test` with pass/fail/skip,
the assertion message of failures, script errors, a filter, and a `passed/total` badge on the tab that turns red when something
failed) and **Console** (`console.log/info/warn/error` output with level, time and which script printed it; **Clear** empties it).
Both belong to the last send and are kept in memory only: they are not saved, not written to history and gone after a restart.

## MCP requests

An MCP request connects to a [Model Context Protocol](https://modelcontextprotocol.io) server and runs one operation on it:
**call a tool**, **read a resource** or **get a prompt**. It works like the MCP Inspector, inside a collection: connect, see
what the server offers, fill in a form made from a tool's input schema, run it, and look at the result and at every message
exchanged. MCP requests are saved, synced, versioned and recorded in History like HTTP requests, and the collection runner,
workflows and AI assistants can run them. (This is Slinger as an MCP *client*. For Slinger's own MCP server, which lets an
assistant work in Slinger, see [AI assistants (MCP)](#ai-assistants-mcp).)

**Create one:** right-click a collection or folder > **New MCP request** and give it a name. It opens in a tab with the
**MCP** method badge. (Ctrl+T and File > New Request open HTTP requests.)

**The bar:** the transport, where the server is, a status dot, **Connect** / **Disconnect**, **Run** (Ctrl+Enter; **Cancel**
while it runs) and **Save** (Ctrl+S). The transports:

- **Streamable HTTP** (default): the server's URL, for example `https://example.com/mcp`.
- **SSE (legacy)**: older servers that use a separate Server-Sent Events endpoint, for example `https://example.com/sse`.
- **Command (stdio)**: Slinger starts a program on this computer and talks to it over its standard input and output. Enter the
  **Command** (for example `npx`) and its **Arguments** (for example `-y @modelcontextprotocol/server-everything`). Arguments
  are split at spaces like in a shell: put an argument that contains spaces in quotes (`"My Documents"` or `'My Documents'`),
  or escape a single character with a backslash. A command runs only after you allowed it, see
  [Allow this command](#allow-this-command) below.

The editor sections are **Call**, **Connection**, **Server**, **Scripts** and **Docs** (the last two as for HTTP requests).

- **Connection:** for Streamable HTTP and SSE, the **Headers** sent with every HTTP request of the connection and the
  **Authorization** (the same panel as for HTTP requests: Basic, Bearer, API key, OAuth 2.0; it is sent as a header, or, for an
  API key or OAuth 2.0 token set to go in the query, in the URL). For a command, its **Environment** variables and **Working
  directory** (empty: your home directory). The command does not get Slinger's whole environment, only a small safe set
  (`PATH`, `HOME`, `USER`, `SHELL`, `TERM`, `LOGNAME`; on Windows `PATH`, `APPDATA`, `USERPROFILE`, `TEMP` and a few more)
  plus the variables you add here. For every transport, **Call timeout** in milliseconds (empty: 60 000; at most 600 000, a
  larger value counts as 600 000).
- **Server:** once connected, what the server reported: name, version, protocol version, how long connecting took, its
  capabilities (expand **Raw capabilities** for the JSON) and its instructions, rendered as Markdown.

**Connect and Run.** **Connect** opens the connection and loads what the server offers; the dot turns green (hover it for the
server's name, or for why connecting failed). Connect resolves `{{variables}}` with the active environment like a send does,
but does not run pre-request scripts. **Run** runs the selected operation and connects first when needed, so Connect is only
for looking around before running. The connection belongs to the tab: it stays open while you switch to other tabs, and
**Disconnect**, changing the transport, closing the tab or switching to another workspace closes it. When the URL, a header, the token or the command changed
since connecting, the next Run reconnects. Slinger also closes a connection that was not used for 15 minutes, and keeps at most
20 open (the least recently used one closes first).

**The Call section.** On the left, what the server offers: **Tools**, **Resources**, **Templates** (resource templates) and
**Prompts**, each with a count, a search box and a reload button. The lists load when the connection opens (only the kinds the
server supports) and a list reloads by itself when the server says it changed. If the server fails to give one list (some
servers declare resources but do not implement resource templates), the error shows above the lists and the others still
load. A list shows at most 1000 entries (the count then ends in `+`). On the right, the **Operation** (**Call a tool**, **Read a resource**, **Get a prompt**) with the tool name,
resource URI or prompt name; clicking an entry on the left fills them in, and you can also type them. Below are the selected
entry's title and description (for tools also the server's hints: read-only, destructive, idempotent, open world) and its
input:

- **Tools:** the **Arguments** form, made from the tool's input schema: text, number and true/false fields, choice lists, lists
  of values (**Add item**) and nested groups. Required fields are marked `*`; the (i) next to a field shows its description and
  limits, and an empty field shows the default as a placeholder. Parts of a schema the form cannot show (for example a value
  that may have one of several shapes) get a small JSON editor of their own. **JSON** switches to the arguments as JSON text;
  the form and the text edit the same arguments, and keys the schema does not describe are kept. Choosing another tool keeps
  the arguments as they are, so clicking a tool just to read its description loses nothing (remove arguments the new tool
  does not take before running it). Before connecting (or for a tool the server does not list), the arguments are edited
  as JSON.
- **Resources:** click a resource, or type its URI. Clicking a template (for example `demo://users/{id}`) shows one field per
  `{name}` in it and builds the URI from them.
- **Prompts:** argument rows (name and value). Choosing a prompt adds a row for each argument it declares; the declared
  arguments are listed below the rows, required ones marked `*`.

**Variables and secrets.** `{{variables}}` work in the server URL, headers, authorization, command, arguments, environment
values, working directory, tool arguments, resource URI and prompt arguments; secret values are read from the keychain just
before connecting and never saved. Only the fields the transport and operation use have to resolve. In tool arguments, a
variable inside a JSON string is inserted as text (quotes and line breaks in its value are escaped, so the JSON stays valid);
a variable that stands for a whole value, such as `{"count": {{n}}}`, is inserted as it is, so with `n` = `5` the tool gets the
number 5. The form writes number and true/false fields that hold a `{{variable}}` this way. The arguments must be a JSON
object.

**The result.** The pane below has **Result**, **JSON**, **Messages** and **Logs**. Its status line shows **OK**, **Tool error**
(the tool ran and answered with `isError: true`; its error text is in the content) or **Error** (the server answered with a
protocol error, shown under *The server returned an error* with its JSON-RPC code and data; or the call or the connection
failed; or the request did not run, for example because of an undefined variable, with a **Create** button for each one), the
time, what ran, and **Copy result JSON**. The latest run counts: when it fails, the error replaces the previous result.
Warnings (for example an authorization type Slinger cannot send) show above the views. When scripts ran, **Tests** and
**Console** views follow, as for HTTP responses.

- **Result:** a tool's content, block by block: text (with Copy; very long text shows its start until **Show all**), images
  (shown), audio (offered as **Save audio to file**: Slinger does not play it), resource links (with **Copy URI**) and embedded
  resources (text shown with Copy and Save, images shown, other binary content saved to a file); other block types appear as
  JSON. A tool's **Structured content** follows as JSON. For a resource, its contents; for a prompt, its description and each
  message with its role.
- **JSON:** the whole result as the server sent it (a result above 2 MB shows its start until **Show all**).
- **Messages:** every JSON-RPC message of the tab's connection: → sent by Slinger, ← sent by the server, with the time and
  method (a response is labelled with its request's method; error responses are red), mixed with server notifications, stderr
  lines and connection events (for example why it closed). Click a row for its full JSON and Copy. Filter by kind or text;
  **Clear** empties the log (Logs too).
- **Logs:** only the server's log messages (`notifications/message`: level, logger and data) and the stderr output of a
  command (the first 64 KB per connection).

Messages and logs are kept in memory only (the last 500 events per connection) and are not saved or written to History.

### Allow this command

The first time a request would start a command (stdio), Slinger asks **Allow Slinger to run this command on this computer?**
and shows the exact command, each argument, the working directory and the environment variables you added, with variables
filled in (the value of an environment variable that comes from a secret variable is hidden). **Allow and connect**
remembers the command on this device and carries on with the connect or run; **Cancel** does nothing (Cancel has the focus, so
pressing Enter never allows a command). Slinger asks again whenever the command, an argument, the working directory or an
environment variable (a new one, a removed one or another value) is different: a variable such as `NODE_OPTIONS` or
`LD_PRELOAD` can make the same command run other code.

Why: the command is a program that runs with your user's permissions, and a request may not have been written by you. It can
arrive through a synced workspace, an imported collection or an AI assistant. So no command runs before you have seen it in
this dialog. Only the dialog can allow one: the collection runner, workflows and AI assistants get the error *This command has
not been allowed on this device yet. Open the request in Slinger and run it once to allow it.* The allowed commands are kept on
this device only (not synced or exported), as fingerprints: the command line itself, which may contain a secret, is not
stored. There is no screen yet to remove one again.

If a command such as `npx` or `uvx` is not found when Slinger was started from your desktop, enter its full path (a terminal's
`which npx` shows it): the command gets the `PATH` Slinger was started with, which can be shorter than your shell's.

### Scripts, History and running MCP requests elsewhere

- **Scripts:** pre-request and test scripts run as for HTTP requests (including collection and folder scripts). A pre-request
  script can set variables the request uses; changes it makes to `pm.request` are ignored. Test scripts see the result as a
  JSON response: `pm.response.code` is 200, or 500 with the status text "Tool error"; `pm.response.json()` is the result (for
  example its `content` or `structuredContent`); `pm.request.url` is the server URL or the command line. A protocol or
  connection error fails the send like a network error does, without running the test scripts. Test results and console
  output appear in the result pane's **Tests** and **Console** views.
- **History:** every run is a row with the **MCP** badge, what ran (for example `tools/call get_weather`) and **OK** or the
  error message instead of a status. The server URL or command line and a resource URI are recorded with secrets as
  `{{name}}` (also a secret a pre-request script copied into another variable); environment values and arguments are not
  recorded. Connecting and loading the lists are not recorded. See [History](#history).
- **Collection runner:** MCP requests run with the others; a row passes on **OK** and fails on a tool error or an error.
- **Workflows:** a **Send request** node can send an MCP request; its `body` is the parsed result.
- **AI assistants** (through [Slinger's MCP server](#ai-assistants-mcp)) can find, read, send and run MCP requests as saved, and
  rename, move and delete them, but not create or edit them or give them examples. They see the names of a command's
  environment variables, never their values, and cannot allow a command.

The runner, workflows and assistants share one connection per server, closed after 2 minutes without a call.

### Import, export, versions and sync

MCP requests are part of collection versions (**Compare** lists their changes under **MCP**) and sync like other requests (sync
conflicts show the same **MCP** row). A Postman export writes an MCP request with the method `MCP` and its settings under the
item key `_slinger_mcp`; importing the file into Slinger brings the MCP request back. Postman ignores that key, so the item is
of no use there. A `.http` export leaves MCP requests out (the file's header says how many). For an MCP request, the right
panel's **Code** view shows an **MCP Inspector CLI** command (`npx @modelcontextprotocol/inspector --cli ...`, needs Node.js)
that runs the same operation, and **Info** shows the transport and the server or command.

### Not supported yet

MCP's own OAuth discovery and dynamic client registration (for a server that needs OAuth, enter its endpoints under
Authorization > OAuth 2.0 and click **Get New Access Token**); sampling, elicitation and roots (Slinger offers none of these to
servers); resource subscriptions; completions (suggested argument values); saved examples for MCP requests; playing audio;
creating or editing MCP requests through Slinger's MCP server; using MCP requests in Postman.

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

## Mock servers

A mock server answers HTTP requests with a collection's saved examples, so you (or the app you are building) can call an API
before it exists. It runs inside Slinger on your computer and listens on `127.0.0.1` only: nothing is published, nothing syncs.

- **Start:** right-click a collection > **Mock server…**, check the port (default 4010; Slinger remembers the last port per
  collection) and click **Start**. If the port is taken by another program or mock server, the dialog says so; choose another.
  Ports below 1024 are refused (they need administrator rights).
- **Use it:** the dialog shows the base URL (`http://127.0.0.1:4010`) with a copy button. Point your requests at it, for example
  by setting `{{baseUrl}}` in an environment to that URL, or call it from any other program on this computer.
- **Matching:** a request matches an example by HTTP method and path. The scheme and host of the example's saved URL, a leading
  variable such as `{{baseUrl}}` and a trailing slash are ignored. `:id` and `{{id}}` path segments match any value; an exact
  path wins over such a wildcard (`/users/me` before `/users/:id`). HEAD requests use GET examples.
- **Several examples for one path** (e.g. *200 OK* and *404 Not found*), in this order:
  - the request can pick one with the header `x-mock-response-name: <example name>`, `x-mock-response-code: 404` or
    `x-mock-response-id: <example id>` (Postman's convention);
  - `x-mock-match-request-headers: X-Api-Version, Tenant` keeps only examples whose saved request has those headers with the
    request's values (a `{{variable}}` saved value matches any), and `x-mock-match-request-body: true` only those whose saved
    request body equals the request's; when none is left the answer is a 404 that says so;
  - **query parameters:** an example saved with `?page=2` answers requests that have `page=2`; a request without it, or with
    another page, gets an example without that parameter. A `{{variable}}` or empty value in the saved URL matches any value;
  - **request body:** when examples were saved with different request bodies (a login with the right and the wrong password),
    the one whose body equals the request's answers (JSON is compared by value, so spacing and key order do not matter; form
    fields, url-encoded or multipart, are compared by field in any order);
  - otherwise the first in the collection.
- **Answer:** the example's status, headers and body (binary examples are sent as bytes; *204*, *205* and *304* examples send
  no body). **Dynamic values** in an example's body and header values get a fresh value for every answer, with Postman's names:
  `{{$guid}}` / `{{$randomUUID}}`, `{{$timestamp}}` (Unix seconds), `{{$isoTimestamp}}`, `{{$randomInt}}` (0-1000),
  `{{$randomBoolean}}`, `{{$randomFirstName}}`, `{{$randomLastName}}`, `{{$randomFullName}}`, `{{$randomUserName}}`,
  `{{$randomEmail}}`, `{{$randomPhoneNumber}}`, `{{$randomCity}}`, `{{$randomCountry}}`, `{{$randomCountryCode}}`,
  `{{$randomStreetAddress}}`, `{{$randomCompanyName}}`, `{{$randomJobTitle}}`, `{{$randomUrl}}`, `{{$randomDomainName}}`,
  `{{$randomIP}}`, `{{$randomIPV6}}`, `{{$randomMACAddress}}`, `{{$randomPassword}}`, `{{$randomHexColor}}`, `{{$randomColor}}`,
  `{{$randomPrice}}`, `{{$randomCurrencyCode}}`, `{{$randomWord}}`, `{{$randomWords}}`, `{{$randomLoremWord}}`,
  `{{$randomLoremSentence}}`, `{{$randomLoremParagraph}}`, `{{$randomDatePast}}`, `{{$randomDateFuture}}`,
  `{{$randomDateRecent}}`, `{{$randomSemver}}` and a few more. Write `"id": "{{$guid}}"` for a string, `"count": {{$randomInt}}`
  for a number.
  An example without a `Content-Type` header gets one from its body type. When nothing matches, the answer is a 404 with a
  short JSON explanation.
- **Web apps in a browser (CORS):** a page you run on this computer (`http://localhost:5173`, `http://127.0.0.1:3000`, ...) can
  call the mock directly: it answers the browser's preflight (`OPTIONS`) and sends the CORS headers. Other websites cannot,
  unless you turn on **Allow any website (CORS)** in the dialog; leave it off otherwise, since any site you visit could then read
  the mock's answers.
- **Delay:** set **Delay** (milliseconds, up to 60 000) to answer slowly, for testing loading states. It applies at once, also
  while the server runs.
- **Edits apply live:** saving an example, adding or deleting one, or moving requests updates the running server right away.
- **Request log:** the dialog lists the latest 200 requests (time, method, path, the example that answered or *no match*, status),
  newest first. Click a row to see what was sent (query parameters, headers, body) and what was answered (status, headers, which
  example, delay, time taken), or why nothing matched. Credentials in headers (`Authorization`, cookies, API keys, tokens) are
  shown shortened. Click an example's name to open it. The trash button clears the log.
- **Stop:** **Stop** in the dialog, or in the tray menu (each running mock server is listed there with **Copy** for its URL and
  **Stop**). The status bar shows running mock servers (click to reopen the dialog). A collection's server stops when the
  collection or its workspace is deleted. Switching workspaces keeps them running.
- **Start again when Slinger starts** (on by default): mock servers that were running when Slinger quit start again, on the same
  port and with the same settings, the next time it starts. Stopping one yourself turns this off for it until you start it again.
  If its port is taken by then, Slinger says so.
- Other `{{variables}}` in examples (environment, collection) are sent as written. An example over 12 MB, or beyond 200 MB of
  examples in one collection, is left out; the rest are still served.

## Workflows

A workflow chains saved requests on a canvas: a response can feed the next request, a script, a branch or a loop, and one
click runs it all. Workflows belong to a workspace and are kept on this device only (they are not synced to Slinger Cloud and
are not part of collection exports).

- **Create:** Sidebar > **Workflows** > **+** (New workflow). It opens in a tab with a **Start** node. Right-click a workflow
  (or its **⋯** button) to rename, duplicate or delete it.
- **Build:** drag a node from the list on the left onto the canvas, or click it: with a node selected, the new node is
  placed after it and connected from its first output, so a chain builds click by click. Connect an output (right edge of a
  node) to an input (left edge) by dragging. Select a node to change it on the right; **Delete** or **Backspace** removes the
  selection. Changes are saved as you make them.
- **Nodes** (each one's (i) explains it in detail):

  | Node | What it does | Outputs |
  | --- | --- | --- |
  | Start | A run begins here, sending its JSON value (or null). | out |
  | Send request | Sends a saved request exactly like the Send button (scripts, environment, history). If the value arriving is an object, its fields fill `{{field}}` in the request. | response (`{ status, statusText, headers, body, durationMs, size }`, body parsed when JSON), error (could not send) |
  | Evaluate | JavaScript in the script sandbox; `input` is the value, `return` sends a value on. `pm`, `await` and the built-in libraries (`require('lodash')` ...) work. | out, error |
  | If | A JavaScript condition on `input`; passes the value on unchanged. | true, false |
  | For each | Sends every item of a list (an expression, e.g. `input.body.items`) in turn, each one's branch finishing first, then the list. | each item, done |
  | Delay | Waits, then passes the value on. | out |
  | Set variable | Stores a value (an expression) as a variable for the rest of the run, in the active environment or in globals, then passes the value on. | out |
  | Output | Shows what arrives, on the node and in the run log. | |

- **Run** (or Ctrl+Enter) starts at every Start node and follows the connections one step at a time. Each node shows its state
  (running, done with a ×count when it ran more than once, or failed), selecting a node shows what it received and sent last,
  and **Run log** lists every step; click an entry to find its node. **Stop** ends a run. A run uses the environment that was
  active when it started, keeps going if you close the tab, and stops when you switch workspaces.
- **Errors:** a node that fails sends `{ message }` down its **error** output when that is connected; otherwise the run stops
  there. A run also stops after 1000 steps, in case a loop (an If feeding back into an earlier node) never ends.

## Collection runner

Right-click a collection or folder and choose **Run collection...** / **Run folder...**. Pick which requests to run, set the delay
between requests (ms) and optionally **Stop on first failure**, then run. Requests run sequentially in tree order using the active
environment; each row shows status, time and, expanded, headers and a body preview. A row passes on a 2xx status only (redirects are followed first, so a remaining 3xx means the redirect did not end in a 2xx); 3xx, 4xx, 5xx and
network errors fail, unless you tick **Treat 3xx as pass**; requests with unresolved variables are skipped with the reason. You can stop a running run.
While the run is going, a small version of the loading character runs along the progress bar.
Runner requests are recorded in History. [MCP requests](#mcp-requests) run too: a row passes on **OK** and fails on a tool error
or an error.

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
- **Limits.** At most 20 `pm.sendRequest` calls per script run; a response body over 10 MB is not loaded (the call fails with
  an error saying so); only `http`/`https` URLs (a URL without a scheme gets `http://`,
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
| `pm.request.auth.type`, `.parameters().get(key)`, `.toJSON()` | read-only; the request's auth settings (for a request that inherits, its folder's or collection's) with `{{variables}}` unresolved, typed-in credentials masked, never an OAuth 2.0 token |
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

**Allowing a collection's scripts.** Scripts of a collection you made on this device run right away. A collection you
imported (Postman, Slinger export) or one that arrived through cloud sync is different: the first time one of its requests
would run a script (collection, folder or request script, from a tab, the runner or a workflow), Slinger asks **Run this
collection's scripts?** once. **Allow scripts** remembers the answer for that collection on this device only (it is not
synced or exported); **Cancel** sends nothing. A collection you extract from it or restore from one of its versions as a copy
keeps its answer. AI assistants cannot allow scripts: their sends of such a collection are refused until you allowed it here.

## History

The **History** sidebar tab lists recent requests of the current workspace grouped by day (last 200 shown; the app keeps up to 1000
per workspace), with a filter box. Click an entry to open the saved request, or a new tab pre-filled with method and URL if it was
not saved. Delete single entries or clear all. Secret values are never stored; the URL is recorded with secrets as `{{name}}`.
Cloud sync traffic is not recorded here. Changes and sends made by an AI assistant (see [AI assistants (MCP)](#ai-assistants-mcp))
are listed too, marked **AI assistant**; a change shows what was edited (for example "Edited request “Create order”: url and
headers").

Runs of [MCP requests](#mcp-requests) show the **MCP** badge, what ran (for example `tools/call get_weather`) and **OK** or the
error message instead of a status code. Clicking one opens the saved request; if it was deleted, a new MCP request opens with
the server and the operation (a command line opens as **Command (stdio)**, any URL as **Streamable HTTP**; the arguments are not
in History, so they start empty).

## Collection versions

Right-click a collection and choose **Versions...**. A version is an immutable snapshot of that collection's folders, requests,
scripts, documentation, authorization and collection variables (not environments or globals) labelled with a semantic version. There is no git
involved. Restoring a version also restores its collection variables (a version made before Slinger stored collection
variables restores the collection without any).

- **Create version:** enter `MAJOR.MINOR.PATCH` (optionally `-prerelease`, e.g. `1.2.0` or `2.0.0-beta.1`; no leading `v`, no
  build metadata) and optional notes; buttons suggest the next patch, minor and major. A label can be used once per collection.
- The list is ordered newest first by semantic-version precedence and shows folder and request counts. Each row also says who
  created the version and when (`Ana Silva · 3 h ago`; after a week the date). The detail view shows `Created by <name> · <date and
  time>`, with `(you)` after your own name. The author is the Slinger Cloud account you are signed in with when the version is made
  (also for the automatic snapshot before a Postman re-import, and for versions an AI assistant saves for you). Versions made
  while signed out, versions that were created before Slinger recorded authors and versions of an older server show the date only;
  authors from teammates need Slinger Cloud 0.4.0 or newer (an older cloud server does not send them).
  In a shared workspace everyone sees who created each version: the name comes from the cloud, so it is also right for versions
  made on another computer or by a teammate (an author whose account was deleted keeps their name).
- **Compare:** pick a version and compare it against another version or the current collection to see added, removed and changed
  requests and folders. The two sides are headed with their version, author and date.
- **Restore:** *as a new collection* named `<name> (vX.Y.Z)` (the live collection is untouched), or *replace the live collection*
  (asks for confirmation; suggests creating a version first). Replacing updates the requests and folders in place: those that
  are in the version keep their identity, so open tabs, workflow nodes, history and synced copies keep pointing at them, and
  deleted ones come back as they were; only what the version does not have is removed.
- **Delete** removes a version (it cannot be edited).
- **Versions travel with exports:** exporting a collection writes its version history into the file, and importing that file
  into Slinger (on this or another machine) restores every version with its number, notes, date and snapshot, so you can
  compare and restore them there. This works for any collection, including ones originally imported from Postman. See below.
  The author of each version is written into the file as well (name and cloud user id) and restored on import; files from an older
  Slinger simply have no authors. The author from a file is kept in a workspace that is not linked to Slinger Cloud; once a
  workspace syncs, the cloud records whoever uploaded the version and replaces it, so a teammate's imported file shows you as the
  creator after the next sync.

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

## OpenAPI

Slinger reads API descriptions in **OpenAPI 3.0 / 3.1** and **Swagger 2.0** (JSON or YAML) and keeps a collection in step with
one.

**Importing.** Open **Import** (the sidebar's import button, or File > Import) and drop or choose a `.yaml`, `.yml` or `.json`
file, paste the document, or enter its URL under **Or an OpenAPI document from a URL** and click **Load** (pasting a link that
ends in .json/.yaml or mentions openapi/swagger/api-docs works too; Slinger downloads it, not the window). The preview shows the
API's title and version, the OpenAPI version, how many operations it has, its tags, servers, auth schemes and anything that
could not be read (a reference to another file, webhooks). Choose **Folders** (by tag, by the first path segment, or none) and the
collection name, then **Import API**. The new collection opens with its overview:

- one request per operation, named after its summary (else its operationId, else `GET /path`), deprecated ones marked;
- URLs on `{{baseUrl}}` (a collection variable set to the first server URL; server variables such as `{region}` become
  collection variables too), path parameters as `:petId` path variables (see [Path variables](#path-variables)) with an
  example value, query and header parameters (the required ones
  enabled, the others present but disabled), cookie parameters as a `Cookie` header;
- the body as JSON (the document's first example, else one generated from the schema), a url-encoded form or a multipart form
  (file fields for binary properties), with `Content-Type` and `Accept` headers;
- auth from the document's security schemes: bearer (`{{bearerToken}}`), basic (`{{username}}`/`{{password}}`), API key in a
  header or the query (`{{apiKey}}`), OAuth 2.0 (authorization code with PKCE, client credentials or password, with the
  document's URLs and scopes and `{{clientId}}`); the variables are added empty, set them in the collection's variables.
  When every operation uses the same scheme it becomes the collection's authorization and the requests inherit it; otherwise
  each request gets its own. An update from a newer document changes the collection's authorization too, unless you changed it
  here (the review lists it);
- one **saved example per documented response** (several when the document names several examples), filled from the
  document's examples or generated from its schemas, so a [mock server](#mock-servers) answers right away.

Generated values are always the same for the same document (no random data), and an assistant can import too (MCP tool
`import_openapi`).

**Checking responses against the spec.** When a collection has an OpenAPI document linked on this device, every response
gets a **Spec** chip next to its status, time and size. **Matches spec** means the status, content type and JSON body are as
documented. **N spec errors** opens a list of the problems, each with where it is in the body (`$.items[0].price`) and what is
wrong, plus the operation and documented response used. A request imported from the document is matched by its operation; any
other request is matched by method and URL path. Requests that are not operations of the document show no chip. Bodies over
5 MB are not checked. In the collection runner, **Check responses against the OpenAPI spec** (on by default for linked
collections) adds a "Response matches the OpenAPI spec" test to each request that is an operation; it fails with the first
five problems and counts like a script test. In scripts, `pm.response.to.have.jsonSchema(schema[, ajvOptions])` checks the
JSON body against any JSON Schema (draft-07, as in Postman).

**Updating a collection from its document.** Right-click a collection > **OpenAPI…** to see the document it is linked to
(title, version, format, source, number of operations and import time). **Update from source** fetches a linked URL again;
for a file or a pasted document, choose the file or paste the new version. Slinger then lists what differs:

- **Added** operations are added (into the folder for their tag, created when missing) unless you choose *Skip*;
- **Changed** requests you have not edited since the import are updated unless you choose *Keep*;
- **Changed here and in the spec** requests are kept unless you choose *Take spec*;
- **Removed** operations keep their request unless you choose *Delete*;
- collection notes: a new server URL (baseUrl is updated only while it still has the old generated value), new folders and
  variables.

An update replaces only what the document defines: method, URL and query parameters, headers, body and generated examples;
auth and description only while they are still the generated ones. Your own headers, query parameters, examples, scripts,
renamed names, folder and position are kept. **Apply** first saves an automatic version (restore it under Versions… to undo),
then links the collection to the new document. Read-only workspaces can review an update but not apply it.

**Linking.** A collection without a link (made by hand, or imported on another device: the link is stored on this device only,
not synced) shows **Link a spec…**: paste a document, choose a file or enter a URL, and choose how added requests are put in
folders. Linking changes no request; the review that follows matches requests by the operation they came from, else by method
and path (`{{baseUrl}}/pets/:id` matches `GET /pets/{petId}`). **Unlink** forgets the document; the requests stay.

**Export as OpenAPI.** Choose **OpenAPI 3.1 (.yaml)** or **OpenAPI 3.1 (.json)** in the Export dialog (or **Export as
OpenAPI…** in the OpenAPI dialog) to save the collection as `<collection>.openapi.yaml` / `.openapi.json`. Each saved request
becomes an operation: the server comes from the `baseUrl` collection variable (or the URL's scheme and host), `:id` and
`{{id}}` path segments become path parameters, query/header/cookie rows become parameters, the body becomes a request body,
auth (a request that inherits: its folder's or collection's) becomes a security scheme, and the top-level folder becomes the tag. Saved examples become the responses, with JSON
Schemas inferred from their JSON; a request without examples gets a `default` response. Requests with the same method and path
are merged into one operation. Requests imported from an OpenAPI document keep their operationId and required parameters. MCP
requests, scripts, tests and versions are not exported, and `{{variables}}` stay as written.

## Import and export (Slinger and Postman)

- **Import:** open the **Import** dialog with the upload button in the Collections header (*Import collection or
  environment*), **Import…** on the empty state, or **Ctrl+K** > *Import collection or environment…*. It takes a
  **collection**, an **environment** or Postman **globals** from Slinger or Postman (collection v2.0/v2.1): Slinger exports
  (`.slinger_collection.json`, `.slinger_environment.json`), Postman exports (`.postman_collection.json`,
  `.postman_environment.json`, `.postman_globals.json`) or any other `.json`. Either drop or choose a file, or **paste the JSON**: into the
  *Or paste JSON or a cURL command* box, or press **Ctrl+V** anywhere in the dialog when no text field has focus. Whichever you gave last is
  imported. Very large pastes (megabytes) are not shown in the box; a size indicator and **Clear** stand in for them. Text you
  type into the box is checked once you pause. Invalid JSON, or JSON that is neither a collection nor an environment, shows an
  error in the dialog.
- **cURL commands:** paste one or more `curl` commands (or choose a `.sh` / `.txt` file with them) and each becomes a
  request. The preview lists them with their method, URL, a name you can change (*POST /orders* by default), what was read
  (headers, body, auth, timeout) and anything that was not imported (a proxy, a client certificate, data read from a file,
  ...). Choose the **Collection** (the one of the open request by default, or **New collection…** with a name) and, if it has
  folders, the **Folder**, then **Add request**. The request opens in a tab.
  - Read: browsers' *Copy as cURL* (bash and Windows cmd) and *Copy all as cURL* (several commands), API docs (`\` line ends,
    `$'…'` quotes, `-sSL`, `-XPOST`, `--header=…`). Other commands in the text, such as `export TOKEN=…;` or `| jq`, are skipped.
  - `-X`, `-H`, `-A` (User-Agent), `-e` (Referer), `-b` (cookies), `-d` / `--data-raw` / `--data-binary` / `--data-urlencode`
    (several joined with `&`), `--json`, `-F` / `--form-string` (form data; `@file` fields become file fields), `-T` (file
    body, PUT), `-G` (data into the query), `-I` (HEAD), `-u` (Basic auth), `--oauth2-bearer` (Bearer auth) and `-m` (timeout).
    A URL without `http://` gets it, as curl does. Options that only change how curl runs (`-s`, `-L`, `--compressed`, `-k`,
    `-v`, ...) are skipped silently.
  - Data without a `Content-Type` is url-encoded form data, as curl sends it; JSON data without one becomes a JSON body (the
    preview notes it). A copied `multipart/form-data` header is dropped, since Slinger sets its own boundary.
  - Shell variables become Slinger variables: `$TOKEN` and `${BASE_URL}` (outside single quotes) are imported as `{{TOKEN}}`
    and `{{BASE_URL}}`, so they take their values from your environment.
- **Paste into the URL bar:** pasting a whole collection or environment export, or a `curl` command, into a request's URL
  field does not put it in the URL: the Import dialog opens with it, marked *Detected pasted collection — review and import*
  (or *Detected pasted cURL command — choose where to add it*). Only an export (an object with `info` and `item[]`, or an
  environment with `values[]`, at least 200 characters) or text starting with `curl` is taken over; URLs, `{{variables}}`,
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
  settings are imported. A collection's or folder's auth stays on the collection or folder, and requests without their own auth
  inherit it (see [Collection and folder authorization](#collection-and-folder-authorization)); an access or refresh token that Postman
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
    `Automatic snapshot before re-import from <file>`), so you can get it back from **Versions...** with **Restore**. Folders
    and requests whose name (and method) match the file are updated in place and keep their identity, so open tabs, workflow
    nodes and history entries keep working; the rest are added or removed. Only the 10 newest automatic snapshots of a collection
    are kept (older automatic ones are deleted; versions you made yourself are never removed). Expanded
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
- **Export:** right-click a collection, **Export...** (or Ctrl+K, `> export collection`), then **Save to file**
  (optionally **Choose folder...** first) or **Copy to clipboard**. Only saved requests are exported. The default folder is Downloads (else your home directory). Saved examples are
  exported in each item's `response` list; examples you did not edit are written back exactly as they were imported. Scripts are
  exported as Postman `event` lists on the collection, folders and requests; scripts you did not edit are written back exactly as
  imported. Documentation is exported as the `description` of the collection, folders and requests, in the shape it was imported
  in (a string, or `{content, type}`); docs you did not edit are written back unchanged. Collection variables are exported as the
  collection's `variable` list, in order (`disabled: true` for disabled ones). Collection and folder authorization is exported
  as their `auth`; a request that inherits has no `auth`, a request with **No Auth** has `{"type": "noauth"}`, as in Postman.
  OAuth 2.0 settings are exported in Postman's format without any token. Globals and environments are never part of a collection export.
- **MCP requests** are exported with the method `MCP` and their settings under the item key `_slinger_mcp`, which Slinger's
  import reads back and Postman ignores (see [MCP requests](#mcp-requests)).
- **Export as a .http file:** in the Export dialog, set **Format** to **HTTP file (.http)** to save the collection as one
  `<collection name>.http` file for the HTTP Client of IntelliJ IDEA and other JetBrains IDEs, VS Code REST Client and other
  tools that read `.http` files. Every saved request is a `### Folder / Subfolder / Request` block, in sidebar order, written
  like the `.http` code snippet but with `{{variables}}` **unresolved** (these tools use the same syntax), so no variable value
  and no secret is written into the file. Scripts, documentation, examples and the version history are not part of it, and
  MCP requests are left out (the file's header says how many).
  Tick **Also save http-client.env.json and http-client.private.env.json** to write the variables a send would use (globals,
  collection variables, the active environment) under the active environment's name (`default` without one):
  `http-client.env.json` gets the non-secret values, `http-client.private.env.json` only the names of secret variables (and
  `oauth2_access_token` when a request uses OAuth 2.0) with empty values for you to fill in; secret values never leave the
  keychain. Both are saved next to the `.http` file and replace files of the same name there.
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
  environment as `<environment name>.slinger_environment.json`; a `.http` export as `<collection name> v<latest version>.http`. The real name is kept, including spaces, capital letters,
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

The **sync chip** next to the workspace switcher shows the sync state; click it, then **Cloud…** (**Cloud settings…** once linked)
to open the cloud panel. The chip's menu also has **Sync now**, **Auto sync** and, when there are any, the conflicts.

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

**Workspaces shared with you.** When someone adds you to a cloud workspace (in the Slinger Cloud dashboard), a banner under
the top bar says so, for example "Ana added you to the cloud workspace “Team API” as editor", the next time Slinger checks (at
sign-in, every few minutes and when you switch back to the window). **Open** downloads it into a new workspace on this device,
keeps it in sync and switches to it; **Not now** hides the banner on this device (it stays under **Your cloud workspaces** in the
cloud panel, where **Link…** opens it later). When several arrive at once, **Show** opens that list.

**Team.** A workspace you shared (people added in the Slinger Cloud dashboard), or one that was shared with you, shows as a team:
the workspace picker adds **(team)** to its name, and the **Workspaces** dialog shows **team · N members** next to it. The sync
chip's menu has **Team (N)…** (also Ctrl+K > *Team members*), which opens the member list of the cloud workspace: name (and
**You**), email, role (Owner, Admin, Editor or Viewer) and when they joined, owners first. The list is read from the cloud each
time you open it (**Refresh** reads it again; offline you get a message). The **Cloud** panel shows the size under **Team**. People
are added, removed and given a role by owners and admins in the Slinger Cloud dashboard, not in Slinger. The member count is checked
at most once a minute, with each sync (every minute while Slinger is in front, every 5 minutes otherwise), and is remembered, so
the label is right when Slinger starts offline. **Sync now** or opening **Team** updates it immediately.

**What syncs.** Collections, folders and requests (with their scripts, docs and saved examples), collection- and folder-level scripts
and documentation, collection variables, environments and their variables, globals, and collection versions. Secret values
(secret environment variables and secret globals) never leave the device: the cloud and other devices only learn the name, and a
secret that arrives from another device shows **Value not set on this device** until you enter a value here. Request history,
app settings and cloud tokens never sync. If the same variable was added on two devices before they synced (for example after
importing the same Postman collection on both), identical ones become one; different ones are both kept and yours is renamed
`<name>_conflict` (noted in the conflict history). An older cloud server that does not know collection/folder scripts and docs,
collection variables or globals simply leaves them on each device (nothing is reported); they upload by themselves once the
server is updated. Version authors need Slinger Cloud 0.4.0 or newer: an older server does not send them, so versions then show
the date only.

**Status chip.** Synced (with pending changes and last-synced time in its tooltip), Syncing (with what it is doing: *Uploading
3/12*, *Downloading 40 changes*), Offline (edits are kept and upload later), Sync error (with a Retry toast; when the server itself fails it says so, e.g.
*The Slinger Cloud server ran into an error (HTTP 500)… ask its administrator to check the server's logs and free disk space*,
and your changes stay on this device), conflicts,
Read-only, Signed out, Access revoked. Click it for **Sync now**, the **Auto sync** switch (off for a newly linked workspace: it
syncs once when you link it, then only on **Sync now**; switched on, Slinger checks for cloud changes regularly and uploads your
edits shortly after you save) and **Sync activity…**.

**Sync activity** (the chip's menu, or Ctrl+K > *Sync activity*) shows what syncs, for the open workspace:
- **Waiting to upload:** every change on this device the cloud does not have yet, marked **New**, **Edited** or **Deleted**,
  with its place (`Collection / Folder / Request`, `Environment / variable`, `Globals / variable`). It updates as you edit and
  matches the **N pending** number on the chip: that number is what the next sync would really upload, so it goes back down
  when you delete something that never reached the cloud, change an edit back, or delete a whole collection (one change, not
  one per request inside it).
  **Cancel** next to a waiting change keeps it from ever uploading: an edit goes back to the cloud's version, a new item is
  removed (with everything created inside it), and **Restore** on a deleted item brings it back (a collection or folder returns
  with what was inside it). **Cancel all** (shown when two or more wait) does it for every listed change. A confirmation
  comes first because it cannot be undone. This also works in a read-only workspace, where nothing can be uploaded anyway.
  **Keep here** holds a change on this device instead: it stays as you made it but is not uploaded, and it no longer counts
  in the chip's pending number. It moves to **Kept on this device** below, with **Upload** (it goes up with the next sync;
  **Upload all** for every kept change) and **Cancel**. Keeping a new collection, folder or environment keeps everything
  created in it too (also what you add later), and keeping a deleted collection or folder keeps the cloud's copy of its
  contents. If someone changes a kept item in the cloud, you get the usual conflict and choose which version to keep. Kept
  changes stay kept across restarts; editing a kept item back to the cloud's version ends it.
- Changes from the cloud that cannot be applied yet (for example an item whose folder has not arrived) are not lost: Slinger
  keeps them and applies them on a later sync, and if one is still waiting after a sync it shows up once in the conflict
  history as an automatically handled item. The same goes for a cloud change that failed to apply.
  **Cancel**, **Keep here** and **Upload** wait for a sync that is running to finish, so its answer cannot undo your choice.
- **Recent syncs:** each sync since Slinger started (kept while it runs, also in the tray), newest first, with its time, what
  started it (*Sync now*, *Automatic*, *First sync*), what it uploaded and downloaded, conflicts it opened, how long it took, and
  why it failed. Click a sync to see its items one by one; click a request to open it. Changes from teammates or your other
  devices show as downloads (who made them is not shown yet). **Sync now** is there too.

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

Settings (Ctrl+, or the gear icon) lists its sections at the left: **Appearance**, **Layout & window**, **Editor & tabs**,
**Scripts**, **Updates** and **AI assistants (MCP)** (it reopens on the section you used last). Explanations are behind the (i) icons.

**Appearance**

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
- **Font size** (11-20 px).

**Layout & window**

- The response **Below the request** (default) or **Beside the request** (see
  [Response below or beside the request](#response-below-or-beside-the-request)), **Show sidebar** (default on, Ctrl+B) and
  **Show status bar** (default on).
- **Keep running in the system tray when the window is closed** (on by default; macOS: menu bar; see [Layout](#layout)).
  Applies at once. Off: closing the window quits Slinger (macOS: Slinger stays in the Dock, as macOS apps do).
- **Use the system title bar** (off by default; see [Layout](#layout)). The change applies when the window reopens: **Reopen
  window** does that right away (your open tabs come back; a collection run in progress stops).
- **Title bar items:** which buttons the top bar shows, left and right, in which order, including the window's minimise,
  maximise and close buttons (Windows/Linux; they can move anywhere but not be hidden); see [Layout](#layout). Changes apply at
  once; **Reset** restores the default.

**Editor & tabs**

- **Wrap long lines in editors** (request body, response, code).
- **Restore open tabs on startup** (default on): reopens each workspace's tabs, in the same order with the same unsaved
  changes and dirty markers, the next time you start Slinger or switch to that workspace. Turning it off stops saving tabs
  and erases what is already stored; response panes are never part of what is saved or restored either way. A request's saved
  examples are not part of its kept unsaved changes: they come back from the saved request. If an unsaved change cannot be
  kept (a single tab's edits over 256 KB, or this setting off), quitting Slinger or closing its window asks first: **Quit and
  discard N unsaved changes?** with **Discard and Quit** or **Cancel** (go back and save). Installing an update asks the same
  before it restarts.

**Requests:** **Maximum response size** (MB; default 50, 1-256): larger response bodies are not loaded; see
[Reading the response](#reading-the-response) (Large responses).

**Scripts:** **Time limit per script** (default 5000 ms, 100-60000) and **Send the request even when a pre-request script
fails** (off by default).

**Updates:** **Check for new releases automatically** (default on) and **Check now**; see [Updates](#updates).

The app version is shown at the bottom of the dialog.

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

## AI assistants (MCP)

AI assistants that support the Model Context Protocol (Claude Code, Claude Desktop, Cursor, VS Code and others) can work in
Slinger for you: find and read requests, create and edit requests, folders, collections and environments, send requests, run a
collection and look at history, just as if you clicked yourself. Changes show up in the window right away, and the status bar says
"AI assistant: …" while one works.

1. Settings > **AI assistants (MCP)**. Under **Your assistants**, Slinger lists the ones it finds on this computer (Claude
   Desktop, Claude Code, Cursor, VS Code, Windsurf). Click **Connect** next to yours. That also turns the server on.
2. Do what the line under it says (for example quit and reopen Claude Desktop, or start a new Claude Code session).
3. Ask the assistant, for example "add a POST /orders request to my Shop collection and send it".

Connect writes one entry named `slinger` into that assistant's own settings file (the previous file is kept next to it as
`.slinger-backup`; Claude Code is set up through its `claude mcp` command). The entry holds no password or port: it starts a
small helper from Slinger's data folder that finds them, and **if Slinger is not running, it starts Slinger** and waits for it
(unless you quit Slinger yourself: then it stays closed, and assistants are told to open it).
So nothing breaks when the port changes or you make a **New token**. **Disconnect** removes the entry again; **Update** appears
when an entry points to another Slinger installation. Slinger only touches these files when you click.

The server listens only on this computer (port 7354, or one of the next ten when that one is taken) and needs a token that only
connected assistants and you can read. Turning **Let AI assistants work in Slinger** off stops it at once (connected assistants
then get a "turned off" message instead of starting Slinger). For assistants Slinger cannot connect by itself, open **Other
assistants and advanced**: copy a ready-made command setup (works with any assistant that runs a command) or a URL + token setup
(keep that one private), and change the port or token.

Assistants can find, read, send and run [MCP requests](#mcp-requests) as saved (and rename, move or delete them), but cannot
create or edit them, and a command (stdio) runs only after you allowed it in the window.

Assistants read and set a request's [path variables](#path-variables) too (`path_variables` in `get_request`,
`create_request`, `update_request` and, for one send, `send_request`).

Assistants can also read, add, edit and delete a request's **saved examples**, and keep a real response as an example when they
send. They can save a **collection version** (a number like 1.4.0, or the next patch / minor / major), see what changed since a
version, and restore one as a copy or in place (assistants that ask before destructive actions ask you first). Everything an assistant changes or sends appears in **History** with an **AI assistant** badge (changes show what was
edited, never a value); clicking a change of a request opens it.

What assistants can and cannot see: everything in your workspaces except secret values. They can create secret variables and
change their values, and requests they send use them inside Slinger, but a secret value is never shown to them; credentials typed
literally into a request's authorization are hidden too (use `{{variables}}`). In what a send returns to an assistant (response
body and headers, console output, test results, errors) the send's secret values, credentials and OAuth 2.0 tokens appear as
`{{name}}`, `[hidden]` or `<access token>`, so a server that echoes your token back does not hand it to the assistant.

**What an assistant may send with your credentials.** Your credentials (secret variables, a request's saved authorization or
the authorization it inherits from its folder or collection, OAuth 2.0 tokens) go out with an assistant's send only when it sends a request **you** saved, **as you saved it**. It is
refused, with a message the assistant can pass on to you, when the send would carry them and:

- it is an ad-hoc request, or the assistant changes the URL, headers, body, auth or scripts for this one send;
- the assistant created or edited the request and you have not saved it since (open it and press **Save**, Ctrl+S, after
  checking it; a request the assistant created may still use authorization the assistant typed in itself, or a collection or
  folder authorization that came with an assistant's import or restore, until you change or save that authorization);
- the request's host comes from an environment variable the assistant set and you have not changed since (edit the value in
  the environment, even to the same text, to confirm it).

A secret variable the assistant set itself holds its own value, so it may use that one. Scripts in such sends cannot read
secret variables. You can always send the request yourself from its tab. Sends and runs work in the workspace that is open in
the window (an assistant can open another one with "Show in Slinger"). An assistant's deletes are the same as yours, so keep an
eye on what it does to important collections (a collection version is a good backup before big changes).

## Updates

Each time Slinger starts (a few seconds after its window opens) and once a day while it runs, it asks GitHub in the background
which version is the latest release of Slinger. When there is a newer one than yours, a notification says so with **Update
now**: at every start while you have not installed it, and once per version during the day. The request carries nothing about you or your data, and nothing is
downloaded until you click.

- **Update now** opens **Update Slinger**, which first shows what is new in that version (or a link to its release notes on
  GitHub). It downloads the new version for your system from GitHub with a progress bar (size,
  speed, time left; **Cancel** stops it, **Hide** lets it continue in the background) and checks it against GitHub's
  checksum. Then **Restart to update** checks the file again (an installer that changed since the download is refused) and
  installs it and starts Slinger again; your open tabs come back. **Later** keeps the
  download: Settings > Updates then offers **Restart to update**.
- How it installs:
  - Linux, installed from the **.deb**: with your system's package manager (`pkexec dpkg`), which asks for your password in a
    system dialog. Cancelling that dialog cancels the update; Slinger keeps running.
  - Linux **AppImage**: the AppImage file is replaced with the new one (its folder must be writable).
  - **Windows**: the installer runs in the background (Windows may ask for permission) and starts Slinger again.
  - **macOS**: after Slinger quits, the new Slinger.app replaces the old one (its folder, usually Applications, must be writable).
- Where Slinger cannot update itself (a development build, a copy not installed from the .deb or the AppImage, an unwritable
  folder), the notification and Settings offer **View release** instead, and the dialog says why.

- **Help > Check for Updates…** checks right away and always answers (up to date, a newer version, or why it could not check).
- Settings > Updates: turn **Check for new releases automatically** off, or **Check now**; it shows the result and when Slinger
  last checked, and **Update now** (or the download progress, or **Restart to update**) when there is a newer version.
- The update check is the only network request Slinger makes on its own; see the [privacy policy](../PRIVACY.md).
- **Windows:** signed releases (publisher *SignPath Foundation*, see the [code signing policy](CODE_SIGNING.md)) let Windows
  tell where the installer comes from. A new release can still show a SmartScreen notice ("Windows protected your PC") until
  Windows has seen enough downloads of it, and unsigned ones always do: **More info > Run anyway**.

## Release notes

**Help > Release Notes** (or Ctrl+K, then `release notes`, or **Release notes** in About Slinger) shows what changed in every
version of Slinger: new features, improvements and fixes. The notes ship with the app, so they work offline.

The first time a new version starts after an update, **What's new** opens by itself with the notes of every version since the
one you had (**All release notes** shows the rest; **Close** dismisses it). It does not open on a fresh install or on later
starts of the same version.

## About Slinger

The question-mark icon at the right of the top bar (or Ctrl+K, then `about`) opens **About Slinger**:

- The app version, **Release notes** (see [Release notes](#release-notes)) and **Copy version info**, which copies the Slinger, Electron, Chromium, Node and V8 versions and the OS
  (name, release, architecture) for a bug report. Nothing else is included: no host name, user name, paths or data.
- The developer, and links to the source code, releases, the issue tracker, the licence and the cloud server. Links open in your
  web browser.
- Why Slinger exists and **The Sling Manifesto** (also in the [README](../README.md#manifesto)).
- **Acknowledgements:** the open-source projects Slinger is built on, with versions and licences (expand "Standing on the shoulders
  of"; each name links to the project). Installed apps also include their full licence texts in `THIRD_PARTY_LICENSES.txt` in the
  app's resources folder.

## Menus

Slinger has its own menus: on macOS in the menu bar at the top of the screen; on Windows/Linux behind the menu button at
the left of the title bar (or in the menu bar, with the system title bar).

| Menu | Items |
| --- | --- |
| **Slinger** (macOS only) | About Slinger, Settings… (Cmd+,), Services, Hide Slinger, Hide Others, Show All, Quit Slinger |
| **File** | New Request (Ctrl+T), Close Tab (Ctrl+W), Import…, Export Collection…; on Windows/Linux also Settings… (Ctrl+,) and Exit/Quit (Ctrl+Q on Linux) |
| **Edit** | Undo, Redo, Cut, Copy, Paste (macOS: Paste and Match Style), Delete, Select All |
| **View** | Toggle Sidebar (Ctrl+B), Toggle Response Position (Ctrl+Alt+V), Toggle Right Panel (Ctrl+Alt+B), Toggle Status Bar, Actual Size (Ctrl+0), Zoom In (Ctrl+=), Zoom Out (Ctrl+-), Toggle Full Screen |
| **Window** (macOS only) | Minimize, Zoom, Close Window (Shift+Cmd+W), Bring All to Front |
| **Help** | User Guide, Keyboard Shortcuts (Ctrl+/), Release Notes, Check for Updates…, Report an Issue, View License; on Windows/Linux also About Slinger |

- **Export Collection…** exports the collection of the active tab (a request or a collection/folder overview). With no such tab
  open, Slinger tells you how to pick one; you can also use Export in a collection's menu in the sidebar.
- **New Request** opens an HTTP request; an MCP request is created from a collection's or folder's menu in the sidebar (see
  [MCP requests](#mcp-requests)).
- **Close Tab** (Ctrl/Cmd+W) closes the request tab, never the window. On macOS, Close Window is Shift+Cmd+W.
- The zoom level is remembered for the next launch.
- Help links open in your web browser.
- Menu items for dialogs do nothing while another dialog is open (Settings and Keyboard Shortcuts still open), the same as the
  keyboard shortcuts.
- Development builds also show Reload and Toggle Developer Tools under View.

## Right-click menus

Right-click menus are shortcuts to actions that also have a button, a key or a menu entry elsewhere, plus copying. Where the
item can take keyboard focus, **Shift+F10** or the **Menu** key opens the same menu; the arrow keys move, Enter chooses,
Escape closes.

| Where | Items |
| --- | --- |
| Collections tree: collection, folder, request, example | see [Collections, folders and requests](#collections-folders-and-requests) and [Saved examples](#saved-examples) |
| Request tabs | Close, Close others, Close to the right, Close all, Save, Copy URL, Copy as cURL |
| History entry | Open, Copy URL, Delete |
| Environments list (Manage environments) | Set active, Rename…, Duplicate, Export…, Delete… |
| Response body | Copy (the selected text), Copy response body, Save response to file…, Search in response |
| Response headers / cookies row | Copy (the selected text), Copy name, Copy value, Copy as "Name: value" / "name=value" |
| Collection versions list | Copy version number, Restore…, Delete… |
| Workflows list | Open, Rename…, Duplicate, Delete… |
| Workflow canvas node | Open request (Send request nodes), Delete node |
| Title bar, status bar (run and mock server items) | see [Layout](#layout) |

Text fields (the URL bar, key/value tables, variables, editors) get the usual Undo / Redo / Cut / Copy / Paste / Select all
menu, and selected text elsewhere gets Copy. Pasting a cURL command into the URL bar this way still opens the import.

## Keyboard shortcuts

Taken from the shortcut handler and the in-app list (Ctrl+/):

| Shortcut | Action |
| --- | --- |
| Ctrl+Enter | Send the current request (in an MCP request: Run; in a workflow tab: run the workflow) |
| Ctrl+S | Save the current request (Save as, if it is not saved yet); workflows save themselves as you edit |
| Ctrl+T | New request tab |
| Ctrl+W | Close the current tab |
| Ctrl+K | Go to request; type `>` for commands (switch theme, accent or loading animation; layout; export a collection or an environment; About Slinger) |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous tab |
| Ctrl+Alt+V | Show the response below / beside the request |
| Ctrl+B | Show / hide the sidebar |
| Ctrl+Alt+B | Show / hide the right panel |
| Ctrl+, | Settings |
| Ctrl+/ | Show or hide the shortcut list |
| Enter (in a table cell) | Move to the cell below |
| F2 / Delete (in the tree) | Rename / delete the selected item |

While a dialog is open, only Ctrl+, and Ctrl+/ are handled globally.
