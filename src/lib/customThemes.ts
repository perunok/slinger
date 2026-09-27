/**
 * User-defined custom themes: the data model, the strict "CSS config" parser, the CSS rule generator, persistence and
 * the `.slinger-theme.json` file format. Pure logic (no DOM); the browser's `CSS.supports` is passed in where needed.
 *
 * A custom theme names a built-in `base` theme and overrides any subset of THEME_TOKENS. On <html> (and on preview
 * elements) it is shown as `data-theme='<base>' data-custom-theme='custom:<uuid>'`: the base palette comes from
 * themes.css as usual and the generated rule (higher specificity) layers the overrides on top, so every token the
 * user did not set keeps following the base theme. Accent tokens are emitted under `:not([data-accent])`, so a chosen
 * accent replaces them exactly as it does for built-in themes.
 *
 * The user's text is never injected as CSS: it is parsed into a validated token map (known tokens only, colour values
 * only, a small character set, a whitelist of colour functions) and the rule is generated from that map.
 * public/theme-init.js rebuilds the active theme's rule from the stored map before first paint; keep the two in step
 * (customThemes.test.ts runs the script and compares its output with customThemeRule()).
 */
import { ACCENT_TOKENS, DEFAULT_DARK_THEME, DEFAULT_LIGHT_THEME, THEMES, THEME_TOKENS, findTheme, type Scheme, type ThemeInfo } from './themes'

export type ThemeToken = (typeof THEME_TOKENS)[number]
export type ThemeTokens = Partial<Record<ThemeToken, string>>

export interface CustomTheme {
  /** `custom:<uuid>` */
  id: string
  label: string
  scheme: Scheme
  /** A built-in theme id; tokens the custom theme does not set come from it. */
  base: string
  tokens: ThemeTokens
}

/** A custom theme without its id (a draft, an imported file). */
export type CustomThemeData = Omit<CustomTheme, 'id'>

export const CUSTOM_THEME_PREFIX = 'custom:'
export const CUSTOM_THEMES_KEY = 'slinger.customThemes'
export const CUSTOM_THEMES_STYLE_ID = 'slinger-custom-themes'
export const MAX_CUSTOM_THEMES = 50
export const MAX_TOKEN_VALUE_LENGTH = 160
export const MAX_THEME_LABEL_LENGTH = 60
/** Longest CSS config / theme file accepted (a full theme is about 2 KB). */
export const MAX_THEME_TEXT_LENGTH = 50_000
export const THEME_FILE_FORMAT = 'slinger-theme'
export const THEME_FILE_VERSION = 1
export const THEME_FILE_EXT = '.slinger-theme.json'

const TOKEN_SET = new Set<string>(THEME_TOKENS)
const ACCENT_SET = new Set<string>(ACCENT_TOKENS)

export function isThemeToken(name: string): name is ThemeToken {
  return TOKEN_SET.has(name)
}

export function isCustomThemeId(id: unknown): id is string {
  return typeof id === 'string' && /^custom:[a-z0-9-]{1,64}$/.test(id)
}

export function newCustomThemeId(): string {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return `${CUSTOM_THEME_PREFIX}${uuid}`
}

// ------------------------------------------------------------------------------------------------ token metadata

export interface TokenInfo {
  token: ThemeToken
  label: string
  hint: string
}

export interface TokenGroup {
  label: string
  tokens: TokenInfo[]
}

const t = (token: ThemeToken, label: string, hint: string): TokenInfo => ({ token, label, hint })

