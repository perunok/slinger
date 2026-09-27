import { readFileSync } from 'node:fs'
import {
  CUSTOM_THEMES_KEY,
  MAX_CUSTOM_THEMES,
  checkTokenValue,
  customThemeRule,
  customThemesCss,
  isCustomThemeId,
  loadCustomThemes,
  newCustomThemeId,
  newThemeFrom,
  uniqueLabel,
  parseThemeCss,
  parseThemeImport,
  saveCustomThemes,
  themeAttributes,
  themeToCss,
  themeToFile,
  TOKEN_GROUPS,
  type CustomTheme,
  type Supports,
} from './customThemes'
import { THEME_TOKENS } from './themes'

// A stand-in for CSS.supports: accepts what a browser would for the values used here.
const supports: Supports = (prop, v) =>
  prop === 'box-shadow'
    ? /^(none|(inset )?-?\d+(px)? -?\d+(px)?( \d+px)*( .+)?)$/.test(v)
    : /^(#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|red|blue|white|black|transparent|(rgba?|hsla?|oklch|color-mix|light-dark)\(.+\))$/i.test(v)

const parse = (text: string) => parseThemeCss(text, supports)
const hexA = '#0b1020'
const hexB = '#e6e9f5'

describe('parseThemeCss', () => {
  it('reads token declarations, comments, color-scheme and a missing final semicolon', () => {
    const r = parse(`/* Base: Midnight (dark) */\ncolor-scheme: dark;\n--bg: ${hexA};\n  --text:\n    ${hexB};\n--overlay: rgba(0, 0, 0, 0.5);\n--shadow-pop: 0 8px 28px rgba(0, 0, 0, 0.4)\n`)
    expect(r.errors).toEqual([])
    expect(r.scheme).toBe('dark')
    expect(r.tokens).toEqual({ bg: hexA, text: hexB, overlay: 'rgba(0, 0, 0, 0.5)', 'shadow-pop': '0 8px 28px rgba(0, 0, 0, 0.4)' })
  })

  it('accepts colour functions the browser supports (color-mix, light-dark, oklch)', () => {
    const r = parse(`--accent: oklch(0.7 0.15 250);\n--accent-soft: color-mix(in srgb, ${hexA} 20%, ${hexB});\n--selection: light-dark(${hexA}, ${hexB});`)
    expect(r.errors).toEqual([])
    expect(Object.keys(r.tokens)).toEqual(['accent', 'accent-soft', 'selection'])
  })

  it('returns tokens in THEME_TOKENS order whatever the input order', () => {
    const r = parse(`--m-get: ${hexA}; --bg: ${hexB}; --text: ${hexA};`)
    expect(Object.keys(r.tokens)).toEqual(['bg', 'text', 'm-get'])
  })

  const rejects: [string, string, RegExp][] = [
    ['selector block', `:root {\n  --bg: ${hexA};\n}`, /Selectors and \{ \} blocks/],
    ['a lone closing brace', `--bg: ${hexA};\n}`, /Selectors and \{ \} blocks/],
    ['@-rule', `@import url(x.css);`, /@-rules are not allowed/],
    ['@media', `@media screen { --bg: red; }`, /@-rules|Selectors/],
    ['a normal property', 'background: red;', /Only theme tokens/],
    ['an unknown token', '--bgg: red;', /Unknown token --bgg/],
    ['a near-miss token', '--text_muted: red;', /Did you mean --text-muted\?/],
    ['a duplicate', `--bg: ${hexA};\n--bg: ${hexB};`, /declared twice \(first on line 1\)/],
    ['url()', '--bg: url(https://evil.example/x.png);', /contains ":"|url\(\), which is not allowed/],
    ['url() without a colon', '--bg: url(//evil.example/x.png);', /url\(\), which is not allowed/],
    ['var()', '--bg: var(--surface);', /var\(\), which is not allowed/],
    ['expression()', '--bg: expression(alert(1));', /expression\(\), which is not allowed/],
    ['a brace inside a value', `--bg: ${hexA} } body { color: red`, /Selectors and \{ \} blocks/],
    ['a quote', `--bg: "red";`, /contains """/],
    ['a backslash escape', '--bg: \\72 ed;', /contains "\\"/],
    ['a style tag', '--bg: red</style><script>x()</script>;', /contains "<"/],
    ['!important', '--bg: red !important;', /!important is not allowed/],
    ['not a colour', '--bg: banana split;', /is not a valid colour/],
    ['an empty value', '--bg: ;', /needs a value/],
    ['a too long value', `--bg: rgb(${'1 '.repeat(100)});`, /too long/],
    ['a bad color-scheme', 'color-scheme: sepia;', /color-scheme must be light or dark/],
    ['garbage', 'hello world', /Expected "--token: value;"/],
    ['an unterminated comment', `--bg: ${hexA};\n/* oops`, /Unterminated comment/],
    ['a comment hiding a rule', `/* } body { background: red } */\n--bg: ${hexA};`, /Comments cannot contain/],
    ['unbalanced parentheses', '--bg: rgb(1, 2, 3;', /unbalanced parentheses/],
  ]
  it.each(rejects)('rejects %s', (_, text, msg) => {
    const r = parse(text)
    expect(r.errors.length).toBeGreaterThan(0)
    expect(r.errors.map((e) => e.message).join('\n')).toMatch(msg)
  })

  it('reports the line where each bad declaration starts', () => {
    const r = parse(`/* one\n two */\n--bg: ${hexA};\n\n--nope: red;\n--text:\n  banana;\nwidth: 1px;`)
    expect(r.errors.map((e) => e.line)).toEqual([5, 6, 8])
    expect(r.tokens).toEqual({ bg: hexA })
  })

  it('rejects oversized input without scanning it', () => {
    expect(parse('--bg: red;'.repeat(6000)).errors[0]!.message).toMatch(/too long/)
  })
})

describe('checkTokenValue', () => {
  it('validates shadow-pop as a box-shadow and everything else as a colour', () => {
    expect(checkTokenValue('shadow-pop', '0 8px 28px rgba(0, 0, 0, 0.4)', supports)).toBeNull()
    expect(checkTokenValue('bg', '0 8px 28px rgba(0, 0, 0, 0.4)', supports)).toMatch(/not a valid colour/)
    expect(checkTokenValue('shadow-pop', 'red', supports)).toMatch(/not a valid box-shadow/)
  })

  it('falls back to a grammar check without CSS.supports', () => {
    expect(checkTokenValue('bg', hexA, undefined)).toBeNull()
    expect(checkTokenValue('bg', 'rebeccapurple', undefined)).toBeNull()
    expect(checkTokenValue('bg', '#12', undefined)).toMatch(/not a valid colour/)
    expect(checkTokenValue('bg', 'url(x)', undefined)).toMatch(/url\(\)/)
  })
})

const theme = (over: Partial<CustomTheme> = {}): CustomTheme => ({
  id: 'custom:1234-abcd',
  label: 'Night owl',
  scheme: 'dark',
  base: 'midnight',
  tokens: { bg: hexA, text: hexB, accent: '#7c5cff', 'accent-fg': '#ffffff' },
  ...over,
})

describe('themeToCss round trip', () => {
  it('prints what parseThemeCss reads back, grouped with comments', () => {
    const t = theme({ tokens: { bg: hexA, 'var-ok': hexB, 'm-get': hexB } })
    const css = themeToCss(t)
    expect(css).toMatch(/^\/\* Base: Midnight \(dark\)/)
    expect(css).toContain('/* variable highlighting */')
    const back = parse(css)
    expect(back.errors).toEqual([])
    expect(back.tokens).toEqual(t.tokens)
    expect(back.scheme).toBe('dark')
  })

  it('every token belongs to exactly one form group', () => {
    const all = TOKEN_GROUPS.flatMap((g) => g.tokens.map((i) => i.token))
    expect([...all].sort()).toEqual([...THEME_TOKENS].sort())
  })
})

describe('customThemeRule', () => {
  it('generates one rule for the palette and one for the accent tokens, from the validated map only', () => {
    expect(customThemeRule(theme())).toBe(
      `[data-theme][data-custom-theme='custom:1234-abcd']{color-scheme:dark;--bg:${hexA};--text:${hexB};}\n` +
        `[data-theme][data-custom-theme='custom:1234-abcd']:not([data-accent]){--accent:#7c5cff;--accent-fg:#ffffff;}`,
    )
    expect(customThemeRule(theme({ tokens: { bg: hexA } }))).not.toContain(':not(')
  })

  it('never emits unsafe ids, tokens or values even if they reach it', () => {
    expect(customThemeRule(theme({ id: "custom:x'] body{" }))).toBe('')
    const rule = customThemeRule(theme({ tokens: { bg: 'red;} body{display:none', text: 'url(x)', ...({ evil: 'red' } as object) } }))
    expect(rule).toBe("[data-theme][data-custom-theme='custom:1234-abcd']{color-scheme:dark;}")
    expect(customThemesCss([theme(), theme({ id: 'custom:two', scheme: 'light', tokens: {} })]).split('\n')).toHaveLength(3)
  })

  it('maps a theme id to the element attributes', () => {
    const t = theme()
    expect(themeAttributes('nord', [t])).toEqual({ 'data-theme': 'nord' })
    expect(themeAttributes(t.id, [t])).toEqual({ 'data-theme': 'midnight', 'data-custom-theme': t.id })
    expect(themeAttributes('custom:gone', [t])).toEqual({ 'data-theme': 'dark' })
  })

  it('makes ids that pass its own check', () => {
    const id = newCustomThemeId()
    expect(isCustomThemeId(id)).toBe(true)
    expect(newCustomThemeId()).not.toBe(id)
    expect(isCustomThemeId('custom:')).toBe(false)
    expect(isCustomThemeId('nord')).toBe(false)
  })
})

function memStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init))
  return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => void m.set(k, v), raw: m }
}

describe('persistence', () => {
  it('round-trips themes under slinger.customThemes with a version field', () => {
    const s = memStore()
    saveCustomThemes(s, [theme(), theme({ id: 'custom:b', label: 'Paper 2', scheme: 'light', base: 'paper', tokens: {} })])
    expect(JSON.parse(s.raw.get(CUSTOM_THEMES_KEY)!).v).toBe(1)
    expect(loadCustomThemes(s, supports)).toEqual([theme(), theme({ id: 'custom:b', label: 'Paper 2', scheme: 'light', base: 'paper', tokens: {} })])
  })

  it.each([
    ['not JSON', '{nope'],
    ['a newer version', JSON.stringify({ v: 2, themes: [theme()] })],
    ['themes not an array', JSON.stringify({ v: 1, themes: {} })],
    ['null', 'null'],
  ])('ignores corrupted data (%s)', (_, raw) => {
    expect(loadCustomThemes(memStore({ [CUSTOM_THEMES_KEY]: raw }), supports)).toEqual([])
  })

  it('skips broken entries, drops invalid tokens, fixes unknown bases, dedupes ids and caps the list', () => {
    const entries = [
      null,
      { id: 'nope', label: 'x', scheme: 'dark', base: 'dark', tokens: {} },
      { id: 'custom:a', label: '  A\n theme ', scheme: 'weird', base: 'gone-theme', tokens: { bg: hexA, text: 'url(x)', zzz: 'red', surface: 5 } },
      { id: 'custom:a', label: 'dupe', scheme: 'dark', base: 'dark', tokens: {} },
      ...Array.from({ length: 60 }, (_, i) => ({ id: `custom:n${i}`, label: `n${i}`, scheme: 'light', base: 'light', tokens: {} })),
    ]
    const out = loadCustomThemes(memStore({ [CUSTOM_THEMES_KEY]: JSON.stringify({ v: 1, themes: entries }) }), supports)
    expect(out).toHaveLength(MAX_CUSTOM_THEMES)
    expect(out[0]).toEqual({ id: 'custom:a', label: 'A theme', scheme: 'dark', base: 'dark', tokens: { bg: hexA } })
  })
})

describe('import / export', () => {
  it('exports a versioned JSON file that imports back unchanged', () => {
    const { id: _id, ...data } = theme()
    const file = themeToFile(data)
    expect(JSON.parse(file)).toEqual({ format: 'slinger-theme', version: 1, label: 'Night owl', scheme: 'dark', base: 'midnight', tokens: data.tokens })
    expect(parseThemeImport(file, supports)).toEqual({ theme: data, errors: [], warnings: [] })
  })

  it('rejects files that are not Slinger themes or from a newer version', () => {
    expect(parseThemeImport(JSON.stringify({ info: { name: 'a Postman collection' } }), supports).errors[0]).toMatch(/Not a Slinger theme/)
    expect(parseThemeImport(JSON.stringify({ format: 'slinger-theme', version: 9, tokens: {} }), supports).errors[0]).toMatch(/Unsupported theme file version 9/)
    expect(parseThemeImport('   ', supports).errors[0]).toMatch(/Nothing to import/)
    expect(parseThemeImport('x'.repeat(60_000), supports).errors[0]).toMatch(/too large/)
  })

  it('treats a theme file as untrusted: invalid tokens are dropped with a warning, the label is cleaned', () => {
    const file = JSON.stringify({
      format: 'slinger-theme',
      version: 1,
      label: `${'L'.repeat(80)}\u0000`,
      scheme: 'light',
      base: 'no-such-theme',
      tokens: { bg: hexB, text: 'red;} html{display:none', surface: 'var(--x)', bogus: 'red' },
    })
    const r = parseThemeImport(file, supports)
    expect(r.errors).toEqual([])
    expect(r.theme).toEqual({ label: 'L'.repeat(60), scheme: 'light', base: 'light', tokens: { bg: hexB } })
    expect(r.warnings.join('\n')).toMatch(/Unknown base theme/)
    expect(r.warnings.join('\n')).toMatch(/--text contains ";"/)
    expect(r.warnings.join('\n')).toMatch(/--surface uses var\(\)/)
    expect(r.warnings.join('\n')).toMatch(/--bogus: unknown token/)
  })

  it('accepts pasted CSS declarations, guessing the scheme from --bg when color-scheme is missing', () => {
    const r = parseThemeImport(`--bg: #fafafa;\n--text: #111111;`, supports)
    expect(r.theme).toEqual({ label: 'Imported theme', scheme: 'light', base: 'light', tokens: { bg: '#fafafa', text: '#111111' } })
    expect(parseThemeImport(`color-scheme: dark;\n--bg: #fafafa;`, supports).theme!.base).toBe('dark')
    expect(parseThemeImport(':root { --bg: red; }', supports).errors[0]).toMatch(/^Line 1: Selectors/)
    expect(parseThemeImport('/* nothing */', supports).errors[0]).toMatch(/No theme tokens/)
  })
})

describe('public/theme-init.js', () => {
  // (a variable path: Vite rewrites literal `new URL('...', import.meta.url)` asset references)
  const path = '../../public/theme-init.js'
  const script = readFileSync(new URL(path, import.meta.url), 'utf8')
  const run = () => new Function(script)()
  const html = document.documentElement

  beforeEach(() => {
    localStorage.clear()
    html.removeAttribute('data-theme')
    html.removeAttribute('data-accent')
    html.removeAttribute('data-custom-theme')
    document.getElementById('slinger-custom-themes')?.remove()
  })

  it('applies a stored custom theme before first paint with exactly the rule the app generates', () => {
    const t = theme({ tokens: { bg: hexA, text: hexB, 'accent-soft': 'color-mix(in srgb, #7c5cff 20%, #121a2e)', 'shadow-pop': '0 8px 28px rgba(0, 0, 0, 0.4)' } })
    localStorage.setItem('slinger.appearance', JSON.stringify({ v: 1, theme: t.id, accent: 'violet' }))
    saveCustomThemes({ get: (k) => localStorage.getItem(k), set: (k, v) => localStorage.setItem(k, v) }, [theme({ id: 'custom:other' }), t])
    run()
    expect(html.dataset.theme).toBe('midnight')
    expect(html.dataset.customTheme).toBe(t.id)
    expect(html.dataset.accent).toBe('violet')
    expect(document.getElementById('slinger-custom-themes')!.textContent).toBe(customThemeRule(t))
  })

  it('uses a custom theme picked for the System slot', () => {
    const t = theme({ scheme: 'dark' })
    localStorage.setItem('slinger.appearance', JSON.stringify({ v: 1, theme: 'system', systemDark: t.id }))
    localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify({ v: 1, themes: [t] }))
    run() // test/setup.ts: matchMedia never matches, so the OS is "dark"
    expect(html.dataset.theme).toBe('midnight')
    expect(html.dataset.customTheme).toBe(t.id)
  })

  it('falls back to Dark when the custom theme is missing or its stored data is unsafe', () => {
    localStorage.setItem('slinger.appearance', JSON.stringify({ v: 1, theme: 'custom:gone' }))
    run()
    expect(html.dataset.theme).toBe('dark')
    expect(html.dataset.customTheme).toBeUndefined()

    const evil = { id: 'custom:evil', label: 'x', scheme: 'dark', base: "dark'] *{", tokens: {} }
    localStorage.setItem('slinger.appearance', JSON.stringify({ v: 1, theme: evil.id }))
    localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify({ v: 1, themes: [evil] }))
    run()
    expect(html.dataset.theme).toBe('dark')
    expect(document.getElementById('slinger-custom-themes')).toBeNull()
  })

  it('skips unsafe stored values instead of injecting them', () => {
    const t = { id: 'custom:x', label: 'x', scheme: 'light', base: 'light', tokens: { bg: 'red;}*{display:none', text: 'url(//e.example)', surface: hexB } }
    localStorage.setItem('slinger.appearance', JSON.stringify({ v: 1, theme: t.id }))
    localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify({ v: 1, themes: [t] }))
    run()
    expect(document.getElementById('slinger-custom-themes')!.textContent).toBe(`[data-theme][data-custom-theme='custom:x']{color-scheme:light;--surface:${hexB};}`)
  })
})

describe('newThemeFrom', () => {
  it('starts from a built-in theme as the base, or duplicates a custom one, with a unique name', () => {
    const t = theme()
    const fromBuiltin = newThemeFrom('nord', [t])
    expect(fromBuiltin).toMatchObject({ label: 'My Nord', scheme: 'dark', base: 'nord', tokens: {} })
    expect(isCustomThemeId(fromBuiltin.id)).toBe(true)
    const copy = newThemeFrom(t.id, [t])
    expect(copy).toMatchObject({ label: 'Night owl copy', base: 'midnight', tokens: t.tokens })
    expect(copy.id).not.toBe(t.id)
    expect(copy.tokens).not.toBe(t.tokens)
    expect(uniqueLabel('Night owl', [t, { ...t, label: 'Night owl 2' }])).toBe('Night owl 3')
  })
})

describe('parseThemeCss error list', () => {
  it('reports the same problem on the same line once', () => {
    expect(parseThemeCss(':root { --bg: red; }', supports).errors).toHaveLength(1)
  })
})
