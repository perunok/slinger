import { app, BrowserWindow, dialog, nativeTheme, net, powerMonitor, protocol, screen, session, shell } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { hostname } from 'node:os'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IPC_EVENT_CHANNELS } from '../shared/ipc-contract'
import { openDatabase, type Db } from './db/database'
import { registerIpcHandlers } from './ipc/handlers'
import { createIpcApi } from './ipc/api'
import { contentSecurityPolicy } from './lib/csp'
import { ioError } from './lib/errors'
import { migrateLegacyDataDir } from './lib/legacyDataDir'
import { isPermissionAllowed } from './lib/permissions'
import {
  clampBounds,
  DEFAULT_BACKGROUND,
  DEFAULT_SIZE,
  MIN_SIZE,
  readWindowState,
  WINDOW_STATE_FILE,
  writeWindowState,
  type WindowState,
} from './lib/windowState'
import { createCore, type Core } from './services/core'
import { assertExternalUrl } from './services/externalUrl'
import { KEYCHAIN_SERVICE, KeychainSecretStore } from './services/secrets'
import { WorkerExecutor } from './scripts/executor'

const APP_SCHEME = 'app'
const APP_ORIGIN = `${APP_SCHEME}://slinger`
const devServerUrl = process.env.SLINGER_DEV_SERVER_URL || null

// Tests and CI can point the app at a throwaway data directory.
if (process.env.SLINGER_USER_DATA_DIR) app.setPath('userData', process.env.SLINGER_USER_DATA_DIR)
else {
  // package.json productName ("Slinger") makes dev and packaged builds share one profile directory.
  // Older dev runs used the lowercase "slinger"; move that profile over once.
  migrateLegacyDataDir(join(app.getPath('appData'), 'slinger'), app.getPath('userData'))
}

// Must run before app 'ready'. A standard+secure scheme gives the renderer a real origin
// (instead of file://) so we can attach response headers such as the CSP.
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

let mainWindow: BrowserWindow | null = null
let core: Core | null = null
let db: Db | null = null
let windowState: WindowState = {}
const windowStateFile = () => join(app.getPath('userData'), WINDOW_STATE_FILE)
/** Automated runs (smoke test, e2e) use a hidden/off-screen window: never remember its geometry. */
const automatedWindow = () => !!(process.env.SLINGER_SMOKE_TEST || process.env.SLINGER_HIDE_WINDOW)

// SLINGER_STARTUP_TIMING=1 prints one `STARTUP_TIMING {...}` line: main-process milestones (ms since process start)
// and the renderer's own marks (ms since navigation start; see src/app/bootSkeleton.ts).
const startupTiming = process.env.SLINGER_STARTUP_TIMING ? ({} as Record<string, number>) : null
const timeMark = (name: string) => {
  if (startupTiming) startupTiming[name] = Math.round(performance.now())
}

const isTrustedUrl = (url: string): boolean =>
  url.startsWith(`${APP_ORIGIN}/`) || (devServerUrl !== null && url.startsWith(devServerUrl))

function loadKeychain(): KeychainSecretStore {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Entry } = require('@napi-rs/keyring')
    // Automated runs (e2e) give every profile its own keychain service so two profiles on one machine never share secrets.
    const namespace = process.env.SLINGER_KEYCHAIN_NAMESPACE?.trim()
    return new KeychainSecretStore(Entry, namespace ? `${KEYCHAIN_SERVICE}.${namespace}` : undefined)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    // Keep the app usable; only secret operations fail (with a clear io_error).
    return new KeychainSecretStore(
      class {
        constructor() {
          throw ioError(`OS keychain is unavailable: ${reason}`)
        }
        getPassword(): string | null {
          return null
        }
        setPassword(): void {}
        deletePassword(): boolean {
          return false
        }
      },
    )
  }
}

/**
 * Script sandbox workers. The bundle is read as text and started with `eval: true`, so it also works from inside
 * the asar archive (worker_threads cannot load a file path inside app.asar). It needs only Node built-ins.
 */
function scriptExecutor(): WorkerExecutor {
  let source: string | null = null
  return new WorkerExecutor({
    spawn: () => {
      source ??= readFileSync(join(__dirname, 'script-worker.cjs'), 'utf8')
      return new Worker(source, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 } })
    },
  })
}

