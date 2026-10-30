# Release notes

What changed in each version of Slinger, newest first. Slinger shows these notes in the app (Help > Release Notes, and
once after an update), and each GitHub release uses its version's section.

## 0.30.0 — unreleased

- (filled in at release)

## 0.29.0 — 2026-10-30

### New
- **Cookie jar**: cookies a server sets are kept per workspace and sent on later requests, also across redirects, so logging in once works for the requests after it (runner, workflows and `pm.sendRequest` share it). Values are encrypted on disk and never synced or exported. Manage them in the new **Cookies** dialog (Ctrl+K, or **Manage cookies…** in a response's Cookies view); scripts can use `pm.cookies.jar()` for domains you allow there.
- **Settings > Network**: proxy (your system proxy by default, a custom proxy with login and bypass list, or none), SSL certificate verification, extra CA certificates, and client certificates per host (PEM or PFX).
- **Request Settings**: per request SSL verification, follow redirects, maximum redirects, keep the original method or the Authorization header on redirects, remove Referer, and disable the cookie jar. Postman's request settings are imported and exported.

### Improved
- Redirects are listed in the response, and certificate and proxy errors say what is wrong and which setting to change.
- Requests now use your system proxy, as a browser does (switch it off in Settings > Network).

## 0.28.0 — 2026-10-27

### New
- Code snippets are syntax-highlighted in every language: cURL, Python, Go, PHP, PowerShell and `.http` files (before, only the JavaScript ones were), and so is the MCP Inspector command.
- YAML and Markdown responses are highlighted in Pretty view.

### Improved
- Auto sync is off for a newly linked workspace: it syncs once when you link it, then when you click **Sync now**, until you switch Auto sync on. Workspaces you linked before keep their setting.
- Exported files and saved responses are written in one step, so another program never sees a half-written file.

## 0.27.1 — 2026-10-26

### Improved
- Windows: every installer is now installed, started and uninstalled on a real Windows machine before release (secrets in Windows Credential Manager, one Slinger per user, silent install and uninstall), and the release workflow is ready to sign the installer and Slinger.exe for free through SignPath Foundation, so Windows SmartScreen can recognise the publisher once signing is approved.
- The Windows installer shows a short privacy summary: the update check is the only thing Slinger sends on its own, and you can turn it off in Settings > Updates.
- New [privacy policy](https://github.com/perunok/slinger/blob/master/PRIVACY.md) and [code signing policy](https://github.com/perunok/slinger/blob/master/docs/CODE_SIGNING.md).

## 0.27.0 — 2026-10-26

### New
- **Path variables**: `:name` segments in a URL (`/pets/:petId`) get a Path Variables table under Params and are filled in when sending, as in Postman. Requests imported from OpenAPI or Postman with path parameters now send correctly.
- **Collection and folder authorization**: set auth once on a collection or folder; requests choose **Inherit auth from parent** (the default for new requests). Postman and OpenAPI imports keep auth on the collection/folder instead of copying it into every request. Syncs with Slinger Cloud 0.5.0 or newer.
- **Release notes in the app**: Help > Release Notes (also in About and Ctrl+K), a What's new dialog once after each update, and the update dialog shows the new version's notes before you install.
- **Right-click menus** in History, the environments list, the response body, response headers and cookies, collection versions and workflow nodes; the sidebar and request tabs gain Copy URL, Copy as cURL and Close to the right. Text fields get the usual Cut / Copy / Paste menu.
- **Maximum response size** (Settings > Requests, default 50 MB): a larger response shows its status and headers with **Send and download to file**, which streams the body straight to disk.

### Improved
- AI assistants (MCP) can no longer send your saved credentials or secrets anywhere you did not set up: a request that carries them can only be sent as you saved it, and secret values are removed from everything returned to the assistant.
- Scripts in a collection you imported or received through sync ask once before they run. Collections you already have are trusted.
- An OAuth 2.0 token is tied to the host it was first sent to; sending it to another host asks you first.
- Quitting asks before discarding unsaved changes that cannot be restored next time; saved examples no longer make a draft too large to keep.
- Version restore and Postman re-import update the existing requests instead of replacing them, so open tabs, workflows and history links keep working. Only the last 10 automatic safety versions per collection are kept.
- Environment variables detect changes made elsewhere (another window or device) instead of overwriting them.

### Fixed
- A new device could miss folders (and everything in them) when it first downloaded a cloud workspace. Changes that cannot be applied yet are now kept and retried instead of being skipped.
- Cancelling or keeping a waiting change while an upload was running could leave this device and the cloud out of step.
- Open tabs and unsaved drafts could be lost when a workspace was slow to load.
- A send that was still running when you switched workspace or environment could use the other one's variables.
- Pressing Ctrl+S twice quickly showed a false "changed elsewhere" conflict.
- Error messages and History no longer contain secret values from the URL or headers.
- The updater checks the downloaded installer again right before installing it.
- Arrow keys in right-click menus with separators could highlight a different item than Enter ran.

## 0.26.0 — 2026-10-26

### Improved
- When the Slinger Cloud server fails, sync now explains what happened (server error, not answering, asked to slow down) instead of showing "internal server error", and says your changes are kept on this device.

## 0.25.1 — 2026-10-26

### Fixed
- URLs typed without `http://` or `https://` work everywhere, as in Postman: requests, the cloud server address, MCP requests, OAuth 2.0 URLs and OpenAPI document URLs. Port 443 means https; `//host/path` is sent correctly.

## 0.25.0 — 2026-10-25

### New
- The full set of dynamic variables mock servers already had now works in requests and scripts too: about 55 of Postman's `{{$random…}}` names (names, addresses, prices, dates, lorem ipsum, IPv6 and more) plus `{{$date}}`, `{{$time}}` and `{{$randomString}}`. Autocomplete and the hover card list them all.

### Improved
- `{{$randomInt}}` now gives 0–1000 and `{{$randomEmail}}` a `first.last@example.com` address, as in Postman.

## 0.24.1 — 2026-10-25

### Improved
- Slinger checks for a new release in the background every time it starts, and reminds you of an available update at each start until it is installed.

## 0.24.0 — 2026-10-25

### New
- OpenAPI: import an OpenAPI 3.0/3.1 or Swagger 2.0 document (file, paste or URL) as a collection, with a saved example per documented response, so mock servers work at once.
- Responses are checked against the document: a Spec chip shows "Matches spec" or the errors, the runner can check every response, and scripts get `pm.response.to.have.jsonSchema`.
- Collection menu > OpenAPI…: update a collection when its document changes, reviewing each added, changed or removed operation; link an existing collection to a document.
- Export any collection as OpenAPI 3.1 (YAML or JSON).
- AI assistants can import OpenAPI documents over MCP.

## 0.23.0 — 2026-10-25

### New
- Sync activity: **Keep here** holds a waiting change on this device so it is not uploaded; release it later with **Upload**.
- Mock servers support Postman's `x-mock-response-name`, `x-mock-response-id` and `x-mock-response-code` headers and dynamic variables in responses.

### Improved
- Faster startup, and big collections (thousands of requests) scroll, filter and open quickly.

### Fixed
- Many mock server fixes: form bodies match by field, one oversized example no longer stops the whole collection, stopping a server while it starts works, repeated headers are kept.

## 0.22.0 — 2026-10-23

### New
- Sync activity: cancel waiting changes so they are never uploaded (an edit goes back to the cloud's version, a new item is removed, a deleted one comes back), one by one or all at once.

## 0.21.1 — 2026-10-22

### Fixed
- The sync chip's pending count goes down again when you delete something or change it back, instead of only growing until the next sync.

## 0.21.0 — 2026-10-21

### New
- Shared workspaces show as Team, with the member count; the Team dialog lists everyone in the cloud workspace.
- Collection versions show who created them (needs Slinger Cloud 0.4.0).

## 0.20.0 — 2026-10-14

### New
- Update Slinger from inside the app: **Update now** downloads the new version with progress, checks it, and **Restart to update** installs it. Your open tabs come back.

## 0.19.0 — 2026-10-12

### New
- Sync activity: see every change waiting to upload and what each recent sync uploaded and downloaded. The sync chip shows progress while syncing.

## 0.18.0 — 2026-10-12

### New
- Mock servers: serve a collection's saved examples on a local port, with query and body matching, CORS for local web apps, a delay, a request inspector, and restart with Slinger.
- Import cURL commands: paste one or more into the Import dialog (or into the URL bar) and add them to a collection.
- AI assistants can list, create, compare and restore collection versions over MCP.

### Improved
- Only one Slinger runs per user; starting it again brings the running window forward.

## 0.17.0 — 2026-10-10

### New
- MCP requests: connect to any MCP server (HTTP, SSE or a local command), browse its tools, resources and prompts, and call them, saved in collections like any request.

## 0.16.0 — 2026-10-10

### New
- Closing the window keeps Slinger running in the system tray, so assistants, runs and sync go on. Turn it off in Settings > Layout & window.

### Improved
- Quitting while an AI assistant is working lets its calls finish first.

## 0.15.0 — 2026-10-10

### New
- AI assistants can read and edit saved examples, and save a response as an example.
- History shows the changes an AI assistant made, marked with an "AI assistant" badge.

## 0.14.0 — 2026-10-10

### New
- MCP server: AI assistants (Claude Code, Claude Desktop, Cursor, VS Code and others) can browse, edit, send and run your requests. Turn it on and connect an assistant in one click in Settings > AI assistants.

## 0.13.0 — 2026-10-09

### New
- A banner tells you when someone adds you to a Slinger Cloud workspace, with **Open** to download it.

### Fixed
- The HTTP method dropdown shows each method in its own colour, and dropdown lists follow the theme.

## 0.12.0 — 2026-10-03

### New
- `.http` files for the IntelliJ HTTP Client and VS Code REST Client: copy or save a request, or export a whole collection.
- Arrange the title bar: choose which items it shows, on which side, including the window buttons.
- Ctrl+B shows or hides the sidebar.

### Improved
- Settings are organised in sections.

## 0.11.0 — 2026-10-03

### New
- Workflows: chain saved requests on a visual canvas with conditions, loops, delays, variables and code.

## 0.10.0 — 2026-10-03

### New
- Slinger tells you when a new release is out (Help > Check for Updates…, Settings > Updates).
- Custom title bar: the top bar is the window's title bar, with a menu button on Windows and Linux. Settings can switch back to the system title bar.

## 0.9.0 — 2026-10-01

### New
- Collection runs can go on in the background while you keep working; the status bar shows their progress.
- Edit a variable's value straight from its `{{placeholder}}` hover.

### Improved
- A run keeps the environment it started with.

### Fixed
- Typing a delay in the runner no longer crashes the dialog.

## 0.8.0 — 2026-09-30

### New
- The collection runner follows `pm.execution.setNextRequest` (and `postman.setNextRequest`), so Postman collections that steer their runs work.

### Fixed
- The Windows and macOS builds of 0.7.0 failed to build.

## 0.7.0 — 2026-09-28

### New
- Custom themes: write your own theme as CSS tokens or with a form editor, and import or export it.
- Layout: put the response beside or below the request, a status bar, and a right side panel with Variables, Docs, Code and Info.
- Collection and folder scripts and docs, collection variables and globals sync with Slinger Cloud.

## 0.6.0 — 2026-09-27

### New
- OAuth 2.0 authorization (authorization code with PKCE, client credentials, password); tokens are kept in the system keychain.
- Collection variables and globals are saved, with Postman's precedence.
- Open tabs come back after a restart, and each workspace keeps its own tabs.
- `install.sh` installs on macOS too and adds a `slinger` terminal command.

### Improved
- A warning when a request is too big to sync.

### Fixed
- The Versions dialog's compare view scrolls instead of cutting off long lists.

## 0.5.2 — 2026-09-26

### New
- Application menu (File, Edit, View, Help) with zoom that is remembered.

## 0.5.1 — 2026-09-26

### New
- About Slinger: version (with Copy version info), credits, the Sling Manifesto and open-source acknowledgements.

## 0.5.0 — 2026-09-25

### New
- One Import dialog for files and pasted text; pasting a collection into the URL bar opens it.

### Improved
- A themed placeholder shows while Slinger starts, and the window remembers its size and position.

## 0.4.1 — 2026-09-25

### Improved
- The loading animation spans the whole response pane.

## 0.4.0 — 2026-09-25

### New
- Export a collection with its version history and re-import it, and export environments.
- Re-importing a collection offers to replace it or import a copy.
- A loading animation while a request is in flight.

## 0.3.2 — 2026-09-25

### Improved
- Environment names are unique per workspace; importing an environment with an existing name merges into it.

## 0.3.1 — 2026-09-25

### New
- Scripts can send requests with `pm.sendRequest`.

### Fixed
- Notifications no longer block dialog buttons.

## 0.3.0 — 2026-09-25

### New
- Documentation in Markdown for requests, folders and collections, with an editor and preview.
- 31 themes and 18 accent colours, with a gallery in Settings and Ctrl+K commands.
- Postman's built-in script libraries (crypto-js, lodash, moment, chai and more).

## 0.2.0 — 2026-09-25

### New
- Pre-request and test scripts with Postman's `pm` API, at request, folder and collection level, run in a sandbox.

### Fixed
- The app icon shows on Linux.

## 0.1.0 — 2026-09-25

### New
- First release: requests, collections and folders, environments with secrets in the system keychain, history, saved examples, Postman import and export, collection versions, cloud sync with Slinger Cloud, and installers for Linux, Windows and macOS.
