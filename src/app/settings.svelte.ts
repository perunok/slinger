import { loadAppearance, sanitizeAppearance, saveAppearance, type Appearance } from '../lib/appearance'
import {
  CUSTOM_THEMES_STYLE_ID,
  MAX_CUSTOM_THEMES,
  customThemesCss,
  loadCustomThemes,
  saveCustomThemes,
  themeAttributes,
  type CustomTheme,
} from '../lib/customThemes'
import { isLoaderSetting, type LoaderSetting } from '../lib/loader'
import { reportTitleBarOverlay } from '../lib/titleBarOverlay'
import { reportWindowBackground } from '../lib/windowBackground'
import { THEME_DEFAULT_ACCENT, findTheme, isAccent, resolveTheme, type Scheme } from '../lib/themes'
import { clearAllPersisted } from '../features/requests/tabsPersistence'
import { DEFAULT_TITLE_BAR_LAYOUT, TITLE_BAR_LAYOUT_KEY, loadTitleBarLayout, serializeTitleBarLayout, type TitleBarLayout } from '../lib/titleBarLayout'

const K = {
  font: 'slinger.fontSize',
  wrap: 'slinger.editorWrap',
  scriptTimeout: 'slinger.scriptTimeoutMs',
  scriptContinue: 'slinger.scriptContinueOnError',
  restoreTabs: 'slinger.restoreTabsOnStartup',
  responsePosition: 'slinger.responsePosition',
  statusBar: 'slinger.statusBar',
  sidebar: 'slinger.sidebar',
  titleBarLayout: TITLE_BAR_LAYOUT_KEY,
}

