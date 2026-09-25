import { APPEARANCE_KEY, LEGACY_THEME_KEY, loadAppearance, saveAppearance, type KeyValueStore } from './appearance'
import { THEMES, resolveTheme } from './themes'

function memory(init: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } {
  const data = { ...init }
  return {
    data,
    get: (k) => (k in data ? data[k]! : null),
    set: (k, v) => void (data[k] = v),
    remove: (k) => void delete data[k],
  }
}

describe('appearance persistence', () => {
  it('defaults to System with the theme accent', () => {
    const s = memory()
    expect(loadAppearance(s)).toEqual({ theme: 'system', accent: 'theme', systemLight: 'light', systemDark: 'dark', loader: 'random' })
    expect(s.data).toEqual({}) // nothing to migrate, nothing written
  })

  it.each(['light', 'dark', 'midnight', 'solarized', 'contrast', 'system'])('migrates the 0.2.0 theme %s without losing it', (old) => {
    const s = memory({ [LEGACY_THEME_KEY]: old })
    expect(loadAppearance(s).theme).toBe(old)
    expect(s.data[LEGACY_THEME_KEY]).toBeUndefined()
    expect(JSON.parse(s.data[APPEARANCE_KEY]!)).toMatchObject({ theme: old, accent: 'theme' })
    // second start reads the new format
    expect(loadAppearance(s).theme).toBe(old)
  })

  it('an unknown legacy value falls back to System', () => {
    expect(loadAppearance(memory({ [LEGACY_THEME_KEY]: 'sepia' })).theme).toBe('system')
  })

  it('round-trips every field', () => {
    const s = memory()
    saveAppearance(s, { theme: 'dracula', accent: 'teal', systemLight: 'paper', systemDark: 'nord', loader: 'shuttle' })
    expect(loadAppearance(s)).toEqual({ theme: 'dracula', accent: 'teal', systemLight: 'paper', systemDark: 'nord', loader: 'shuttle' })
  })

  it('sanitizes unknown ids and wrong-scheme system themes', () => {
    const s = memory({ [APPEARANCE_KEY]: JSON.stringify({ theme: 'future-theme', accent: 'chartreuse', systemLight: 'dracula', systemDark: 42 }) })
    expect(loadAppearance(s)).toEqual({ theme: 'system', accent: 'theme', systemLight: 'light', systemDark: 'dark', loader: 'random' })
  })

  it('settings saved before the loading animation existed get Random; unknown values too', () => {
    const old = memory({ [APPEARANCE_KEY]: JSON.stringify({ v: 1, theme: 'nord', accent: 'teal', systemLight: 'paper', systemDark: 'dracula' }) })
    expect(loadAppearance(old)).toEqual({ theme: 'nord', accent: 'teal', systemLight: 'paper', systemDark: 'dracula', loader: 'random' })
    for (const bad of ['mario', 42, null]) {
      expect(loadAppearance(memory({ [APPEARANCE_KEY]: JSON.stringify({ theme: 'nord', loader: bad }) })).loader).toBe('random')
    }
    for (const ok of ['runner', 'shuttle', 'pebble', 'classic', 'random'] as const) {
      const s = memory()
      saveAppearance(s, { theme: 'nord', accent: 'theme', systemLight: 'light', systemDark: 'dark', loader: ok })
      expect(loadAppearance(s).loader).toBe(ok)
    }
  })

  it('prefers the new key over a stale legacy key, and survives corrupt JSON', () => {
    expect(loadAppearance(memory({ [APPEARANCE_KEY]: JSON.stringify({ theme: 'nord' }), [LEGACY_THEME_KEY]: 'light' })).theme).toBe('nord')
    expect(loadAppearance(memory({ [APPEARANCE_KEY]: '{oops', [LEGACY_THEME_KEY]: 'midnight' })).theme).toBe('midnight')
  })
})

describe('resolveTheme', () => {
  it('maps System to the configured light/dark themes', () => {
    const sys = { light: 'catppuccin-latte', dark: 'tokyo-night' }
    expect(resolveTheme('system', true, sys)).toBe('catppuccin-latte')
    expect(resolveTheme('system', false, sys)).toBe('tokyo-night')
    expect(resolveTheme('system', true)).toBe('light')
    expect(resolveTheme('system', false)).toBe('dark')
  })

  it('falls back for unknown or wrong-scheme ids', () => {
    expect(resolveTheme('system', true, { light: 'dracula', dark: 'dark' })).toBe('light')
    expect(resolveTheme('nope', true)).toBe('dark')
    for (const t of THEMES) expect(resolveTheme(t.id, true)).toBe(t.id)
  })
})