/** Every token with a human label and what it is used for (form view, contrast warnings, docs). */
export const TOKEN_GROUPS: TokenGroup[] = [
  {
    label: 'Surfaces and borders',
    tokens: [
      t('bg', 'Background', 'Page background, input fields'),
      t('surface', 'Surface', 'Panels, editors, dialogs'),
      t('surface-raised', 'Raised surface', 'Sidebar, toolbars, default buttons'),
      t('surface-hover', 'Hover', 'Hovered rows and buttons'),
      t('border', 'Border', 'Dividers and control outlines'),
      t('border-strong', 'Strong border', 'Emphasised outlines'),
    ],
  },
  {
    label: 'Text',
    tokens: [
      t('text', 'Text', 'Body text'),
      t('text-muted', 'Muted text', 'Secondary text, labels'),
      t('text-faint', 'Faint text', 'Hints and placeholders'),
    ],
  },
  {
    label: 'Accent (replaced when you pick an accent colour)',
    tokens: [
      t('accent', 'Accent', 'Primary buttons, selected borders'),
      t('accent-fg', 'Text on accent', 'Text on primary buttons'),
      t('accent-soft', 'Accent background', 'Selected rows, badges'),
      t('accent-text', 'Accent text', 'Links and accent-coloured text'),
      t('focus-ring', 'Focus ring', 'Keyboard focus outline'),
      t('selection', 'Selection', 'Selected text in editors'),
    ],
  },
  {
    label: 'Status',
    tokens: [
      t('danger', 'Danger', 'Errors, 4xx/5xx status'),
      t('danger-fg', 'Text on danger', 'Text on delete buttons'),
      t('danger-soft', 'Danger background', 'Error banners and badges'),
      t('success', 'Success', '2xx status, passed tests'),
      t('success-soft', 'Success background', 'Success badges'),
      t('warning', 'Warning', 'Warnings, 3xx status'),
      t('warning-soft', 'Warning background', 'Warning banners and badges'),
    ],
  },
  {
    label: 'Misc',
    tokens: [
      t('preview-bg', 'HTML preview', 'Background of the HTML response preview'),
      t('overlay', 'Overlay', 'Backdrop behind dialogs (usually translucent)'),
      t('shadow-pop', 'Popup shadow', 'box-shadow of menus and popovers (not a colour)'),
    ],
  },
  {
    label: '{{variable}} highlighting',
    tokens: [
      t('var-ok', 'Resolved variable', 'Text of a known {{variable}}'),
      t('var-ok-bg', 'Resolved variable background', ''),
      t('var-bad', 'Unresolved variable', 'Text of an unknown {{variable}}'),
      t('var-bad-bg', 'Unresolved variable background', ''),
      t('var-secret', 'Secret variable', 'Text of a secret {{variable}}'),
      t('var-secret-bg', 'Secret variable background', ''),
    ],
  },
  {
    label: 'Syntax highlighting',
    tokens: [
      t('syn-keyword', 'Keyword', 'null, keywords'),
      t('syn-string', 'String', ''),
      t('syn-number', 'Number', ''),
      t('syn-bool', 'Boolean', ''),
      t('syn-comment', 'Comment', ''),
      t('syn-property', 'Property', 'JSON keys'),
      t('syn-tag', 'Tag', 'XML/HTML tags'),
      t('syn-attr', 'Attribute', 'XML/HTML attributes'),
      t('syn-punct', 'Punctuation', 'Brackets, commas'),
    ],
  },
  {
    label: 'HTTP methods',
    tokens: [
      t('m-get', 'GET', ''),
      t('m-post', 'POST', ''),
      t('m-put', 'PUT', ''),
      t('m-patch', 'PATCH', ''),
      t('m-delete', 'DELETE', ''),
      t('m-other', 'Other methods', 'HEAD, OPTIONS, ...'),
    ],
  },
]

const TOKEN_INFO = new Map<string, TokenInfo>(TOKEN_GROUPS.flatMap((g) => g.tokens.map((i) => [i.token, i] as const)))

export function tokenLabel(token: string): string {
  return TOKEN_INFO.get(token)?.label ?? token
}

// ------------------------------------------------------------------------------------------------ value validation

/** `CSS.supports(property, value)`; undefined outside a browser (unit tests), where only the grammar is checked. */
export type Supports = (property: string, value: string) => boolean

export function browserSupports(): Supports | undefined {
  const css = (globalThis as { CSS?: { supports?: (p: string, v: string) => boolean } }).CSS
  return typeof css?.supports === 'function' ? (p, v) => css.supports!(p, v) : undefined
}

