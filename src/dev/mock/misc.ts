import type { SlingerIpcApi } from '../../../shared/ipc-contract'
import type { TitleBarStyle, UpdateInstallState } from '../../../shared/types'
import { compareSemver } from '../../lib/semver'
import { base64ToBytes, fail, sleep, uuid } from './util'

type MiscApi = Pick<
  SlingerIpcApi,
  | 'defaultExportPath'
  | 'writeExportFile'
  | 'chooseExportDirectory'
  | 'secureStoreGet'
  | 'secureStoreSet'
  | 'secureStoreDelete'
  | 'openExternalUrl'
  | 'prepareBrowserAuthCallback'
  | 'waitForBrowserAuthCallback'
  | 'getAppVersion'
  | 'getVersionInfo'
  | 'setWindowBackground'
  | 'checkForUpdates'
  | 'getUpdateInstallState'
  | 'downloadUpdate'
  | 'cancelUpdateDownload'
  | 'installUpdate'
  | 'onUpdateState'
  | 'getWindowChrome'
  | 'setTitleBarStyle'
  | 'setCloseToTray'
  | 'reopenWindow'
  | 'windowControl'
  | 'showAppMenu'
  | 'pickFile'
  | 'grantedFiles'
> & { resetSecureStore(): void; setLatestRelease(version: string | null, notes?: string | null): void }

const MOCK_VERSION = '0.0.0-dev'
/** Release notes the pretend latest release carries unless a test passes its own. */
export const MOCK_RELEASE_NOTES = '### New\n- A pretend feature of the pretend release.\n\n### Fixed\n- A pretend bug.'
const TITLE_BAR_KEY = 'slinger.mock.titleBar'

function loadTitleBar(): TitleBarStyle {
  try {
    return sessionStorage.getItem(TITLE_BAR_KEY) === 'system' ? 'system' : 'custom'
  } catch {
    return 'custom'
  }
}

const STORAGE_KEY = 'slinger.mock.secureStore'
const PICK_NAMES = ['sample-upload.png', 'report.pdf', 'data.csv']

/** Dev-only persistence; the real app keeps these values in the OS keychain. */
function loadSecure(): Map<string, string> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (raw) return new Map(Object.entries(JSON.parse(raw) as Record<string, string>))
  } catch {
    /* storage unavailable: start empty */
  }
  return new Map()
}

function saveSecure(store: Map<string, string>): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(store)))
  } catch {
    /* in-memory only */
  }
}

