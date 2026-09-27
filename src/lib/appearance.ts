/**
 * Persisted appearance settings (theme, accent, which themes 'System' uses, and the sending animation).
 *
 * Stored as JSON under `slinger.appearance`. Versions up to 0.2.0 stored only the theme choice as a plain string under
 * `slinger.theme`; that value is migrated once (and the old key removed) so nobody loses their theme.
 * public/theme-init.js reads the same key before first paint, so keep the two in step. Custom themes (their ids are
 * `custom:<uuid>`) are stored separately under `slinger.customThemes` (lib/customThemes.ts).
 */
import { DEFAULT_LOADER, isLoaderSetting, type LoaderSetting } from './loader'
import { DEFAULT_DARK_THEME, DEFAULT_LIGHT_THEME, THEME_DEFAULT_ACCENT, findTheme, isAccent, type Scheme } from './themes'

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

/**
 * Drops anything unknown (e.g. a theme from a newer version, a deleted custom theme) back to its default.
 * `custom` are the user's custom themes (lib/customThemes.ts): their ids are valid choices too.
 */
export function sanitizeAppearance(raw: Partial<Record<keyof Appearance, unknown>>, custom: readonly { id: string; scheme: Scheme }[] = []): Appearance {
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const find = (id: string) => findTheme(id) ?? custom.find((c) => c.id === id)
  const theme = str(raw.theme)
  const accent = str(raw.accent)
  const light = str(raw.systemLight)
  const dark = str(raw.systemDark)
  return {
    theme: theme === 'system' || find(theme) ? theme : DEFAULT_APPEARANCE.theme,
    accent: isAccent(accent) ? accent : DEFAULT_APPEARANCE.accent,
    systemLight: find(light)?.scheme === 'light' ? light : DEFAULT_LIGHT_THEME,
    systemDark: find(dark)?.scheme === 'dark' ? dark : DEFAULT_DARK_THEME,
    loader: isLoaderSetting(raw.loader) ? raw.loader : DEFAULT_LOADER,
  }
}

export function loadAppearance(store: KeyValueStore, custom: readonly { id: string; scheme: Scheme }[] = []): Appearance {
  const json = store.get(APPEARANCE_KEY)
  if (json !== null) {
    try {
      const parsed: unknown = JSON.parse(json)
      if (parsed && typeof parsed === 'object') return sanitizeAppearance(parsed as Record<string, unknown>, custom)
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
