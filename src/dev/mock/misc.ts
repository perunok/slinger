import type { SlingerIpcApi } from '../../../shared/ipc-contract'
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
  | 'pickFile'
  | 'grantedFiles'
> & { resetSecureStore(): void }

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
      return '0.0.0-dev'
    },
    async getVersionInfo() {
      // Browser mode: no Electron/Node runtime; fake but plausible values so "Copy version info" can be tried.
      return { app: '0.0.0-dev', electron: null, chrome: null, node: null, v8: null, os: { platform: 'browser', release: 'mock', arch: 'unknown' } }
    },
    async setWindowBackground() {
      /* no native window in the browser */
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
    resetSecureStore() {
      secure = new Map()
      saveSecure(secure)
    },
  }
}
