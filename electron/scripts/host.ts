/**
 * Host side of one script run: the state the `pm` API reads and writes (variable scopes, the environment,
 * the request, console output, test results) and the single dispatcher the sandbox calls.
 *
 * The sandbox only ever passes JSON TEXT across the boundary (see sandbox.ts). Everything arriving here is
 * parsed with the host's own JSON.parse, type-checked and size-limited; scope state lives in Maps, so a
 * script-chosen key such as "__proto__" can never reach an object prototype on this side.
 */
import { randomBytes, randomInt, randomUUID } from 'node:crypto'
import type {
  ResolvedAuth,
  ResolvedBody,
  ScriptConsoleEntry,
  ScriptConsoleLevel,
  ScriptErrorInfo,
  ScriptKeyValue,
  ScriptRequestData,
  ScriptSource,
  ScriptTestResult,
  ScriptVariables,
} from '../../shared/types'
import {
  MAX_RESPONSE_BODY_CHARS,
  MAX_VALUE_CHARS,
  type EnvOp,
  type ScriptJob,
  type ScriptJobResult,
  type ScriptRunnerDeps,
  type SendRequestCall,
  type SendRequestOutcome,
} from './job'

/** Error raised for a bad call from a script; its message is shown to the script author. */
export class ScriptApiError extends Error {}

interface EnvEntry {
  id: string | null
  secret: boolean
  /** Known value (always for non-secrets; for secrets only after a read or a set). */
  value: string | null
  known: boolean
}

type ScopeName = 'local' | 'collection' | 'globals'

const LEVELS = new Set<ScriptConsoleLevel>(['log', 'info', 'warn', 'error'])
const TOKEN_RE = /\{\{\s*(\$?[\w.\-]+)\s*\}\}/g
const EVENT_LABEL = { prerequest: 'Pre-request', test: 'Tests' } as const
const ORIGIN_LABEL = { collection: 'collection', folder: 'folder', request: 'request' } as const

export function sourceLabel(event: 'prerequest' | 'test', script: Pick<ScriptSource, 'origin' | 'name'>): string {
  return `${EVENT_LABEL[event]} · ${ORIGIN_LABEL[script.origin]} “${script.name}”`
}

function str(v: unknown, what: string, max: number): string {
  if (typeof v !== 'string') throw new ScriptApiError(`${what} must be a string`)
  if (v.length > max) throw new ScriptApiError(`${what} is too long (${max} characters max)`)
  return v
}

function cleanKey(v: unknown, what = 'variable name'): string {
  if (typeof v !== 'string') throw new ScriptApiError(`${what} must be a string`)
  const k = v.trim()
  if (!k) throw new ScriptApiError(`${what} must not be empty`)
  if (k.length > 256) throw new ScriptApiError(`${what} is too long (256 characters max)`)
  return k
}

/** Environment values are stored as text: strings as-is, anything else as JSON. */
export function envText(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === undefined || v === null) return ''
  return JSON.stringify(v)
}

/** How a scoped value appears inside `{{template}}` text. */
function templateText(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === undefined || v === null) return ''
  return JSON.stringify(v)
}

function checkJsonValue(v: unknown): unknown {
  // Values arrive as parsed JSON, so they are plain data already; only the size needs a check.
  const size = typeof v === 'string' ? v.length : JSON.stringify(v ?? null).length
  if (size > MAX_VALUE_CHARS) throw new ScriptApiError(`value is too large (${MAX_VALUE_CHARS} characters max)`)
  return v === undefined ? null : v
}

function toRecord(map: Map<string, unknown>): ScriptVariables {
  // Object.fromEntries defines own data properties, so a "__proto__" key stays an ordinary key.
  return Object.fromEntries(map)
}

function fromRecord(rec: ScriptVariables | undefined): Map<string, unknown> {
  const m = new Map<string, unknown>()
  if (rec && typeof rec === 'object') for (const k of Object.keys(rec)) m.set(k, rec[k])
  return m
}

function randomString(n: number, alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'): string {
  let s = ''
  for (let i = 0; i < n; i++) s += alphabet[randomInt(alphabet.length)]
  return s
}

