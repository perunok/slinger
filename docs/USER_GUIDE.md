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

- **New collection** (plus button), then right-click a collection for **New request**, **New folder**, **Run collection...**,
  **Versions...**, **Export as Postman JSON...**, **Rename**, **Delete**.
- Right-click a folder for **New request**, **New subfolder**, **Run folder...**, **Rename**, **Delete**.
- Right-click a request for **Open**, **Duplicate**, **Rename**, **Delete**.
- Drag and drop to reorder or move folders and requests (a folder cannot be dropped into itself or its own subfolders).
- In the tree, F2 renames and Delete deletes the selected item. Deleting asks for confirmation and cannot be undone from the UI.

## Requests

Ctrl+T opens a new tab. The URL bar has the method selector, the URL, **Send** (Ctrl+Enter, becomes cancel while running) and
**Save** (Ctrl+S). Saving a request that is not in a collection yet asks where to put it ("Save as").

The editor sections are **Params**, **Authorization**, **Headers**, **Body**, **Docs**, **Settings** and **Code**.

- **Params:** query parameters as a table; edits stay in sync with the URL. Disabled rows are kept but not sent.
- **Headers:** a key/value table. "Auto-generated headers" lists headers Slinger adds by itself (for example `Content-Type` from
  the body mode and `User-Agent: Slinger`); a header you set yourself wins.
- **Body:** `none`, `form-data` (text and file fields; pick files with the native dialog; a saved file must be chosen again after restarting the app: the field then shows "file not granted"), `x-www-form-urlencoded`, `raw`
  (JSON, XML, Text, HTML, JavaScript; **Beautify** formats JSON) and `binary` (send one file). GET and HEAD requests cannot have
  a body.
- **Authorization:** No Auth, Basic Auth, Bearer Token, or API Key (added to a header or as a query parameter). Fields accept
  `{{variables}}`. Imported Postman requests with other auth types (for example OAuth 2.0) are sent without authorization and a
  warning says so; OAuth 2.0 is not implemented.
- **Docs:** free-text description stored with the request (exported to Postman).
- **Settings:** per-request timeout in milliseconds (default 60 000, maximum 600 000).
- **Code:** generates a snippet for the current request in cURL, JavaScript (fetch), JavaScript (axios), Python (requests), Go
  (net/http), PHP (cURL) or PowerShell, with a Copy button. Unresolved variables are left as-is in snippets.

Tabs: right-click a tab for Close / Close others / Close all / Save. Ctrl+W closes, Ctrl+Tab and Ctrl+Shift+Tab cycle. A tab
with unsaved edits shows a marker, and closing it asks before discarding. If a saved request changed underneath you (for
example in another window), Save reports "Request changed elsewhere" and lets you **Reload from stored** or **Overwrite**.
Open tabs are not restored after restarting the app. **Go to request** (Ctrl+K) searches saved requests.

## Variables and environments

Use `{{name}}` in the URL, headers, params, body, form fields and auth. Recognized names are highlighted; hover for the value
(secrets show as bullets), type `{{` for autocomplete, and unknown names offer to create the variable. A value can itself
reference other variables. If anything is unresolved when you press Send, the request is not sent and the response pane lists the
missing names ("define it in the active environment").

**Environments.** Click the gear next to the environment switcher (or use the switcher) to open the Environments dialog: create,
rename, duplicate and delete environments, **Set active**, and edit variables in a table (or **bulk edit** as text). Changes
save automatically with a status indicator. The active environment is remembered per workspace. Variable names are unique
within an environment.

**Secret variables.** Tick **Secret** on a variable to store its value in your operating system keychain instead of the
database. The table then shows masked bullets; use the reveal control to look at it, and leave the value empty when editing to
keep the stored one. Secrets are never written to history, exports or version snapshots. If no keychain is available (typical on
headless Linux without a Secret Service) saving a secret fails with an error while everything else keeps working.

**Built-in dynamic variables** (generated fresh at each send, same value wherever repeated within one send):
`{{$guid}}` and `{{$randomUUID}}` (UUID v4), `{{$timestamp}}` (Unix seconds), `{{$isoTimestamp}}`, `{{$date}}` (UTC),
`{{$time}}` (UTC), `{{$randomInt}}` (0-999999), `{{$randomString}}`, `{{$randomBoolean}}`, `{{$randomEmail}}`.

## Reading the response

After Send the pane shows status, time and size. Views: **Pretty** (formatted, foldable JSON/XML/HTML; CSV as a table), **Raw**
(hex preview for binary content), **Preview** (HTML in a fully sandboxed frame, images, PDF), **Headers** and **Cookies**
(parsed from `Set-Cookie`). Toolbar: search in response, toggle word wrap, copy body, **Save response to file** (to the export
folder). Non-2xx responses are shown normally; network errors, timeouts and cancellations appear as inline errors.

## Collection runner

Right-click a collection or folder and choose **Run collection...** / **Run folder...**. Pick which requests to run, set the delay
between requests (ms) and optionally **Stop on first failure**, then run. Requests run sequentially in tree order using the active
environment; each row shows status, time and, expanded, headers and a body preview. A row passes on a 2xx status only (redirects are followed first, so a remaining 3xx means the redirect did not end in a 2xx); 3xx, 4xx, 5xx and
network errors fail, unless you tick **Treat 3xx as pass**; requests with unresolved variables are skipped with the reason. You can stop a running run.
Runner requests are recorded in History.

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

## Import and export (Postman)

- **Import:** use the upload button in the Collections header (or **Import from Postman** on the empty state). Drop or choose a
  Postman **collection (v2.x)** or **environment** `.json`. The preview shows what will be imported. Collection-level variables
  can optionally become a new environment; collection-level scripts and tests are not imported (request scripts are kept in the
  stored document but never run). Postman "globals" files are rejected; export an environment instead. Disabled environment
  variables are skipped.
- **Export:** right-click a collection, **Export as Postman JSON...**, then **Save to file** (optionally **Choose folder...**
  first) or **Copy to clipboard**. Only saved requests are exported. The default folder is Downloads (else your home directory).

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

Settings (Ctrl+, or the sun icon): **Theme** (System, Light, Dark, Midnight, Solarized Dark, High Contrast; System follows your OS
light/dark setting), **Font size** (11-20 px) and **Wrap long lines in editors**. The dialog also shows the app version.

## Keyboard shortcuts

Taken from the shortcut handler and the in-app list (Ctrl+/):

| Shortcut | Action |
| --- | --- |
| Ctrl+Enter | Send the current request |
| Ctrl+S | Save the current request (Save as, if it is not saved yet) |
| Ctrl+T | New request tab |
| Ctrl+W | Close the current tab |
| Ctrl+K | Go to request |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous tab |
| Ctrl+, | Settings |
| Ctrl+/ | Show or hide the shortcut list |
| Enter (in a table cell) | Move to the cell below |
| F2 / Delete (in the tree) | Rename / delete the selected item |

While a dialog is open, only Ctrl+, and Ctrl+/ are handled globally.