/** Where the response pane sits relative to the request editor (request and example tabs). */
export type ResponsePosition = 'below' | 'beside'

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
  /** User-defined themes (lib/customThemes.ts), persisted under `slinger.customThemes`. */
  customThemes = $state<CustomTheme[]>(loadCustomThemes(storage))
  /** The custom theme being edited: its rule is live (for previews) and, if `draftInApp`, <html> shows it. */
  draftTheme = $state<CustomTheme | null>(null)
  draftInApp = $state(false)
  #appearance = loadAppearance(storage, this.customThemes)
  /** 'system' or a theme id. */
  theme = $state<string>(this.#appearance.theme)
  /** An accent id, or 'theme' for the theme's own accent. */
  accent = $state<string>(this.#appearance.accent)
  /** Themes 'system' switches between. */
  systemLight = $state<string>(this.#appearance.systemLight)
  systemDark = $state<string>(this.#appearance.systemDark)
  /** The animation shown while a request is in flight ('random' picks a character per send). */
  loader = $state<LoaderSetting>(this.#appearance.loader)
  /** Whether the OS currently prefers a light colour scheme (only matters while theme is 'system'). */
  prefersLight = $state(false)
  fontSize = $state<number>(clampFont(Number(read(K.font)) || 13))
  editorWrap = $state<boolean>(read(K.wrap) === 'true')
  /** Time limit per script (pre-request / test), enforced in the main-process sandbox. */
  scriptTimeoutMs = $state<number>(clampTimeout(Number(read(K.scriptTimeout)) || SCRIPT_TIMEOUT_DEFAULT_MS))
  /** Send the request even when a pre-request script fails (off by default). */
  scriptContinueOnError = $state<boolean>(read(K.scriptContinue) === 'true')
  /** Reopen tabs (with their unsaved drafts) as they were left, per workspace, on the next startup. */
  restoreTabsOnStartup = $state<boolean>(read(K.restoreTabs) !== 'false')
  /** Response below the request (stacked, the default) or beside it (side by side). */
  responsePosition = $state<ResponsePosition>(read(K.responsePosition) === 'beside' ? 'beside' : 'below')
  /** The thin status bar at the bottom of the window (default on). */
  showStatusBar = $state<boolean>(read(K.statusBar) !== 'false')
  /** The sidebar (collections, history, workflows) at the left (default on; Ctrl+B). */
  showSidebar = $state<boolean>(read(K.sidebar) !== 'false')
  /** Which items the title bar shows, left and right, in order (lib/titleBarLayout.ts). */
  titleBarLayout = $state.raw<TitleBarLayout>(loadTitleBarLayout(read(K.titleBarLayout)))
  #mq: MediaQueryList | null = null

  /** The palette actually shown (resolves 'system'). */
  get resolvedTheme(): string {
    return resolveTheme(this.theme, this.prefersLight, { light: this.systemLight, dark: this.systemDark }, this.customThemes)
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
    syncCustomThemeStyle(this.#themesWithDraft())
    const shown = this.draftTheme && this.draftInApp ? this.draftTheme.id : this.resolvedTheme
    const attrs = this.themeAttrs(shown)
    root.setAttribute('data-theme', attrs['data-theme'])
    if (attrs['data-custom-theme']) root.setAttribute('data-custom-theme', attrs['data-custom-theme'])
    else root.removeAttribute('data-custom-theme')
    if (this.accent === THEME_DEFAULT_ACCENT) root.removeAttribute('data-accent')
    else root.setAttribute('data-accent', this.accent)
    root.style.setProperty('--font-size', `${this.fontSize}px`)
    reportWindowBackground()
    reportTitleBarOverlay()
  }
  #save() {
    const a: Appearance = { theme: this.theme, accent: this.accent, systemLight: this.systemLight, systemDark: this.systemDark, loader: this.loader }
    saveAppearance(storage, a)
    this.apply()
  }
  /** 'system' or a registered or custom theme id; anything else is ignored. */
  setTheme(t: string) {
    if (t !== 'system' && !this.#findTheme(t)) return
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
    if (this.#findTheme(id)?.scheme !== scheme) return
    if (scheme === 'light') this.systemLight = id
    else this.systemDark = id
    this.#save()
  }
  setLoader(l: string) {
    if (!isLoaderSetting(l)) return
    this.loader = l
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
  // ---- custom themes

  /** `data-theme` (+ `data-custom-theme`) that show a built-in or custom theme id on an element (previews, swatches). */
  themeAttrs(id: string): { 'data-theme': string; 'data-custom-theme'?: string } {
    return themeAttributes(id, this.#themesWithDraft())
  }
  #themesWithDraft(): CustomTheme[] {
    const d = this.draftTheme
    return d ? [...this.customThemes.filter((c) => c.id !== d.id), d] : this.customThemes
  }
  #findTheme(id: string): { scheme: Scheme } | undefined {
    return findTheme(id) ?? this.customThemes.find((c) => c.id === id)
  }
  /** Adds or replaces a custom theme and persists it; false when the list is full (MAX_CUSTOM_THEMES). */
  saveCustomTheme(t: CustomTheme): boolean {
    const i = this.customThemes.findIndex((c) => c.id === t.id)
    if (i < 0 && this.customThemes.length >= MAX_CUSTOM_THEMES) return false
    this.customThemes = i < 0 ? [...this.customThemes, t] : this.customThemes.map((c) => (c.id === t.id ? t : c))
    saveCustomThemes(storage, this.customThemes)
    this.#revalidate()
    return true
  }
  /** Removes a custom theme; if it was in use, its base theme (or the System default) takes over. */
  deleteCustomTheme(id: string) {
    const gone = this.customThemes.find((c) => c.id === id)
    if (!gone) return
    this.customThemes = this.customThemes.filter((c) => c.id !== id)
    saveCustomThemes(storage, this.customThemes)
    if (this.theme === id) this.theme = gone.base
    this.#revalidate()
  }
  /** Shows a theme being edited (null ends the preview and restores the saved theme). */
  setDraftTheme(draft: CustomTheme | null, inApp = true) {
    this.draftTheme = draft
    this.draftInApp = !!draft && inApp
    this.apply()
  }
  /** Ends the preview of draft `id` (no-op when another draft is being previewed). */
  clearDraftTheme(id: string) {
    if (this.draftTheme?.id === id) this.setDraftTheme(null)
  }
  /** After custom themes changed: drop choices that no longer exist (or changed scheme), persist and re-apply. */
  #revalidate() {
    const a = sanitizeAppearance({ theme: this.theme, accent: this.accent, systemLight: this.systemLight, systemDark: this.systemDark, loader: this.loader }, this.customThemes)
    this.theme = a.theme
    this.systemLight = a.systemLight
    this.systemDark = a.systemDark
    this.#save()
  }

  setResponsePosition(p: ResponsePosition) {
    if (p !== 'below' && p !== 'beside') return
    this.responsePosition = p
    write(K.responsePosition, p)
  }
  toggleResponsePosition() {
    this.setResponsePosition(this.responsePosition === 'below' ? 'beside' : 'below')
  }
  setShowStatusBar(v: boolean) {
    this.showStatusBar = v
    write(K.statusBar, String(v))
  }
  setShowSidebar(v: boolean) {
    this.showSidebar = v
    write(K.sidebar, String(v))
  }
  setTitleBarLayout(layout: TitleBarLayout) {
    this.titleBarLayout = layout
    write(K.titleBarLayout, serializeTitleBarLayout(layout))
  }
  resetTitleBarLayout() {
    this.setTitleBarLayout({ left: [...DEFAULT_TITLE_BAR_LAYOUT.left], right: [...DEFAULT_TITLE_BAR_LAYOUT.right], hidden: [] })
  }
  /** Turning this off also erases every workspace's stored tabs (nothing is kept "just in case"). */
  setRestoreTabsOnStartup(v: boolean) {
    this.restoreTabsOnStartup = v
    write(K.restoreTabs, String(v))
    if (!v) clearAllPersisted()
  }
}

/** The one managed <style> holding the generated custom theme rules (public/theme-init.js creates it before first paint). */
function syncCustomThemeStyle(themes: CustomTheme[]) {
  if (typeof document === 'undefined') return
  const css = customThemesCss(themes)
  let el = document.getElementById(CUSTOM_THEMES_STYLE_ID)
  if (!el) {
    if (!css) return
    el = document.createElement('style')
    el.id = CUSTOM_THEMES_STYLE_ID
    document.head.appendChild(el)
  }
  if (el.textContent !== css) el.textContent = css
}

function clampTimeout(n: number): number {
  return Number.isFinite(n) ? Math.min(60_000, Math.max(100, Math.round(n))) : SCRIPT_TIMEOUT_DEFAULT_MS
}

function clampFont(n: number): number {
  return Math.min(20, Math.max(11, Math.round(n)))
}

export const settings = new Settings()