/** Built-in dynamic variables (same names as the renderer's template.ts), from a CSPRNG. */
export function builtinValue(name: string, now: Date): string | null {
  switch (name) {
    case '$guid':
    case '$randomUUID':
      return randomUUID()
    case '$timestamp':
      return String(Math.floor(now.getTime() / 1000))
    case '$isoTimestamp':
      return now.toISOString()
    case '$date':
      return now.toISOString().slice(0, 10)
    case '$time':
      return now.toISOString().slice(11, 19)
    case '$randomInt':
      return String(randomInt(1_000_000))
    case '$randomString':
      return randomString(12)
    case '$randomBoolean':
      return randomInt(2) === 1 ? 'true' : 'false'
    case '$randomEmail':
      return `user_${randomString(8, 'abcdefghijklmnopqrstuvwxyz0123456789')}@example.com`
    default:
      return null
  }
}

function kvList(v: unknown, what: string, max: number): ScriptKeyValue[] {
  if (!Array.isArray(v)) throw new ScriptApiError(`${what} must be a list`)
  if (v.length > max) throw new ScriptApiError(`too many ${what} (${max} max)`)
  return v.map((item) => {
    if (!item || typeof item !== 'object') throw new ScriptApiError(`${what} entries must be objects`)
    const o = item as Record<string, unknown>
    const out: ScriptKeyValue = { key: str(o.key ?? '', `${what} key`, 8192), value: str(envText(o.value), `${what} value`, 65_536) }
    if (o.disabled === true) out.disabled = true
    return out
  })
}

const BODY_MODES = new Set(['none', 'raw', 'urlencoded', 'formdata', 'file', 'other'])

export function checkRequestData(v: unknown): ScriptRequestData {
  if (!v || typeof v !== 'object') throw new ScriptApiError('request must be an object')
  const o = v as Record<string, unknown>
  const method = str(o.method, 'method', 32).trim().toUpperCase()
  if (!/^[A-Z][A-Z0-9_-]*$/.test(method)) throw new ScriptApiError(`"${method}" is not a valid HTTP method`)
  const b = (o.body && typeof o.body === 'object' ? o.body : { mode: 'none' }) as Record<string, unknown>
  const mode = typeof b.mode === 'string' && BODY_MODES.has(b.mode) ? (b.mode as ScriptRequestData['body']['mode']) : 'none'
  const body: ScriptRequestData['body'] = { mode }
  if (b.raw !== undefined) body.raw = str(b.raw, 'body', 10 * 1024 * 1024)
  if (typeof b.language === 'string') body.language = str(b.language, 'body language', 32)
  if (b.urlencoded !== undefined) body.urlencoded = kvList(b.urlencoded, 'urlencoded fields', 1000)
  if (b.formdata !== undefined) body.formdata = kvList(b.formdata, 'form fields', 1000)
  return { method, url: str(o.url, 'url', 100_000), headers: kvList(o.headers ?? [], 'headers', 500), body }
}

/** Content-Type for a raw pm.sendRequest body by `options.raw.language`, when the script set no Content-Type. */
const RAW_CONTENT_TYPES: Record<string, string> = {
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  javascript: 'application/javascript',
  text: 'text/plain',
}
const URL_SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//

function obj(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ScriptApiError(`${what} must be an object`)
  return v as Record<string, unknown>
}

export interface SettledSend {
  id: number
  outcome: SendRequestOutcome
}

export class RunHost {
  readonly job: ScriptJob
  private readonly deps: ScriptRunnerDeps
  private readonly env = new Map<string, EnvEntry>()
  private readonly scopes: Record<ScopeName, Map<string, unknown>>
  readonly envOps: EnvOp[] = []
  private request: ScriptRequestData
  private requestChanged = false
  readonly console: ScriptConsoleEntry[] = []
  private consoleChars = 0
  private consoleDropped = false
  readonly tests: ScriptTestResult[] = []
  private testsDropped = false
  readonly errors: ScriptErrorInfo[] = []
  private warnedNoEnv = false
  /** Label of the script currently running. */
  source = ''
  // pm.sendRequest: calls started in this run, the ones in flight, and results not yet handed to the script.
  private sendCount = 0
  private sendSeq = 0
  private readonly sends = new Map<number, AbortController>()
  private readonly settled: SettledSend[] = []
  private wake: (() => void) | null = null