function serveRenderer(): void {
  const distDir = join(app.getAppPath(), 'dist')
  const csp = contentSecurityPolicy({ dev: false })
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url)
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
    const target = normalize(join(distDir, relative))
    // Refuse anything that escapes dist/ (../ segments, encoded separators).
    if (target !== distDir && !target.startsWith(distDir + sep)) return new Response('Forbidden', { status: 403 })
    if (!existsSync(target)) return new Response('Not found', { status: 404 })
    const upstream = await net.fetch(pathToFileURL(target).toString())
    const headers = new Headers(upstream.headers)
    headers.set('Content-Security-Policy', csp)
    headers.set('X-Content-Type-Options', 'nosniff')
    return new Response(upstream.body, { status: upstream.status, headers })
  })
}

function hardenSession(): void {
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_wc, permission, callback, details) =>
    callback(isPermissionAllowed(permission, details.requestingUrl, isTrustedUrl)),
  )
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) =>
    isPermissionAllowed(permission, requestingOrigin, (url) => isTrustedUrl(url.endsWith('/') ? url : `${url}/`)),
  )
  if (devServerUrl) {
    const csp = contentSecurityPolicy({ dev: true, devOrigin: devServerUrl })
    ses.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] },
      })
    })
  }
}

// Linux has no bundle icon, so the window/taskbar icon must be set here (macOS/Windows use the packaged one).
function linuxWindowIcon(): { icon?: string } {
  if (process.platform !== 'linux') return {}
  const icon = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'build', 'icons', '512x512.png')
  return existsSync(icon) ? { icon } : {}
}

function createWindow(): BrowserWindow {
  // Remembered geometry, fitted onto the displays that exist now (null: default size, centred).
  const bounds = windowState.bounds ? clampBounds(windowState.bounds, screen.getAllDisplays().map((d) => d.workArea), MIN_SIZE) : null
  const win = new BrowserWindow({
    ...linuxWindowIcon(),
    ...(bounds ?? DEFAULT_SIZE),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    title: 'Slinger',
    // The last theme's --bg (reported by the renderer), so the window never flashes another colour before the
    // launch skeleton paints; before the first report, the default light/dark theme's --bg.
    backgroundColor: windowState.backgroundColor ?? DEFAULT_BACKGROUND[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'],
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      // Automated runs on a desktop session: render off-screen instead of throttling a hidden window
      // (a hidden window only produces a frame every ~2 s, which makes UI automation crawl).
      ...(process.env.SLINGER_HIDE_WINDOW ? { offscreen: true, backgroundThrottling: false } : {}),
    },
  })
  // ready-to-show fires after the first paint, which is the static launch skeleton in index.html (it needs no JS).
  win.once('ready-to-show', () => {
    timeMark('readyToShow')
    if (automatedWindow()) return
    if (windowState.maximized) win.maximize()
    win.show()
  })
  win.on('close', () => {
    if (automatedWindow()) return
    windowState = { ...windowState, bounds: win.getNormalBounds(), maximized: win.isMaximized() }
    writeWindowState(windowStateFile(), windowState)
  })
  if (startupTiming) {
    win.webContents.once('did-finish-load', () => {
      timeMark('didFinishLoad')
      void reportStartupTiming(win)
    })
  }
  // Links open in the user's browser (http/https/mailto only); the app window itself never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      void shell.openExternal(assertExternalUrl(url))
    } catch {
      /* not an http(s)/mailto URL: ignore */
    }
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedUrl(url)) event.preventDefault()
  })
  timeMark('loadURL')
  void win.loadURL(devServerUrl ?? `${APP_ORIGIN}/index.html`)
  return win
}

/** Waits (up to 30 s) for the renderer to remove the launch skeleton, then prints main + renderer timings. */
async function reportStartupTiming(win: BrowserWindow): Promise<void> {
  let renderer: unknown = null
  for (let i = 0; i < 300 && !win.isDestroyed(); i++) {
    renderer = await win.webContents.executeJavaScript('window.__slingerStartup ?? null').catch(() => null)
    if (renderer) break
    await new Promise((r) => setTimeout(r, 100))
  }
  console.log('STARTUP_TIMING ' + JSON.stringify({ main: startupTiming, renderer }))
}