/** Characters a colour (or box-shadow) value may contain. Excludes `; : { } < > @ " ' \` so nothing can break out. */
const SAFE_CHARS = /^[a-zA-Z0-9#(),.%\s/+-]+$/
/** Functions allowed in values: colour functions only (no url(), var(), env(), attr(), image(), expression() ...). */
export const ALLOWED_FUNCTIONS = ['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix', 'light-dark']

/** The CSS property a token's value is validated against. */
export function tokenProperty(token: ThemeToken): 'color' | 'box-shadow' {
  return token === 'shadow-pop' ? 'box-shadow' : 'color'
}

/** Null when `value` is acceptable for `token`, otherwise a message (without the token name). */
export function checkTokenValue(token: ThemeToken, value: string, supports: Supports | undefined = browserSupports()): string | null {
  const v = value.trim()
  if (!v) return 'needs a value'
  if (v.length > MAX_TOKEN_VALUE_LENGTH) return `is too long (at most ${MAX_TOKEN_VALUE_LENGTH} characters)`
  if (/!\s*important/i.test(v)) return '!important is not allowed'
  if (!SAFE_CHARS.test(v)) {
    const bad = [...v].find((c) => !SAFE_CHARS.test(c))
    return `contains "${bad}", which a colour never needs (allowed: letters, digits, spaces and # ( ) , . % / + -)`
  }
  for (const m of v.matchAll(/([a-zA-Z_-][\w-]*)?\s*\(/g)) {
    const fn = (m[1] ?? '').toLowerCase()
    if (!ALLOWED_FUNCTIONS.includes(fn)) {
      return fn ? `uses ${fn}(), which is not allowed (colour functions only: ${ALLOWED_FUNCTIONS.join(', ')})` : 'has a "(" without a function name'
    }
  }
  let depth = 0
  for (const c of v) {
    if (c === '(') depth++
    if (c === ')' && --depth < 0) break
  }
  if (depth !== 0) return 'has unbalanced parentheses'
  const property = tokenProperty(token)
  if (supports) {
    if (!supports(property, v)) return `"${short(v)}" is not a valid ${property === 'color' ? 'colour' : 'box-shadow'}`
  } else if (property === 'color' && !/^(#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|[a-z]+|[a-z-]+\(.*\))$/i.test(v)) {
    return `"${short(v)}" is not a valid colour`
  }
  return null
}

function short(s: string, n = 40): string {
  const one = s.replace(/\s+/g, ' ')
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

// ------------------------------------------------------------------------------------------------ CSS config

export interface CssIssue {
  line: number
  message: string
}

export interface ParsedThemeCss {
  tokens: ThemeTokens
  /** From a `color-scheme: light|dark;` declaration, if present. */
  scheme?: Scheme
  errors: CssIssue[]
}

/**
 * Parses the CSS config: a list of `--<token>: <colour>;` declarations (plus optional `color-scheme: light|dark;`),
 * comments allowed. Anything else (selectors, braces, @-rules, unknown properties or tokens, non-colour values,
 * url()/var()/expression(), duplicates) is reported with its 1-based line number. Nothing is returned as CSS text.
 */
export function parseThemeCss(text: string, supports: Supports | undefined = browserSupports()): ParsedThemeCss {
  const errors: CssIssue[] = []
  const tokens: ThemeTokens = {}
  const seen = new Map<string, number>()
  let scheme: Scheme | undefined
  if (text.length > MAX_THEME_TEXT_LENGTH) {
    return { tokens, errors: [{ line: 1, message: `The theme is too long (at most ${MAX_THEME_TEXT_LENGTH} characters).` }] }
  }

  const declaration = (raw: string, line: number) => {
    const s = raw.trim()
    if (!s) return
    if (s.startsWith('@')) return void errors.push({ line, message: `@-rules are not allowed (found "${short(s)}"). Write only declarations such as --bg: #rrggbb;` })
    if (/[{}]/.test(s)) return void errors.push({ line, message: 'Selectors and { } blocks are not allowed. Write only declarations such as --bg: #rrggbb;' })
    const colon = s.indexOf(':')
    if (colon < 0) return void errors.push({ line, message: `Expected "--token: value;" but found "${short(s)}".` })
    const name = s.slice(0, colon).trim()
    const value = s.slice(colon + 1).replace(/\s+/g, ' ').trim()
    if (!name) return void errors.push({ line, message: 'A declaration is missing its property name.' })
    const first = seen.get(name)
    if (first !== undefined) return void errors.push({ line, message: `${name} is declared twice (first on line ${first}).` })
    seen.set(name, line)
    if (name === 'color-scheme') {
      if (value === 'light' || value === 'dark') scheme = value
      else errors.push({ line, message: 'color-scheme must be light or dark.' })
      return
    }
    if (!name.startsWith('--')) return void errors.push({ line, message: `Only theme tokens (--name) and color-scheme can be set, not "${short(name)}".` })
    const token = name.slice(2)
    if (!isThemeToken(token)) {
      const near = THEME_TOKENS.find((k) => k.replace(/-/g, '') === token.toLowerCase().replace(/[-_]/g, ''))
      return void errors.push({ line, message: `Unknown token ${short(name)}.${near ? ` Did you mean --${near}?` : ''}` })
    }
    const problem = checkTokenValue(token, value, supports)
    if (problem) return void errors.push({ line, message: `${name} ${problem}.` })
    tokens[token] = value
  }

  let line = 1
  let buf = ''
  let startLine = 1
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end < 0) {
        errors.push({ line, message: 'Unterminated comment (missing */).' })
        buf = ''
        break
      }
      const body = text.slice(i + 2, end)
      if (/[{}]|<\//.test(body)) errors.push({ line, message: 'Comments cannot contain "{", "}" or "</".' })
      line += body.split('\n').length - 1
      buf += ' '
      i = end + 2
      continue
    }
    if (ch === ';') {
      declaration(buf, startLine)
      buf = ''
      i++
      continue
    }
    if (!buf.trim() && !/\s/.test(ch)) startLine = line
    if (ch === '\n') line++
    buf += ch
    i++
  }
  declaration(buf, startLine)
  const unique = errors.filter((e, i) => errors.findIndex((x) => x.line === e.line && x.message === e.message) === i)
  unique.sort((a, b) => a.line - b.line)
  return { tokens: orderTokens(tokens), scheme, errors: unique }
}

/** Tokens in THEME_TOKENS order (stable output for the CSS view, storage and the generated rule). */
export function orderTokens(tokens: ThemeTokens): ThemeTokens {
  const out: ThemeTokens = {}
  for (const k of THEME_TOKENS) if (tokens[k] !== undefined) out[k] = tokens[k]
  return out
}

/** The CSS config text for a theme (what the CSS view shows). */
export function themeToCss(theme: Pick<CustomThemeData, 'scheme' | 'base' | 'tokens'>): string {
  const base = findTheme(theme.base)
  const lines = [
    `/* Base: ${base ? `${base.label} (${base.scheme})` : theme.base}. Tokens you leave out come from the base theme. */`,
    `color-scheme: ${theme.scheme};`,
  ]
  for (const g of TOKEN_GROUPS) {
    const set = g.tokens.filter((i) => theme.tokens[i.token] !== undefined)
    if (!set.length) continue
    lines.push('', `/* ${g.label.replace(/[{}*/]/g, '')} */`)
    for (const i of set) lines.push(`--${i.token}: ${theme.tokens[i.token]};`)
  }
  return lines.join('\n') + '\n'
}

// ------------------------------------------------------------------------------------------------ generated CSS

/**
 * The CSS for one custom theme, generated from its validated token map. Selector specificity: (0,2,0) beats the base
 * `[data-theme='<id>']` block; the accent part (0,3,0) only applies without `data-accent`, so a chosen accent wins
 * like it does over built-in themes. public/theme-init.js builds the same string.
 */
export function customThemeRule(theme: Pick<CustomTheme, 'id' | 'scheme' | 'tokens'>): string {
  if (!isCustomThemeId(theme.id)) return ''
  const sel = `[data-theme][data-custom-theme='${theme.id}']`
  let main = `color-scheme:${theme.scheme === 'light' ? 'light' : 'dark'};`
  let accent = ''
  for (const [k, v] of Object.entries(theme.tokens)) {
    if (!isThemeToken(k) || typeof v !== 'string' || !isSafeStoredValue(v)) continue
    if (ACCENT_SET.has(k)) accent += `--${k}:${v};`
    else main += `--${k}:${v};`
  }
  return `${sel}{${main}}` + (accent ? `\n${sel}:not([data-accent]){${accent}}` : '')
}

export function customThemesCss(themes: Pick<CustomTheme, 'id' | 'scheme' | 'tokens'>[]): string {
  return themes.map(customThemeRule).filter(Boolean).join('\n')
}

/** The cheap re-check theme-init.js also does on stored values (defence in depth; full validation happens on input). */
export function isSafeStoredValue(v: string): boolean {
  if (v.length > MAX_TOKEN_VALUE_LENGTH || !SAFE_CHARS.test(v)) return false
  for (const m of v.matchAll(/([a-zA-Z_-][\w-]*)?\s*\(/g)) if (!ALLOWED_FUNCTIONS.includes((m[1] ?? '').toLowerCase())) return false
  return true
}

/** Attributes that show `id` (a built-in or custom theme) on an element; unknown custom ids fall back to a default. */
export function themeAttributes(id: string, customs: readonly CustomTheme[]): { 'data-theme': string; 'data-custom-theme'?: string } {
  if (!id.startsWith(CUSTOM_THEME_PREFIX)) return { 'data-theme': id }
  const c = customs.find((x) => x.id === id)
  if (!c) return { 'data-theme': DEFAULT_DARK_THEME }
  return { 'data-theme': c.base, 'data-custom-theme': c.id }
}

export interface CustomThemeInfo extends ThemeInfo {
  custom: true
  base: string
}

export function customThemeInfo(c: CustomTheme): CustomThemeInfo {
  return { id: c.id, label: c.label, scheme: c.scheme, custom: true, base: c.base }
}

// ------------------------------------------------------------------------------------------------ sanitising

function cleanLabel(v: unknown, fallback: string): string {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : ''
  return (s || fallback).slice(0, MAX_THEME_LABEL_LENGTH)
}

export function defaultBaseFor(scheme: Scheme): string {
  return scheme === 'light' ? DEFAULT_LIGHT_THEME : DEFAULT_DARK_THEME
}

/**
 * Validates untrusted theme data (storage, an imported file). Invalid tokens are dropped and reported in `dropped`;
 * returns null when the shape is not a theme at all.
 */
export function sanitizeThemeData(
  raw: unknown,
  supports: Supports | undefined = browserSupports(),
): { theme: CustomThemeData; dropped: string[] } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const dropped: string[] = []
  const baseInfo = typeof r.base === 'string' ? findTheme(r.base) : undefined
  const scheme: Scheme = r.scheme === 'light' || r.scheme === 'dark' ? r.scheme : (baseInfo?.scheme ?? 'dark')
  const tokens: ThemeTokens = {}
  if (r.tokens && typeof r.tokens === 'object' && !Array.isArray(r.tokens)) {
    for (const [k, v] of Object.entries(r.tokens as Record<string, unknown>)) {
      if (!isThemeToken(k)) {
        dropped.push(`--${short(k, 30)}: unknown token`)
        continue
      }
      const problem = typeof v === 'string' ? checkTokenValue(k, v, supports) : 'must be a string'
      if (problem) dropped.push(`--${k} ${problem}`)
      else tokens[k] = (v as string).replace(/\s+/g, ' ').trim()
    }
  } else if (r.tokens !== undefined) dropped.push('tokens must be an object')
  return {
    theme: { label: cleanLabel(r.label, 'Custom theme'), scheme, base: baseInfo ? baseInfo.id : defaultBaseFor(scheme), tokens: orderTokens(tokens) },
    dropped,
  }
}

// ------------------------------------------------------------------------------------------------ persistence

export interface KeyValueStore {
  get(key: string): string | null
  set(key: string, value: string): void
}

export const CUSTOM_THEMES_VERSION = 1

/** Loads the stored custom themes; anything corrupt is skipped (a broken entry never breaks the others). */
export function loadCustomThemes(store: KeyValueStore, supports: Supports | undefined = browserSupports()): CustomTheme[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(store.get(CUSTOM_THEMES_KEY) ?? 'null')
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object') return []
  const { v, themes } = parsed as { v?: unknown; themes?: unknown }
  if (v !== CUSTOM_THEMES_VERSION || !Array.isArray(themes)) return []
  const out: CustomTheme[] = []
  for (const raw of themes) {
    if (out.length >= MAX_CUSTOM_THEMES) break
    const id = (raw as { id?: unknown } | null)?.id
    if (!isCustomThemeId(id) || out.some((c) => c.id === id)) continue
    const s = sanitizeThemeData(raw, supports)
    if (s) out.push({ id, ...s.theme })
  }
  return out
}

export function saveCustomThemes(store: KeyValueStore, themes: readonly CustomTheme[]): void {
  const clean = themes.slice(0, MAX_CUSTOM_THEMES).map((c) => ({ id: c.id, label: c.label, scheme: c.scheme, base: c.base, tokens: orderTokens(c.tokens) }))
  store.set(CUSTOM_THEMES_KEY, JSON.stringify({ v: CUSTOM_THEMES_VERSION, themes: clean }))
}

// ------------------------------------------------------------------------------------------------ import / export

export interface ThemeFile {
  format: typeof THEME_FILE_FORMAT
  version: typeof THEME_FILE_VERSION
  label: string
  scheme: Scheme
  base: string
  tokens: ThemeTokens
}

export function themeToFile(theme: CustomThemeData): string {
  const file: ThemeFile = {
    format: THEME_FILE_FORMAT,
    version: THEME_FILE_VERSION,
    label: theme.label,
    scheme: theme.scheme,
    base: theme.base,
    tokens: orderTokens(theme.tokens),
  }
  return JSON.stringify(file, null, 2) + '\n'
}

export interface ParsedThemeImport {
  theme: CustomThemeData | null
  /** Why nothing could be imported. */
  errors: string[]
  /** Parts that were skipped (invalid tokens); the rest was imported. */
  warnings: string[]
}

/**
 * Reads an imported theme: a `.slinger-theme.json` file, or pasted CSS (a declaration block as the CSS view shows it;
 * for CSS every problem is an error, as in the editor). Untrusted input: validated with the same rules as the editor.
 */
export function parseThemeImport(text: string, supports: Supports | undefined = browserSupports(), fallbackLabel = 'Imported theme'): ParsedThemeImport {
  if (text.length > MAX_THEME_TEXT_LENGTH) return { theme: null, errors: [`The file is too large (at most ${MAX_THEME_TEXT_LENGTH} characters).`], warnings: [] }
  const trimmed = text.trim()
  if (!trimmed) return { theme: null, errors: ['Nothing to import.'], warnings: [] }
  if (trimmed.startsWith('{')) {
    let json: unknown
    try {
      json = JSON.parse(trimmed)
    } catch {
      // `{` could also start a CSS block; that is rejected by the CSS parser below with a clearer message.
      json = undefined
    }
    if (json !== undefined) {
      const f = json as Partial<ThemeFile> | null
      if (!f || typeof f !== 'object' || f.format !== THEME_FILE_FORMAT) return { theme: null, errors: ['Not a Slinger theme file (expected "format": "slinger-theme").'], warnings: [] }
      if (f.version !== THEME_FILE_VERSION) return { theme: null, errors: [`Unsupported theme file version ${String(f.version)} (this Slinger reads version ${THEME_FILE_VERSION}).`], warnings: [] }
      const warnings: string[] = []
      if (typeof f.base !== 'string' || !findTheme(f.base)) warnings.push(`Unknown base theme "${short(String(f.base ?? ''), 30)}"; using ${findTheme(defaultBaseFor(f.scheme === 'light' ? 'light' : 'dark'))!.label}.`)
      const s = sanitizeThemeData(json, supports)
      if (!s) return { theme: null, errors: ['Not a Slinger theme file.'], warnings: [] }
      return { theme: s.theme, errors: [], warnings: [...warnings, ...s.dropped] }
    }
  }
  const parsed = parseThemeCss(text, supports)
  if (parsed.errors.length) return { theme: null, errors: parsed.errors.map((e) => `Line ${e.line}: ${e.message}`), warnings: [] }
  if (!Object.keys(parsed.tokens).length) return { theme: null, errors: ['No theme tokens found (expected declarations such as --bg: #rrggbb;).'], warnings: [] }
  const scheme = parsed.scheme ?? guessScheme(parsed.tokens)
  return { theme: { label: fallbackLabel, scheme, base: defaultBaseFor(scheme), tokens: parsed.tokens }, errors: [], warnings: [] }
}

/** Without a color-scheme declaration: light when --bg is a light hex colour, else dark. */
function guessScheme(tokens: ThemeTokens): Scheme {
  const m = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(tokens.bg ?? '')
  if (!m) return 'dark'
  const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join('') : m[1]!
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
  return 0.299 * r! + 0.587 * g! + 0.114 * b! > 140 ? 'light' : 'dark'
}

/** Built-in themes a custom theme can be based on. */
export const BASE_THEMES: readonly ThemeInfo[] = THEMES

/** `label`, or `label 2`, `label 3`, ... so it does not repeat an existing custom theme's name. */
export function uniqueLabel(label: string, customs: readonly { label: string }[]): string {
  const base = cleanLabel(label, 'Custom theme')
  const taken = new Set(customs.map((c) => c.label.toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`
    const candidate = `${base.slice(0, MAX_THEME_LABEL_LENGTH - suffix.length)}${suffix}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

/**
 * A new (unsaved) custom theme starting from any theme: a built-in one becomes the base with no overrides; a custom
 * one is duplicated (same base and overrides).
 */
export function newThemeFrom(sourceId: string, customs: readonly CustomTheme[]): CustomTheme {
  const c = customs.find((x) => x.id === sourceId)
  if (c) return { ...c, id: newCustomThemeId(), label: uniqueLabel(`${c.label} copy`, customs), tokens: { ...c.tokens } }
  const b = findTheme(sourceId) ?? findTheme(DEFAULT_DARK_THEME)!
  return { id: newCustomThemeId(), label: uniqueLabel(`My ${b.label}`, customs), scheme: b.scheme, base: b.id, tokens: {} }
}