  constructor(job: ScriptJob, deps: ScriptRunnerDeps) {
    this.job = job
    this.deps = deps
    for (const v of job.environment?.variables ?? []) {
      this.env.set(v.key, { id: v.id, secret: v.secret, value: v.secret ? null : (v.value ?? ''), known: !v.secret })
    }
    this.scopes = { local: fromRecord(job.variables), collection: fromRecord(job.collectionVariables), globals: fromRecord(job.globals) }
    this.request = job.request
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  begin(script: ScriptSource): void {
    this.source = sourceLabel(this.job.event, script)
  }

  // ---- environment ---------------------------------------------------------

  private envGet(key: string): string | undefined {
    const e = this.env.get(key)
    if (!e) return undefined
    if (!e.known) {
      // The only place a secret value enters a script: an explicit read by name.
      const value = e.id ? this.deps.readSecret(e.id) : null
      if (value === null) {
        this.log('warn', `Secret variable "${key}" has no value on this device.`)
        return undefined
      }
      e.value = value
      e.known = true
    }
    return e.value ?? ''
  }

  private envWritable(what: string): void {
    if (this.job.readOnly) {
      throw new ScriptApiError(
        `${what} failed: this workspace is read-only (synced with the viewer role), so scripts cannot change its environment.`,
      )
    }
    if (!this.job.environment && !this.warnedNoEnv) {
      this.warnedNoEnv = true
      this.log('warn', 'No environment is active: pm.environment changes last for this run only and are not saved.')
    }
  }

  private envSet(key: string, value: unknown): void {
    this.envWritable(`pm.environment.set("${key}")`)
    const text = envText(value)
    if (text.length > MAX_VALUE_CHARS) throw new ScriptApiError(`value is too large (${MAX_VALUE_CHARS} characters max)`)
    const e = this.env.get(key)
    if (e?.secret && text === '') throw new ScriptApiError(`"${key}" is a secret variable and cannot be set to an empty value`)
    if (e) {
      e.value = text
      e.known = true
    } else this.env.set(key, { id: null, secret: false, value: text, known: true })
    if (this.job.environment) this.envOps.push({ op: 'set', key, value: text })
  }

  private envUnset(key: string): void {
    this.envWritable(`pm.environment.unset("${key}")`)
    if (!this.env.delete(key)) return
    if (this.job.environment) this.envOps.push({ op: 'unset', key })
  }

  /** Non-secret values only: secrets are read one at a time, by name, with get(). */
  private envObject(): Record<string, string> {
    const out: [string, string][] = []
    for (const [k, e] of this.env) if (!e.secret) out.push([k, e.value ?? ''])
    return Object.fromEntries(out)
  }

  // ---- variable resolution -------------------------------------------------

  /** pm.variables.get: local > environment > collection > globals (Postman's precedence, no data files). */
  private resolve(key: string): { found: boolean; value: unknown } {
    if (this.scopes.local.has(key)) return { found: true, value: this.scopes.local.get(key) }
    if (this.env.has(key)) return { found: true, value: this.envGet(key) }
    if (this.scopes.collection.has(key)) return { found: true, value: this.scopes.collection.get(key) }
    if (this.scopes.globals.has(key)) return { found: true, value: this.scopes.globals.get(key) }
    return { found: false, value: undefined }
  }

  /** `{{name}}` substitution with the same rules as the send pipeline (nested values, bounded passes). */
  replaceIn(text: string): string {
    const now = new Date(this.now())
    const cache = new Map<string, string>()
    let cur = text
    for (let pass = 0; pass < 6 && cur.includes('{{'); pass++) {
      const next = cur.replace(TOKEN_RE, (raw, name: string) => {
        const r = this.resolve(name)
        if (r.found) return templateText(r.value)
        const cached = cache.get(name)
        if (cached !== undefined) return cached
        const b = builtinValue(name, now)
        if (b === null) return raw
        cache.set(name, b)
        return b
      })
      if (next === cur) break
      cur = next
      if (cur.length > MAX_VALUE_CHARS * 4) throw new ScriptApiError('replaceIn result is too large')
    }
    return cur
  }

  // ---- console and tests ---------------------------------------------------

  log(level: ScriptConsoleLevel, message: string): void {
    if (this.consoleDropped) return
    const limits = this.job.limits
    let text = message
    if (text.length > limits.messageChars) text = `${text.slice(0, limits.messageChars)}… (${text.length - limits.messageChars} more characters)`
    if (this.console.length >= limits.consoleEntries || this.consoleChars + text.length > limits.consoleBytes) {
      this.consoleDropped = true
      this.console.push({ level: 'warn', message: 'Console output limit reached; later messages were dropped.', timestamp: this.now(), source: this.source })
      return
    }
    this.consoleChars += text.length
    this.console.push({ level, message: text, timestamp: this.now(), source: this.source })
  }

  test(name: string, status: ScriptTestResult['status'], error: string | null): void {
    if (this.tests.length >= this.job.limits.tests) {
      if (!this.testsDropped) {
        this.testsDropped = true
        this.log('warn', `More than ${this.job.limits.tests} tests; the rest were not recorded.`)
      }
      return
    }
    this.tests.push({ name: name.slice(0, 1000), status, error: error === null ? null : error.slice(0, 2000), source: this.source })
  }

  error(script: ScriptSource, kind: ScriptErrorInfo['kind'], message: string): void {
    this.errors.push({ source: sourceLabel(this.job.event, script), kind, message: message.slice(0, 4000) })
  }

  // ---- pm.sendRequest ------------------------------------------------------------

  /**
   * Validates a request object from the prelude (already reduced to plain data) and resolves `{{variables}}` in
   * the URL, headers, auth and body, as Postman does for pm.sendRequest.
   */
  buildSendCall(v: unknown): SendRequestCall {
    const o = obj(v, 'pm.sendRequest request')
    const r = (text: string) => this.replaceIn(text)
    const url = r(str(o.url, 'pm.sendRequest url', 100_000)).trim()
    if (!url) throw new ScriptApiError('pm.sendRequest: the request URL is empty')
    const scheme = URL_SCHEME_RE.exec(url)?.[1]?.toLowerCase()
    if (scheme !== undefined && scheme !== 'http' && scheme !== 'https') {
      throw new ScriptApiError(`pm.sendRequest: only http and https URLs can be requested (got "${scheme}:")`)
    }
    const method = r(str(o.method ?? 'GET', 'pm.sendRequest method', 32)).trim().toUpperCase() || 'GET'
    if (!/^[A-Z][A-Z0-9_-]*$/.test(method)) throw new ScriptApiError(`pm.sendRequest: "${method}" is not a valid HTTP method`)
    const headers = kvList(o.headers ?? [], 'pm.sendRequest headers', 500)
      .filter((h) => !h.disabled && h.key.trim() !== '')
      .map((h) => ({ key: r(h.key), value: r(h.value) }))

    let auth: ResolvedAuth = { kind: 'none' }
    if (o.auth !== undefined && o.auth !== null) {
      const a = obj(o.auth, 'pm.sendRequest auth')
      const type = typeof a.type === 'string' ? a.type.toLowerCase() : 'noauth'
      const f = a.values && typeof a.values === 'object' ? (a.values as Record<string, unknown>) : {}
      const val = (k: string) => r(envText(f[k]))
      if (type === 'bearer') auth = { kind: 'bearer', bearer: { token: val('token') } }
      else if (type === 'basic') auth = { kind: 'basic', basic: { username: val('username'), password: val('password') } }
      else if (type === 'apikey') auth = { kind: 'apiKey', apiKey: { key: val('key'), value: val('value'), addTo: val('in') === 'query' ? 'query' : 'header' } }
      else if (type !== 'noauth' && type !== 'none' && type !== 'inherit') {
        throw new ScriptApiError(`pm.sendRequest: auth type "${type}" is not supported (use bearer, basic, apikey or set the header yourself)`)
      }
    }

    let body: ResolvedBody = { mode: 'none' }
    if (o.body !== undefined && o.body !== null) {
      const b = obj(o.body, 'pm.sendRequest body')
      const mode = typeof b.mode === 'string' ? b.mode : 'none'
      if (b.disabled === true) body = { mode: 'none' }
      else if (mode === 'raw') {
        const language = typeof b.language === 'string' ? b.language.toLowerCase() : ''
        const hasType = headers.some((h) => h.key.trim().toLowerCase() === 'content-type')
        body = { mode: 'raw', raw: { content: r(str(envText(b.raw), 'pm.sendRequest body', 10 * 1024 * 1024)), contentType: hasType ? '' : (RAW_CONTENT_TYPES[language] ?? '') } }
      } else if (mode === 'urlencoded') {
        body = { mode: 'urlEncoded', urlEncoded: kvList(b.urlencoded ?? [], 'urlencoded fields', 1000).filter((f) => !f.disabled).map((f) => ({ key: r(f.key), value: r(f.value), enabled: true })) }
      } else if (mode === 'formdata') {
        if (!Array.isArray(b.formdata)) throw new ScriptApiError('pm.sendRequest: body.formdata must be a list')
        if (b.formdata.length > 1000) throw new ScriptApiError('pm.sendRequest: too many form fields (1000 max)')
        body = {
          mode: 'formData',
          formData: b.formdata
            .map((item) => obj(item, 'form field'))
            .filter((f) => f.disabled !== true)
            .map((f) => {
              const key = r(str(envText(f.key), 'form field key', 8192))
              if (f.type === 'file') return { key, value: '', type: 'file' as const, filePath: str(f.src, `file for form field "${key}"`, 4096), enabled: true }
              return { key, value: r(str(envText(f.value), 'form field value', 10 * 1024 * 1024)), type: 'text' as const, enabled: true }
            }),
        }
      } else if (mode === 'file') {
        body = { mode: 'binary', binaryFilePath: str(b.file, 'pm.sendRequest body.file.src', 4096) }
      } else if (mode === 'graphql') {
        const g = b.graphql && typeof b.graphql === 'object' ? (b.graphql as Record<string, unknown>) : {}
        let variables: unknown = undefined
        if (typeof g.variables === 'string') {
          const text = r(g.variables).trim()
          if (text) {
            try {
              variables = JSON.parse(text)
            } catch {
              throw new ScriptApiError('pm.sendRequest: body.graphql.variables is not valid JSON')
            }
          }
        } else if (g.variables !== undefined && g.variables !== null) variables = g.variables
        const content = JSON.stringify({ query: r(envText(g.query)), ...(variables === undefined ? {} : { variables }) })
        body = { mode: 'raw', raw: { content, contentType: 'application/json' } }
      } else if (mode !== 'none') throw new ScriptApiError(`pm.sendRequest: body mode "${mode}" is not supported`)
    }

    const max = this.job.limits.sendRequestTimeoutMs
    const timeoutMs = typeof o.timeout === 'number' && Number.isFinite(o.timeout) && o.timeout > 0 ? Math.min(Math.round(o.timeout), max) : max
    return { method, url, headers, auth, body, timeoutMs }
  }

  private startSend(spec: unknown): number {
    const send = this.deps.sendHttp
    if (!send) throw new ScriptApiError('pm.sendRequest is not available here')
    const max = this.job.limits.maxSendRequests
    if (this.sendCount >= max) throw new ScriptApiError(`pm.sendRequest: at most ${max} requests per script run`)
    const call = this.buildSendCall(spec)
    this.sendCount++
    const id = ++this.sendSeq
    const controller = new AbortController()
    this.sends.set(id, controller)
    const deliver = (outcome: SendRequestOutcome) => {
      if (!this.sends.delete(id)) return // aborted by the host (script ended): nobody is waiting for it
      this.settled.push({ id, outcome })
      this.wake?.()
    }
    let started: Promise<SendRequestOutcome>
    try {
      started = send(call, controller.signal)
    } catch (err) {
      started = Promise.reject(err)
    }
    started.then(deliver, (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      deliver({ ok: false, error: message, logLine: `→ ${call.method} failed: ${message}` })
    })
    return id
  }

  /** pm.sendRequest calls whose response the script has not received yet. */
  pendingSends(): number {
    return this.sends.size + this.settled.length
  }

  /** The next finished pm.sendRequest (and logs its console line), or undefined. */
  takeSettled(): SettledSend | undefined {
    const next = this.settled.shift()
    if (next) this.log('info', next.outcome.logLine)
    return next
  }

  /** Resolves once a pm.sendRequest finished or after `ms`, whichever is first. */
  waitForSettled(ms: number): Promise<void> {
    if (this.settled.length > 0) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(done, Math.max(0, ms))
      function done() {
        clearTimeout(timer)
        resolve()
      }
      this.wake = () => {
        this.wake = null
        done()
      }
    })
  }

  /** Aborts every pm.sendRequest still in flight and drops undelivered results (end of a script). */
  abortSends(): void {
    const all = [...this.sends.values()]
    this.sends.clear()
    this.settled.length = 0
    for (const c of all) c.abort()
  }

  // ---- dispatcher ------------------------------------------------------------

  /** Entry point for every call from the sandbox. `args` comes from the host's JSON.parse. */
  dispatch(op: string, args: unknown[]): unknown {
    if (!Array.isArray(args)) throw new ScriptApiError('bad call')
    const a0 = args[0]
    switch (op) {
      case 'init': {
        const res = this.job.response
        return {
          event: this.job.event,
          info: this.job.info,
          request: this.request,
          response: res && res.body !== null && res.body.length > MAX_RESPONSE_BODY_CHARS ? { ...res, body: res.body.slice(0, MAX_RESPONSE_BODY_CHARS), truncated: true } : res,
          environmentName: this.job.environment?.name ?? null,
        }
      }
      case 'env.get':
        return this.envGet(cleanKey(a0))
      case 'env.has':
        return this.env.has(cleanKey(a0))
      case 'env.set':
        this.envSet(cleanKey(a0), args[1])
        return undefined
      case 'env.unset':
        this.envUnset(cleanKey(a0))
        return undefined
      case 'env.clear':
        for (const key of [...this.env.keys()]) this.envUnset(key)
        return undefined
      case 'env.toObject':
        return this.envObject()
      case 'scope.get':
      case 'scope.has':
      case 'scope.set':
      case 'scope.unset':
      case 'scope.clear':
      case 'scope.toObject': {
        if (a0 !== 'local' && a0 !== 'collection' && a0 !== 'globals') throw new ScriptApiError('unknown scope')
        const scope = this.scopes[a0]
        if (op === 'scope.toObject') return toRecord(scope)
        if (op === 'scope.clear') return void scope.clear()
        const key = cleanKey(args[1])
        if (op === 'scope.get') return scope.get(key)
        if (op === 'scope.has') return scope.has(key)
        if (op === 'scope.unset') return void scope.delete(key)
        scope.set(key, checkJsonValue(args[2]))
        return undefined
      }
      case 'vars.get':
        return this.resolve(cleanKey(a0)).value
      case 'vars.has':
        return this.resolve(cleanKey(a0)).found
      case 'vars.toObject': {
        const merged = new Map<string, unknown>([...this.scopes.globals, ...this.scopes.collection])
        for (const [k, v] of Object.entries(this.envObject())) merged.set(k, v)
        for (const [k, v] of this.scopes.local) merged.set(k, v)
        return toRecord(merged)
      }
      case 'replaceIn':
        return this.replaceIn(typeof a0 === 'string' ? a0 : envText(a0))
      case 'console': {
        const level = LEVELS.has(a0 as ScriptConsoleLevel) ? (a0 as ScriptConsoleLevel) : 'log'
        this.log(level, typeof args[1] === 'string' ? args[1] : envText(args[1]))
        // true tells the sandbox that output is closed, so it stops formatting and calling (flood protection).
        return this.consoleDropped
      }
      case 'test': {
        const status = args[1] === 'passed' || args[1] === 'skipped' ? args[1] : 'failed'
        this.test(typeof a0 === 'string' ? a0 : envText(a0), status, typeof args[2] === 'string' ? args[2] : null)
        return undefined
      }
      case 'random': {
        // crypto.getRandomValues inside the sandbox (QuickJS has no CSPRNG); the Web Crypto limit of 65536 bytes.
        if (typeof a0 !== 'number' || !Number.isInteger(a0) || a0 < 0 || a0 > 65_536) throw new ScriptApiError('crypto.getRandomValues: at most 65536 bytes per call')
        return randomBytes(a0).toString('hex')
      }
      case 'randomUUID':
        return randomUUID()
      case 'http.send':
        return this.startSend(a0)
      case 'request.set':
        this.request = checkRequestData(a0)
        this.requestChanged = true
        return undefined
      default:
        throw new ScriptApiError(`unknown operation ${op}`)
    }
  }

  result(durationMs: number): ScriptJobResult {
    return {
      errors: this.errors,
      request: this.job.event === 'prerequest' && this.requestChanged ? this.request : null,
      variables: toRecord(this.scopes.local),
      collectionVariables: toRecord(this.scopes.collection),
      globals: toRecord(this.scopes.globals),
      envOps: this.envOps,
      console: this.console,
      tests: this.tests,
      durationMs,
    }
  }
}
