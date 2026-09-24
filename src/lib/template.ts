/**
 * `{{variable}}` template parsing and resolution. Pure functions, no DOM.
 * Used by TemplateInput, the CodeMirror template extension and the send pipeline
 * so behaviour is identical everywhere.
 */

export interface TemplateToken {
  /** Offset of the opening `{{`. */
  from: number
  /** Offset just after the closing `}}`. */
  to: number
  /** Full text including braces. */
  raw: string
  /** Trimmed variable name, e.g. `baseUrl` or `$guid`. */
  name: string
}

/** Name grammar: optional `$` then word chars, dots, dashes. */
const TOKEN_SOURCE = String.raw`\{\{\s*(\$?[\w.\-]+)\s*\}\}`

export function parseTokens(text: string): TemplateToken[] {
  const out: TemplateToken[] = []
  const re = new RegExp(TOKEN_SOURCE, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    out.push({ from: m.index, to: m.index + m[0].length, raw: m[0], name: m[1] })
  }
  return out
}

// ---------------------------------------------------------------------------
// Built-in dynamic variables
// ---------------------------------------------------------------------------

export interface BuiltinVariable {
  name: string
  description: string
  example: string
}

export const BUILTIN_VARIABLES: BuiltinVariable[] = [
  { name: '$guid', description: 'Random UUID v4', example: '7b9f4c6e-2a62-4f29-a97f-36a2f61c24d2' },
  { name: '$randomUUID', description: 'Alias of $guid', example: '7b9f4c6e-2a62-4f29-a97f-36a2f61c24d2' },
  { name: '$timestamp', description: 'Unix time in seconds', example: '1717432480' },
  { name: '$isoTimestamp', description: 'Current ISO 8601 time', example: '2026-06-03T16:00:00.000Z' },
  { name: '$date', description: 'Current UTC date', example: '2026-06-03' },
  { name: '$time', description: 'Current UTC time', example: '16:00:00' },
  { name: '$randomInt', description: 'Random integer 0-999999', example: '482391' },
  { name: '$randomString', description: 'Random alphanumeric string', example: 'k9x2qp7m' },
  { name: '$randomBoolean', description: 'Random true or false', example: 'true' },
  { name: '$randomEmail', description: 'Random example.com email', example: 'user_ab12cd34@example.com' },
]

const BUILTIN_NAMES = new Set(BUILTIN_VARIABLES.map((b) => b.name))

export function isBuiltin(name: string): boolean {
  return BUILTIN_NAMES.has(name)
}

function randomString(length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const bytes = new Uint32Array(length)
  crypto.getRandomValues(bytes)
  let s = ''
  for (const b of bytes) s += alphabet[b % alphabet.length]
  return s
}

export function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

/** Generates a fresh value for a built-in, or null when `name` is not a built-in. */
export function generateBuiltin(name: string, now = new Date()): string | null {
  switch (name) {
    case '$guid':
    case '$randomUUID':
      return uuid()
    case '$timestamp':
      return String(Math.floor(now.getTime() / 1000))
    case '$isoTimestamp':
      return now.toISOString()
    case '$date':
      return now.toISOString().slice(0, 10)
    case '$time':
      return now.toISOString().slice(11, 19)
    case '$randomInt':
      return String(Math.floor(Math.random() * 1_000_000))
    case '$randomString':
      return randomString(12)
    case '$randomBoolean':
      return Math.random() >= 0.5 ? 'true' : 'false'
    case '$randomEmail':
      return `user_${randomString(8).toLowerCase()}@example.com`
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

export interface VariableInfo {
  key: string
  /** Plain value. Always null for secrets (renderer only holds a masked value). */
  value: string | null
  secret: boolean
  /** Id of the environment variable row, used for reveal. */
  id?: string
  environmentName?: string
}

export interface TemplateScope {
  environmentName: string | null
  variables: ReadonlyMap<string, VariableInfo>
}

export const EMPTY_SCOPE: TemplateScope = { environmentName: null, variables: new Map() }

export function makeScope(environmentName: string | null, vars: VariableInfo[]): TemplateScope {
  const map = new Map<string, VariableInfo>()
  for (const v of vars) if (v.key) map.set(v.key, { ...v, environmentName: environmentName ?? undefined })
  return { environmentName, variables: map }
}

export type TokenStatus = 'resolved' | 'secret' | 'builtin' | 'unresolved'

export function tokenStatus(name: string, scope: TemplateScope): TokenStatus {
  const v = scope.variables.get(name)
  if (v) return v.secret ? 'secret' : 'resolved'
  if (isBuiltin(name)) return 'builtin'
  return 'unresolved'
}

export const SECRET_MASK = '••••••••'

/** What to show in a popover: masked for secrets. */
export function previewValue(name: string, scope: TemplateScope): string | null {
  const v = scope.variables.get(name)
  if (v) return v.secret ? SECRET_MASK : (v.value ?? '')
  const b = BUILTIN_VARIABLES.find((x) => x.name === name)
  return b ? `${b.example} (generated on send)` : null
}

/** Names used in `text` that neither the environment nor the built-ins define. */
export function findUnresolved(texts: Iterable<string>, scope: TemplateScope): string[] {
  const found = new Set<string>()
  for (const t of texts) {
    for (const tok of parseTokens(t)) if (tokenStatus(tok.name, scope) === 'unresolved') found.add(tok.name)
  }
  return [...found]
}

/** Names of secret variables referenced by `texts`. */
export function findSecretsUsed(texts: Iterable<string>, scope: TemplateScope): VariableInfo[] {
  const found = new Map<string, VariableInfo>()
  for (const t of texts) {
    for (const tok of parseTokens(t)) {
      const v = scope.variables.get(tok.name)
      if (v?.secret) found.set(v.key, v)
    }
  }
  return [...found.values()]
}

export interface ResolveOptions {
  /** Real values for secret variables (fetched via reveal at send time). */
  secrets?: ReadonlyMap<string, string>
  now?: Date
  /** Cache so a built-in evaluates to the same value everywhere within one request. */
  builtinCache?: Map<string, string>
}

/**
 * Substitutes every resolvable `{{token}}`; unresolved tokens are left verbatim.
 * A built-in gets one value per `builtinCache` (so `{{$guid}}` in URL and body match).
 */
export function resolveTemplate(text: string, scope: TemplateScope, opts: ResolveOptions = {}): string {
  if (!text.includes('{{')) return text
  const cache = opts.builtinCache
  return text.replace(new RegExp(TOKEN_SOURCE, 'g'), (raw, name: string) => {
    const v = scope.variables.get(name)
    if (v) {
      if (v.secret) return opts.secrets?.get(name) ?? raw
      return v.value ?? ''
    }
    if (isBuiltin(name)) {
      const cached = cache?.get(name)
      if (cached !== undefined) return cached
      const gen = generateBuiltin(name, opts.now)
      if (gen !== null) {
        cache?.set(name, gen)
        return gen
      }
    }
    return raw
  })
}

/** Returns the `{{partial` being typed immediately before `pos`, if any. */
export function partialTokenBefore(text: string, pos: number): { from: number; query: string } | null {
  const before = text.slice(0, pos)
  const m = /\{\{\s*([\w$.\-]*)$/.exec(before)
  if (!m) return null
  return { from: pos - m[1].length, query: m[1] }
}
