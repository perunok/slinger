import { resolveTheme } from '../lib/themes'

const K = { theme: 'slinger.theme', font: 'slinger.fontSize', wrap: 'slinger.editorWrap' }

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
}

function clampFont(n: number): number {
  return Math.min(20, Math.max(11, Math.round(n)))
}

export const settings = new Settings()
