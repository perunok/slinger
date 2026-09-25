import { resolveTheme } from '../lib/themes'

const K = {
  theme: 'slinger.theme',
  font: 'slinger.fontSize',
  wrap: 'slinger.editorWrap',
  scriptTimeout: 'slinger.scriptTimeoutMs',
  scriptContinue: 'slinger.scriptContinueOnError',
}

export const SCRIPT_TIMEOUT_DEFAULT_MS = 5000

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage unavailable: preference lasts for this session only */
  }
}

class Settings {
  theme = $state<string>(read(K.theme) ?? 'system')
  fontSize = $state<number>(clampFont(Number(read(K.font)) || 13))
  editorWrap = $state<boolean>(read(K.wrap) === 'true')
  /** Time limit per script (pre-request / test), enforced in the main-process sandbox. */
  scriptTimeoutMs = $state<number>(clampTimeout(Number(read(K.scriptTimeout)) || SCRIPT_TIMEOUT_DEFAULT_MS))
  /** Send the request even when a pre-request script fails (off by default). */
  scriptContinueOnError = $state<boolean>(read(K.scriptContinue) === 'true')
  #mq: MediaQueryList | null = null

  /** Applies persisted settings to <html> and follows the OS theme while 'system' is selected. */
  init() {
    this.#mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null
    this.#mq?.addEventListener?.('change', () => this.apply())
    this.apply()
  }
  apply() {
    const root = document.documentElement
    root.setAttribute('data-theme', resolveTheme(this.theme, this.#mq?.matches ?? false))
    root.style.setProperty('--font-size', `${this.fontSize}px`)
  }
  setTheme(t: string) {
    this.theme = t
    write(K.theme, t)
    this.apply()
  }
  setFontSize(n: number) {
    this.fontSize = clampFont(n)
    write(K.font, String(this.fontSize))
    this.apply()
  }
  setEditorWrap(v: boolean) {
    this.editorWrap = v
    write(K.wrap, String(v))
  }
  setScriptTimeoutMs(n: number) {
    this.scriptTimeoutMs = clampTimeout(n)
    write(K.scriptTimeout, String(this.scriptTimeoutMs))
  }
  setScriptContinueOnError(v: boolean) {
    this.scriptContinueOnError = v
    write(K.scriptContinue, String(v))
  }
}

function clampTimeout(n: number): number {
  return Number.isFinite(n) ? Math.min(60_000, Math.max(100, Math.round(n))) : SCRIPT_TIMEOUT_DEFAULT_MS
}

function clampFont(n: number): number {
  return Math.min(20, Math.max(11, Math.round(n)))
}

export const settings = new Settings()