/** Renderer-reported theme background: paint the live window with it and remember it for the next launch. */
function setWindowBackground(color: string): void {
  if (windowState.backgroundColor === color) return
  windowState = { ...windowState, backgroundColor: color }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setBackgroundColor(color)
  writeWindowState(windowStateFile(), windowState)
}

/** Headless self-check used by `SLINGER_SMOKE_TEST=1`: exercises preload + IPC + error transport. */
async function runSmokeTest(win: BrowserWindow): Promise<void> {
  const target = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('smoke-ok')
  })
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve))
  const port = (target.address() as AddressInfo).port
  const script = `(async () => {
    const out = { hasRequire: typeof require, hasProcess: typeof process, keys: Object.keys(window.slinger || {}).length }
    out.version = await window.slinger.getAppVersion()
    out.workspaces = (await window.slinger.listWorkspaces()).map((w) => w.name)
    try { await window.slinger.renameWorkspace('not-a-uuid', 'x') } catch (e) {
      out.error = { isError: e instanceof Error, name: e.name, code: e.code, message: e.message }
    }
    try { await window.slinger.secureStoreGet('slinger:env-var:x') } catch (e) { out.reserved = e.code }
    try { await window.slinger.updateRequest({ requestId: '11111111-1111-4111-8111-111111111111', name: 'x', method: 'GET', url: '', documentJson: '{}', expectedVersion: 1 }) } catch (e) { out.notFound = e.code }
    out.csp = (await fetch(location.href)).headers.get('content-security-policy')
    const ws = (await window.slinger.listWorkspaces())[0]
    const http = await window.slinger.executeHttpRequest({ method: 'POST', url: '127.0.0.1:__PORT__/x', headers: [], auth: { kind: 'bearer', bearer: { token: 't' } },
      body: { mode: 'formData', formData: [{ key: 'a', value: 'b', type: 'text', enabled: true }] }, workspaceId: ws.id })
    out.http = { status: http.status, body: http.bodyText }
    out.history = (await window.slinger.listHistory(ws.id)).length
    if (__KEYCHAIN__) try {
      const env = await window.slinger.ensureDefaultEnvironment(ws.id)
      const v = await window.slinger.upsertEnvironmentVariable({ environmentId: env.id, key: 'SMOKE_SECRET', value: 'hunter2', isSecret: true })
      out.secretListed = JSON.stringify(v).includes('hunter2')
      out.secretRevealed = (await window.slinger.revealEnvironmentVariable(v.id)) === 'hunter2'
      await window.slinger.deleteEnvironmentVariable(v.id)
    } catch (e) { out.keychainError = e.message }
    try {
      const s = await window.slinger.runScripts({ runId: 'run_smoke', sessionId: 'smoke', workspaceId: ws.id, environmentId: null, event: 'test',
        scripts: [{ origin: 'request', name: 'smoke', code: "console.log('from sandbox'); pm.test('status is 200', () => pm.expect(pm.response.code).to.equal(200)); pm.test('require is blocked', () => { let blocked = false; try { require('fs') } catch (e) { blocked = true }; pm.expect(blocked).to.equal(true) }); const CryptoJS = require('crypto-js'); pm.variables.set('hmac', CryptoJS.HmacSHA256('smoke', 'key').toString(CryptoJS.enc.Base64))" }],
        request: { method: 'GET', url: 'http://x', headers: [], body: { mode: 'none' } },
        response: { code: 200, status: 'OK', headers: [], body: 'ok', responseTime: 1, size: 2 },
        variables: {}, collectionVariables: {}, globals: {}, info: { requestName: 'smoke', requestId: null, iteration: 0, iterationCount: 1 } })
      out.scripts = { passed: s.tests.filter((t) => t.status === 'passed').length, errors: s.errors.length, console: s.console.map((c) => c.message), hmac: s.variables.hmac }
    } catch (e) { out.scriptsError = e.message }
    try {
      // pm.sendRequest: worker -> main -> HTTP engine -> back into the sandbox, outside of history.
      const historyBefore = (await window.slinger.listHistory(ws.id)).length
      const s = await window.slinger.runScripts({ runId: 'run_smoke_send', sessionId: 'smoke', workspaceId: ws.id, environmentId: null, event: 'prerequest',
        scripts: [{ origin: 'collection', name: 'smoke', code: "const res = await pm.sendRequest({ url: 'http://127.0.0.1:__PORT__/token', method: 'POST', header: { 'Content-Type': 'application/json' }, body: { mode: 'raw', raw: JSON.stringify({ a: 1 }) } }); pm.variables.set('sr', res.code + ' ' + res.text())" }],
        request: { method: 'GET', url: 'http://x', headers: [], body: { mode: 'none' } }, response: null,
        variables: {}, collectionVariables: {}, globals: {}, info: { requestName: 'smoke', requestId: null, iteration: 0, iterationCount: 1 } })
      out.sendRequest = { value: s.variables.sr, errors: s.errors.map((e) => e.message), console: s.console.map((c) => c.message),
        notInHistory: (await window.slinger.listHistory(ws.id)).length === historyBefore }
    } catch (e) { out.sendRequestError = e.message }
    return out
  })()`
  try {
    // SLINGER_SMOKE_NO_KEYCHAIN skips the secret round trip (a locked desktop keyring would wait for an unlock prompt).
    const keychain = process.env.SLINGER_SMOKE_NO_KEYCHAIN ? 'false' : 'true'
    const result = await win.webContents.executeJavaScript(script.replaceAll('__PORT__', String(port)).replace('__KEYCHAIN__', keychain))
    // A library bundled into the script worker (require('crypto-js')) must give the same HMAC as Node.
    if (result?.scripts) result.scripts.hmacOk = result.scripts.hmac === createHmac('sha256', 'key').update('smoke').digest('base64')
    if (result?.sendRequest) result.sendRequest.ok = result.sendRequest.value === '200 smoke-ok' && result.sendRequest.notInHistory
    console.log('SMOKE_RESULT ' + JSON.stringify(result))
    target.close()
    app.exit(0)
  } catch (err) {
    console.log('SMOKE_FAILED ' + (err instanceof Error ? err.message : String(err)))
    app.exit(1)
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(() => {
    timeMark('appReady')
    windowState = readWindowState(windowStateFile())
    db = openDatabase(join(app.getPath('userData'), 'slinger.db'))
    core = createCore({
      db,
      secrets: loadKeychain(),
      migrationsDir: join(app.getAppPath(), 'electron', 'migrations'),
      scriptExecutor: scriptExecutor(),
      sync: {
        // Push channel to the trusted main window only; payloads are plain JSON.
        emit: (event) => {
          if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send(IPC_EVENT_CHANNELS[0], event)
          }
        },
        appVersion: app.getVersion(),
        // Electron's network stack honours the system proxy; cloud traffic never goes through request history.
        fetchImpl: ((input: string | URL | Request, init?: RequestInit) =>
          net.fetch(input instanceof URL ? input.toString() : (input as string | Request), init)) as typeof fetch,
        defaultDeviceName: hostname(),
      },
    })
    const api = createIpcApi(core, {
      appVersion: app.getVersion(),
      openExternal: (url) => shell.openExternal(url),
      pickFile: async (options) => {
        const dialogOptions = {
          title: options.title,
          defaultPath: options.defaultPath,
          filters: options.filters,
          properties: ['openFile'] as Array<'openFile'>,
        }
        const result = mainWindow ? await dialog.showOpenDialog(mainWindow, dialogOptions) : await dialog.showOpenDialog(dialogOptions)
        return result.canceled ? null : (result.filePaths[0] ?? null)
      },
      chooseDirectory: async () => {
        const options = { properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> }
        const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
        return result.canceled ? null : (result.filePaths[0] ?? null)
      },
      setWindowBackground,
    })
    registerIpcHandlers(api, isTrustedUrl)
    if (!devServerUrl) serveRenderer()
    hardenSession()
    mainWindow = createWindow()
    mainWindow.on('closed', () => (mainWindow = null))
    // Auto-sync: timers run in main; focus/blur pick the poll interval, resume re-syncs after sleep.
    mainWindow.on('focus', () => core?.sync.notifyFocus(true))
    mainWindow.on('blur', () => core?.sync.notifyFocus(false))
    powerMonitor.on('resume', () => core?.sync.notifyResume())
    if (!process.env.SLINGER_SMOKE_TEST) core.sync.start()
    if (process.env.SLINGER_SMOKE_TEST) {
      mainWindow.webContents.once('did-finish-load', () => void runSmokeTest(mainWindow!))
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('before-quit', () => {
    core?.sync.stop()
    core?.authCallbacks.closeAll()
    db?.close()
    db = null
  })
}