function download(fileName: string, contents: string, encoding: 'utf8' | 'base64'): void {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return
  const part: BlobPart = encoding === 'base64' ? new Uint8Array(base64ToBytes(contents)) : contents
  const url = URL.createObjectURL(new Blob([part]))
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function createMiscApi(): MiscApi {
  let secure = loadSecure()
  let pickIndex = 0
  const granted = new Set<string>()
  let exportDir = '/home/user/Downloads'
  /** The "latest release" checkForUpdates reports; null = none published (no notice in dev and tests by default). */
  let latestRelease: string | null = null
  /** Its release notes (the GitHub release body); a sample by default. */
  let latestNotes: string | null = null
  // In-app updater: a pretend .deb installation whose download takes ~1 s in 10 steps (no real file, nothing installed).
  const updateListeners = new Set<(s: UpdateInstallState) => void>()
  let update: UpdateInstallState = { method: 'deb', unsupportedReason: null, phase: 'idle', version: null, received: 0, total: null, bytesPerSec: null, error: null }
  let updateTimer: ReturnType<typeof setTimeout> | null = null
  const setUpdate = (patch: Partial<UpdateInstallState>) => {
    update = { ...update, ...patch }
    for (const l of updateListeners) l({ ...update })
  }
  // A page load is a new "window": it shows the preference saved before it (reopenWindow reloads).
  const windowTitleBar = loadTitleBar()
  let preferredTitleBar = windowTitleBar
  let closeToTray = true
  return {
    async defaultExportPath(fileName) {
      return `${exportDir}/${fileName}`
    },
    async chooseExportDirectory() {
      exportDir = exportDir === '/home/user/Downloads' ? '/home/user/Exports' : '/home/user/Downloads'
      return exportDir
    },
    async writeExportFile(fileName, contents, encoding = 'utf8') {
      if (!fileName.trim()) fail('invalid_input', 'File name must not be empty')
      download(fileName, contents, encoding)
    },
    async secureStoreGet(key) {
      return secure.get(key) ?? null
    },
    async secureStoreSet(key, value) {
      secure.set(key, value)
      saveSecure(secure)
    },
    async secureStoreDelete(key) {
      secure.delete(key)
      saveSecure(secure)
    },
    async openExternalUrl(url) {
      // Same policy as the main process (services/externalUrl.ts): http, https and mailto only.
      let parsed: URL | null = null
      try {
        parsed = new URL(String(url).trim())
      } catch {
        /* invalid */
      }
      if (!parsed || !['http:', 'https:', 'mailto:'].includes(parsed.protocol)) fail('invalid_input', 'only http, https and mailto URLs can be opened')
      window.open(parsed.toString(), '_blank', 'noopener')
    },
    async prepareBrowserAuthCallback() {
      const callbackId = uuid()
      return { callbackId, redirectUrl: `http://127.0.0.1:0/callback/${callbackId}` }
    },
    async waitForBrowserAuthCallback() {
      await sleep(300)
      return fail('io_error', 'not available in browser mock')
    },
    async getAppVersion() {
      return MOCK_VERSION
    },
    async getVersionInfo() {
      // Browser mode: no Electron/Node runtime; fake but plausible values so "Copy version info" can be tried.
      return { app: '0.0.0-dev', electron: null, chrome: null, node: null, v8: null, os: { platform: 'browser', release: 'mock', arch: 'unknown' } }
    },
    async setWindowBackground() {
      /* no native window in the browser */
    },
    async checkForUpdates() {
      const checkedAt = Math.floor(Date.now() / 1000)
      if (!latestRelease) return { currentVersion: MOCK_VERSION, latest: null, updateAvailable: false, checkedAt }
      return {
        currentVersion: MOCK_VERSION,
        latest: { version: latestRelease, url: `https://github.com/perunok/slinger/releases/tag/v${latestRelease}`, publishedAt: checkedAt - 86_400, notes: latestNotes },
        updateAvailable: compareSemver(latestRelease, MOCK_VERSION) > 0,
        checkedAt,
      }
    },
    async getWindowChrome() {
      return { platform: 'browser', titleBar: windowTitleBar, preferredTitleBar, closeToTray, state: { maximized: false, fullScreen: false, focused: true } }
    },
    async setTitleBarStyle(style) {
      if (style !== 'custom' && style !== 'system') fail('invalid_input', 'style must be custom or system')
      preferredTitleBar = style
      try {
        sessionStorage.setItem(TITLE_BAR_KEY, style)
      } catch {
        /* this page only */
      }
      return { platform: 'browser', titleBar: windowTitleBar, preferredTitleBar, closeToTray, state: { maximized: false, fullScreen: false, focused: true } }
    },
    async setCloseToTray(enabled) {
      if (typeof enabled !== 'boolean') fail('invalid_input', 'enabled must be a boolean')
      closeToTray = enabled
      return { platform: 'browser', titleBar: windowTitleBar, preferredTitleBar, closeToTray, state: { maximized: false, fullScreen: false, focused: true } }
    },
    async reopenWindow() {
      setTimeout(() => location.reload(), 0)
    },
    async windowControl() {
      /* no native window in the browser */
    },
    async showAppMenu() {
      /* no native menu in the browser */
    },
    async pickFile() {
      const name = PICK_NAMES[pickIndex++ % PICK_NAMES.length]
      const path = `/home/user/Documents/${name}`
      granted.add(path)
      return path
    },
    // Mirrors the main process: only paths chosen with pickFile in this session count as granted.
    async grantedFiles(paths) {
      return paths.filter((p) => granted.has(p))
    },
    async getUpdateInstallState() {
      return { ...update }
    },
    async downloadUpdate() {
      if (!latestRelease || compareSemver(latestRelease, MOCK_VERSION) <= 0) fail('io_error', `Slinger ${MOCK_VERSION} is already the latest release.`)
      if (update.phase === 'downloading') return { ...update }
      const total = 85 * 1024 * 1024
      setUpdate({ phase: 'downloading', version: latestRelease, received: 0, total, bytesPerSec: null, error: null })
      let step = 0
      const tick = () => {
        step++
        if (step < 10) {
          setUpdate({ received: Math.round((total * step) / 10), bytesPerSec: 6 * 1024 * 1024 })
          updateTimer = setTimeout(tick, 100)
        } else {
          setUpdate({ phase: 'verifying', received: total, bytesPerSec: null })
          updateTimer = setTimeout(() => setUpdate({ phase: 'ready' }), 100)
        }
      }
      updateTimer = setTimeout(tick, 100)
      return { ...update }
    },
    async cancelUpdateDownload() {
      if (updateTimer) clearTimeout(updateTimer)
      updateTimer = null
      if (update.phase === 'downloading' || update.phase === 'verifying') setUpdate({ phase: 'idle', received: 0, total: null, bytesPerSec: null })
      return { ...update }
    },
    async installUpdate() {
      if (update.phase !== 'ready') fail('io_error', 'No downloaded update is ready to install.')
      setUpdate({ phase: 'installing' })
      return { ...update }
    },
    onUpdateState(listener) {
      updateListeners.add(listener)
      return () => updateListeners.delete(listener)
    },
    setLatestRelease(version, notes = MOCK_RELEASE_NOTES) {
      latestRelease = version
      latestNotes = notes
      if (updateTimer) clearTimeout(updateTimer)
      update = { ...update, phase: 'idle', version: null, received: 0, total: null, bytesPerSec: null, error: null }
    },
    resetSecureStore() {
      secure = new Map()
      saveSecure(secure)
    },
  }
}
