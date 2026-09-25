import { loadAppearance, saveAppearance, type Appearance } from '../lib/appearance'
import { THEME_DEFAULT_ACCENT, findTheme, isAccent, resolveTheme, type Scheme } from '../lib/themes'

const K = {
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

const storage = {
  get: read,
  set: write,
  remove: (key: string) => {
    try {
      localStorage.removeItem(key)
    } catch {
      /* ignore */
    }
  },
}

class Settings {
  #appearance = loadAppearance(storage)
  /** 'system' or a theme id. */
  theme = $state<string>(this.#appearance.theme)
  /** An accent id, or 'theme' for the theme's own accent. */
  accent = $state<string>(this.#appearance.accent)
  /** Themes 'system' switches between. */
  systemLight = $state<string>(this.#appearance.systemLight)
  systemDark = $state<string>(this.#appearance.systemDark)
  /** Whether the OS currently prefers a light colour scheme (only matters while theme is 'system'). */
  prefersLight = $state(false)
  fontSize = $state<number>(clampFont(Number(read(K.font)) || 13))
  editorWrap = $state<boolean>(read(K.wrap) === 'true')
  /** Time limit per script (pre-request / test), enforced in the main-process sandbox. */
  scriptTimeoutMs = $state<number>(clampTimeout(Number(read(K.scriptTimeout)) || SCRIPT_TIMEOUT_DEFAULT_MS))
  /** Send the request even when a pre-request script fails (off by default). */
  scriptContinueOnError = $state<boolean>(read(K.scriptContinue) === 'true')
  #mq: MediaQueryList | null = null

  /** The palette actually shown (resolves 'system'). */
  get resolvedTheme(): string {
    return resolveTheme(this.theme, this.prefersLight, { light: this.systemLight, dark: this.systemDark })
  }

  /** Applies persisted settings to <html> and follows the OS theme while 'system' is selected. */
  init() {
    this.#mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null
    this.prefersLight = this.#mq?.matches ?? false
    this.#mq?.addEventListener?.('change', (e) => {
      this.prefersLight = e.matches
      this.apply()
    })
    this.apply()
  }
  apply() {
    const root = document.documentElement
    root.setAttribute('data-theme', this.resolvedTheme)
    if (this.accent === THEME_DEFAULT_ACCENT) root.removeAttribute('data-accent')
    else root.setAttribute('data-accent', this.accent)
    root.style.setProperty('--font-size', `${this.fontSize}px`)
  }
  #save() {
    const a: Appearance = { theme: this.theme, accent: this.accent, systemLight: this.systemLight, systemDark: this.systemDark }
    saveAppearance(storage, a)
    this.apply()
  }
  /** 'system' or a registered theme id; anything else is ignored. */
  setTheme(t: string) {
    if (t !== 'system' && !findTheme(t)) return
    this.theme = t
    this.#save()
  }
  /** An accent id or 'theme'. */
  setAccent(a: string) {
    if (!isAccent(a)) return
    this.accent = a
    this.#save()
  }
  /** Which theme 'system' uses for the given OS scheme; the theme must be of that scheme. */
  setSystemTheme(scheme: Scheme, id: string) {
    if (findTheme(id)?.scheme !== scheme) return
    if (scheme === 'light') this.systemLight = id
    else this.systemDark = id
    this.#save()
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
