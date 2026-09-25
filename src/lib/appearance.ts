/**
 * Persisted appearance settings (theme, accent, which themes 'System' uses, and the sending animation).
 *
 * Stored as JSON under `slinger.appearance`. Versions up to 0.2.0 stored only the theme choice as a plain string under
 * `slinger.theme`; that value is migrated once (and the old key removed) so nobody loses their theme.
 * public/theme-init.js reads the same key before first paint, so keep the two in step.
 */
import { DEFAULT_LOADER, isLoaderSetting, type LoaderSetting } from './loader'
import { DEFAULT_DARK_THEME, DEFAULT_LIGHT_THEME, THEME_DEFAULT_ACCENT, findTheme, isAccent } from './themes'

export const APPEARANCE_KEY = 'slinger.appearance'
export const LEGACY_THEME_KEY = 'slinger.theme'

export interface Appearance {
  /** 'system' or a theme id. */
  theme: string
  /** An accent id, or 'theme' for the theme's own accent. */
  accent: string
  systemLight: string
  systemDark: string
  /** The "sending request" animation; missing in settings saved before it existed (= random). */
  loader: LoaderSetting
}

export interface KeyValueStore {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

export const DEFAULT_APPEARANCE: Appearance = {
  theme: 'system',
  accent: THEME_DEFAULT_ACCENT,
  systemLight: DEFAULT_LIGHT_THEME,
  systemDark: DEFAULT_DARK_THEME,
  loader: DEFAULT_LOADER,
}

/** Drops anything unknown (e.g. a theme from a newer version) back to its default. */
export function sanitizeAppearance(raw: Partial<Record<keyof Appearance, unknown>>): Appearance {
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const theme = str(raw.theme)
  const accent = str(raw.accent)
  const light = str(raw.systemLight)
  const dark = str(raw.systemDark)
  return {
    theme: theme === 'system' || findTheme(theme) ? theme : DEFAULT_APPEARANCE.theme,
    accent: isAccent(accent) ? accent : DEFAULT_APPEARANCE.accent,
    systemLight: findTheme(light)?.scheme === 'light' ? light : DEFAULT_LIGHT_THEME,
    systemDark: findTheme(dark)?.scheme === 'dark' ? dark : DEFAULT_DARK_THEME,
    loader: isLoaderSetting(raw.loader) ? raw.loader : DEFAULT_LOADER,
  }
}

export function loadAppearance(store: KeyValueStore): Appearance {
  const json = store.get(APPEARANCE_KEY)
  if (json !== null) {
    try {
      const parsed: unknown = JSON.parse(json)
      if (parsed && typeof parsed === 'object') return sanitizeAppearance(parsed as Record<string, unknown>)
    } catch {
      /* corrupt: fall through to the legacy key / defaults */
    }
  }
  const legacy = store.get(LEGACY_THEME_KEY)
  const migrated = sanitizeAppearance({ ...DEFAULT_APPEARANCE, theme: legacy ?? DEFAULT_APPEARANCE.theme })
  if (legacy !== null) {
    saveAppearance(store, migrated)
    store.remove(LEGACY_THEME_KEY)
  }
  return migrated
}

export function saveAppearance(store: KeyValueStore, a: Appearance): void {
  store.set(APPEARANCE_KEY, JSON.stringify({ v: 1, ...a }))
}
