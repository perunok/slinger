import { readFile } from 'node:fs/promises'
import { withDefaultScheme } from '../../shared/urlScheme'
import { basename } from 'node:path'
import { fetch as undiciFetch, type Response as UndiciResponse } from 'undici'
import type { HttpRequestInput, HttpResponseData, RedirectHop, RequestHeader } from '../../shared/types'
import { invalidInput, ioError, IpcError, networkError } from '../lib/errors'
import { FileWriteError, readLimitedBody, streamBodyToFile } from '../lib/limitedBody'
import { DEFAULT_MAX_RESPONSE_MB, formatLimit, MB } from '../../shared/responseLimit'
import type { FileAccess } from './fileGrants'
import type { CookieJarPort } from './cookieJarPort'
import { describeSendError, DIRECT_ROUTER, type NetworkRoute, type NetworkRouter } from './network'
import { mergeCookieHeader, planRedirect, redirectHeaders, redirectPolicy } from './redirects'

export const DEFAULT_TIMEOUT_MS = 60_000
export const MAX_TIMEOUT_MS = 10 * 60_000

const PLACEHOLDER_RE = /\{\{[^{}]*\}\}/
/** OAuth2Service token keys: SHA-256 hex. */
export const OAUTH2_TOKEN_KEY_RE = /^[0-9a-f]{64}$/

/** True if the string still contains an unresolved `{{variable}}` placeholder. */
export const hasUnresolvedPlaceholder = (value: string | undefined | null): boolean =>
  !!value && PLACEHOLDER_RE.test(value)

/** Adds a scheme when it is missing ("localhost:3000/x", "//host/x"; shared/urlScheme.ts). Does not validate. */
export function normalizeUrl(url: string): string {
  return withDefaultScheme(url)
}

/** Every string that will go on the wire, labelled so the error can say where the placeholder is. */
function wireStrings(input: HttpRequestInput): Array<[string, string | undefined]> {
  const out: Array<[string, string | undefined]> = [['url', input.url]]
  for (const h of input.headers ?? []) {
    out.push([`header "${h.key}" name`, h.key], [`header "${h.key}"`, h.value])
  }
  const a = input.auth
  if (a?.kind === 'basic') out.push(['basic auth username', a.basic?.username], ['basic auth password', a.basic?.password])
  if (a?.kind === 'bearer') out.push(['bearer token', a.bearer?.token])
  if (a?.kind === 'apiKey') out.push(['API key name', a.apiKey?.key], ['API key value', a.apiKey?.value])
  if (a?.kind === 'oauth2') out.push(['OAuth 2.0 header prefix', a.oauth2?.headerPrefix])
  const b = input.body
  if (b?.mode === 'raw') out.push(['request body', b.raw?.content], ['body content type', b.raw?.contentType])
  if (b?.mode === 'formData') {
    for (const f of b.formData ?? []) {
      if (!f.enabled) continue
      out.push([`form field "${f.key}" name`, f.key], [`form field "${f.key}"`, f.type === 'file' ? f.filePath : f.value])
    }
  }
  if (b?.mode === 'urlEncoded') {
    for (const f of b.urlEncoded ?? []) {
      if (!f.enabled) continue
      out.push([`form field "${f.key}" name`, f.key], [`form field "${f.key}"`, f.value])
    }
  }
  if (b?.mode === 'binary') out.push(['binary file path', b.binaryFilePath])
  return out
}

/** Throws invalid_input if any outgoing part still has an unresolved `{{ }}` placeholder. */
export function assertNoUnresolvedPlaceholders(input: HttpRequestInput): void {
  for (const [where, value] of wireStrings(input)) {
    if (hasUnresolvedPlaceholder(value)) {
      throw invalidInput(`Unresolved variable in ${where}: define it in the active environment`, { location: where })
    }
  }
}

function headerList(input: HttpRequestInput): RequestHeader[] {
  return (input.headers ?? []).filter((h) => h.key.trim() !== '')
}

const hasHeader = (headers: Headers, name: string) => headers.has(name)

async function readLocalFile(path: string | undefined, label: string, files: FileAccess | undefined): Promise<Buffer> {
  // Only files the user picked in a native dialog may be read (see FileGrants); no access object = none.
  if (!files) throw invalidInput(`${label}: reading local files is not allowed here`)
  const real = await files.resolve(path, label)
  try {
    return await readFile(real)
  } catch (err) {
    throw ioError(`Could not read ${label} "${path}": ${err instanceof Error ? err.message : String(err)}`)
  }
}

const HEADER_CONTROL_RE = /[\x00-\x08\x0a-\x1f\x7f]/

/** The value, or a throw (no message: callers name the header) when it has control characters HTTP does not allow. */
function checkedHeaderValue(value: string): string {
  if (HEADER_CONTROL_RE.test(value)) throw new Error('invalid header value')
  return value
}

interface BuiltRequest {
  url: string
  method: string
  headers: Headers
  body: string | Buffer | FormData | undefined
  /** Header names the auth set (Authorization, an API key header): dropped on a redirect to another origin. */
  authHeaders: string[]
  /** OAuth 2.0 sent as a header: re-checked (token origins) when a redirect keeps it on another origin. */
  oauth2Header?: { tokenKey: string; prefix: string }
}

/** Validates the input and builds fetch arguments. All auth kinds and body modes are applied here. */
export async function buildRequest(input: HttpRequestInput, files?: FileAccess, oauth2Token?: OAuth2TokenLookup): Promise<BuiltRequest> {
  assertNoUnresolvedPlaceholders(input)

  const method = (input.method ?? '').trim().toUpperCase()
  if (!/^[!#$%&'*+.^_`|~0-9A-Z-]+$/.test(method)) throw invalidInput('request method is invalid')

  const normalized = normalizeUrl(input.url ?? '')
  if (!normalized) throw invalidInput('request URL is required')
  let url: URL
  try {
    url = new URL(normalized)
  } catch {
    // Never the resolved URL: it may hold secret values. The renderer's historyUrl keeps them as {{name}}.
    throw invalidInput(input.historyUrl ? `"${input.historyUrl}" is not a valid URL` : 'The request URL is not a valid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw invalidInput('only http and https URLs can be requested')
  }

  const headers = new Headers()
  for (const h of headerList(input)) {
    try {
      headers.append(h.key.trim(), checkedHeaderValue(h.value.trim()))
    } catch {
      // The platform's message quotes the value, which may be a secret: name the header, never its value.
      const name = h.key.trim()
      throw invalidInput(
        /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)
          ? `Invalid header "${name}": its value contains characters that are not allowed in HTTP headers`
          : 'Invalid header: a header name contains characters that are not allowed in HTTP headers',
      )
    }
  }

  // Auth is server-side so credentials never have to be assembled in the renderer.
  const auth = input.auth
  const authHeaders: string[] = []
  let oauth2Header: BuiltRequest['oauth2Header']
  try {
    switch (auth?.kind) {
      case 'basic': {
        const { username = '', password = '' } = auth.basic ?? {}
        headers.set('Authorization', `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`)
        authHeaders.push('authorization')
        break
      }
      case 'bearer':
        if (auth.bearer?.token) {
          headers.set('Authorization', checkedHeaderValue(`Bearer ${auth.bearer.token}`))
          authHeaders.push('authorization')
        }
        break
      case 'oauth2': {
        // The token never crosses IPC: it is read from the keychain here, by key, and applied like a bearer token.
        const o = auth.oauth2
        if (!o || !OAUTH2_TOKEN_KEY_RE.test(o.tokenKey)) throw invalidInput('OAuth 2.0 token key is invalid')
        if (!oauth2Token) throw invalidInput('OAuth 2.0 authorization is not available for this request')
        const token = oauth2Token(o.tokenKey, url.origin)
        if (o.addTo === 'query') url.searchParams.append('access_token', token)
        else {
          headers.set('Authorization', checkedHeaderValue(oauth2HeaderValue(o.headerPrefix, token)))
          authHeaders.push('authorization')
          oauth2Header = { tokenKey: o.tokenKey, prefix: o.headerPrefix }
        }
        break
      }
      case 'apiKey': {
        const key = auth.apiKey?.key.trim()
        if (!key) throw invalidInput('API key name is required')
        if (auth.apiKey!.addTo === 'query') url.searchParams.append(key, auth.apiKey!.value)
        else {
          headers.set(key, checkedHeaderValue(auth.apiKey!.value))
          authHeaders.push(key.toLowerCase())
        }
        break
      }
      default:
        break
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'IpcError') throw err
    // Not the platform's message: it quotes the credential.
    throw invalidInput(`Invalid auth: the ${auth?.kind === 'apiKey' ? 'API key name or value' : 'credentials'} contain characters that are not allowed in HTTP headers`)
  }

  let body: BuiltRequest['body']
  const b = input.body
  switch (b?.mode) {
    case 'raw': {
      if (b.raw && b.raw.content !== '') {
        body = b.raw.content
        if (!hasHeader(headers, 'content-type')) headers.set('Content-Type', b.raw.contentType?.trim() || 'text/plain')
      }
      break
    }
    case 'urlEncoded': {
      const params = new URLSearchParams()
      for (const f of b.urlEncoded ?? []) if (f.enabled && f.key !== '') params.append(f.key, f.value)
      if ([...params].length) {
        body = params.toString()
        if (!hasHeader(headers, 'content-type')) headers.set('Content-Type', 'application/x-www-form-urlencoded')
      }
      break
    }
    case 'formData': {
      const form = new FormData()
      let count = 0
      for (const f of b.formData ?? []) {
        if (!f.enabled || f.key === '') continue
        count++
        if (f.type === 'file') {
          const bytes = await readLocalFile(f.filePath, `file for form field "${f.key}"`, files)
          form.append(f.key, new Blob([bytes], { type: 'application/octet-stream' }), basename(f.filePath!))
        } else {
          form.append(f.key, f.value)
        }
      }
      if (count) {
        body = form
        headers.delete('content-type') // fetch generates it, including the multipart boundary
      }
      break
    }
    case 'binary': {
      body = await readLocalFile(b.binaryFilePath, 'binary body file', files)
      if (!hasHeader(headers, 'content-type')) headers.set('Content-Type', 'application/octet-stream')
      break
    }
    default:
      break
  }
  if (body !== undefined && (method === 'GET' || method === 'HEAD')) {
    throw invalidInput(`${method} requests cannot have a body; choose another method or set the body to none`)
  }

  return { url: url.toString(), method, headers, body, authHeaders, oauth2Header }
}

const oauth2HeaderValue = (prefix: string, token: string) => (prefix.trim() ? `${prefix.trim()} ${token}` : token)

/**
 * Removes every value of the outgoing request that the safe form of its URL (`historyUrl`: secrets as `{{name}}`) does
 * not show from an error message: the resolved URL and its parts, header values and credentials. Platform messages can
 * quote them ("Request cannot be constructed from a URL that includes credentials: https://user:secret@host/",
 * "getaddrinfo ENOTFOUND <host from a secret>"), and the message goes to history and the window.
 */
export function scrubRequestValues(message: string, input: HttpRequestInput): string {
  const shown = input.historyUrl ?? null
  const values = new Set<string>()
  const add = (v: string | undefined | null) => {
    const t = v?.trim()
    if (t && t.length >= 4 && !(shown && shown.includes(t))) values.add(t)
  }
  add(input.url)
  try {
    const u = new URL(normalizeUrl(input.url ?? ''))
    for (const v of [u.href, u.origin, u.host, u.hostname, u.username, u.password, u.pathname, u.search]) {
      add(v)
      try {
        add(decodeURIComponent(v))
      } catch {
        /* not percent-encoded text */
      }
    }
    u.searchParams.forEach((value) => add(value))
  } catch {
    /* not a URL: the raw string above covers it */
  }
  for (const h of input.headers ?? []) add(h.value)
  const a = input.auth
  if (a?.kind === 'basic') {
    add(a.basic?.password)
    add(Buffer.from(`${a.basic?.username ?? ''}:${a.basic?.password ?? ''}`, 'utf8').toString('base64'))
  }
  if (a?.kind === 'bearer') add(a.bearer?.token)
  if (a?.kind === 'apiKey') add(a.apiKey?.value)
  let out = message
  for (const v of [...values].sort((x, y) => y.length - x.length)) {
    if (out.includes(v)) out = out.split(v).join('•••')
  }
  return out
}

function charsetOf(headers: Headers): string | null {
  const m = /charset\s*=\s*"?([^";\s]+)/i.exec(headers.get('content-type') ?? '')
  return m ? m[1]!.toLowerCase() : null
}

/** Decodes as text when the bytes are valid in the declared (default UTF-8) charset, else null. */
export function decodeBody(bytes: Uint8Array, headers: Headers): string | null {
  const charset = charsetOf(headers)
  const tryDecode = (label: string): string | null => {
    try {
      return new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch {
      return null
    }
  }
  if (charset && charset !== 'utf-8' && charset !== 'utf8') {
    const viaCharset = tryDecode(charset)
    if (viaCharset !== null) return viaCharset
  }
  return tryDecode('utf-8')
}

export interface ExecuteOptions {
  /** Aborting it cancels the request (also while the body is streaming). */
  signal?: AbortSignal
  /** Grants for local files referenced by the body; without it any file reference is rejected. */
  files?: FileAccess
  /** Reads the stored OAuth 2.0 access token for `auth.oauth2.tokenKey`; without it OAuth 2.0 auth is rejected. */
  oauth2Token?: OAuth2TokenLookup
  /** The most body bytes read into memory (default 50 MB); the download stops as soon as the body passes it. */
  maxResponseBytes?: number
  /**
   * What a larger body does: 'error' (default; internal requests, pm.sendRequest) fails with network_error, 'report' (user
   * sends) returns the response with `bodyTooLarge` and no body.
   */
  oversize?: 'error' | 'report'
  /** Streams the body into this file (chosen by the user in main's save dialog) instead of returning it; no size limit. */
  toFile?: string
  /** Network settings (proxy, CA and client certificates, SSL verification); absent: direct connections, verified. */
  network?: NetworkRouter
  /** Adds the jar's cookies to every hop and stores every hop's Set-Cookie; absent: no cookie handling. */
  cookieJar?: CookieJarPort
}

/**
 * Returns the access token stored under a token key for a send to `origin`, or throws a user-facing IpcError (missing,
 * expired, not allowed for that origin).
 */
export type OAuth2TokenLookup = (tokenKey: string, origin: string) => string

const tooLargeError = (max: number) => networkError(`The response is larger than ${formatLimit(max)}, so it was not loaded`, { tooLarge: true })

/**
 * Performs the HTTP request. Non-UTF-8 bodies come back as base64. durationMs covers connect,
 * headers and the complete body download. Throws IpcError for invalid input / network failure.
 */
export async function executeHttp(input: HttpRequestInput, options: ExecuteOptions = {}): Promise<HttpResponseData> {
  const built = await buildRequest(input, options.files, options.oauth2Token)
  const timeoutMs = Math.min(Math.max(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1), MAX_TIMEOUT_MS)

  const controller = new AbortController()
  let timedOut = false
  let cancelled = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onCancel = () => {
    cancelled = true
    controller.abort()
  }
  if (options.signal?.aborted) onCancel()
  else options.signal?.addEventListener('abort', onCancel, { once: true })

  const started = performance.now()
  const policy = redirectPolicy(input)
  const router = options.network ?? DIRECT_ROUTER
  const redirects: RedirectHop[] = []
  let route: NetworkRoute | null = null
  let hop: { url: URL; method: string; headers: Headers; body: BuiltRequest['body'] } | null = null
  try {
    hop = { url: new URL(built.url), method: built.method, headers: built.headers, body: built.body }
    let response: UndiciResponse
    for (;;) {
      route = await router.route(hop.url, { strictSSL: input.strictSSL })
      const headers = new Headers(hop.headers)
      if (options.cookieJar) {
        const cookie = mergeCookieHeader(headers.get('cookie'), await jarCookies(options.cookieJar, hop.url))
        if (cookie) headers.set('cookie', cookie)
      }
      response = await undiciFetch(hop.url, {
        method: hop.method,
        headers,
        body: hop.body as never,
        signal: controller.signal,
        redirect: 'manual',
        dispatcher: route.dispatcher,
      })
      if (options.cookieJar) await storeJarCookies(options.cookieJar, hop.url, response.headers.getSetCookie())
      const plan = planRedirect(hop, response.status, response.headers.get('location'), policy, redirects.length)
      if (plan.kind === 'final') break
      await response.body?.cancel().catch(() => {})
      if (plan.kind === 'tooMany') {
        throw networkError(`Too many redirects: stopped after ${plan.max}. The server may be redirecting in a loop (Maximum redirects is in the Settings tab).`, {
          tooManyRedirects: true,
        })
      }
      redirects.push({ status: response.status, location: plan.url.toString() })
      const nextHeaders = redirectHeaders(hop.headers, plan, policy, built.authHeaders)
      // A token kept on another origin (Follow Authorization header) is checked like a send to that origin.
      if (plan.crossOrigin && policy.followAuthorizationHeader && built.oauth2Header && options.oauth2Token) {
        nextHeaders.set('authorization', oauth2HeaderValue(built.oauth2Header.prefix, options.oauth2Token(built.oauth2Header.tokenKey, plan.url.origin)))
      }
      hop = { url: plan.url, method: plan.method, headers: nextHeaders, body: plan.keepBody ? hop.body : undefined }
    }
    const headers: RequestHeader[] = []
    response.headers.forEach((value, key) => headers.push({ key, value }))
    const head = { status: response.status, statusText: response.statusText, headers, ...(redirects.length ? { redirects } : {}) }
    const elapsed = () => Math.max(0, Math.round(performance.now() - started))

    if (options.toFile) {
      let written: number
      try {
        written = await streamBodyToFile(response as unknown as Response, options.toFile)
      } catch (err) {
        if (!(err instanceof FileWriteError)) throw err
        throw ioError(`Could not write the response to "${options.toFile}": ${err.message}`)
      }
      return { ...head, durationMs: elapsed(), bodyText: null, bodyBase64: null, bodyByteLength: written, savedToFile: options.toFile }
    }

    const max = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_MB * MB
    const tooLarge = (size: number) => {
      if (options.oversize !== 'report') throw tooLargeError(max)
      return { ...head, durationMs: elapsed(), bodyText: null, bodyBase64: null, bodyByteLength: size, bodyTooLarge: { limitBytes: max } }
    }
    const body = await readLimitedBody(response as unknown as Response, max)
    if (!body.ok) return tooLarge(body.declared ?? body.received)
    const bytes = body.bytes
    const durationMs = elapsed()
    try {
      const text = decodeBody(bytes, response.headers as unknown as Headers)
      return { ...head, durationMs, bodyText: text, bodyBase64: text === null ? bytes.toString('base64') : null, bodyByteLength: bytes.byteLength }
    } catch (err) {
      // Too long for one JavaScript string (base64 of a very large binary body): same as passing the limit.
      if (err instanceof RangeError) return tooLarge(bytes.byteLength)
      throw err
    }
  } catch (err) {
    if (cancelled) throw networkError('Request cancelled', { cancelled: true })
    if (err instanceof IpcError) throw err
    if (timedOut) throw networkError(`Request timed out after ${timeoutMs} ms`, { timedOut: true })
    throw describeSendError(err, route, hop?.url)
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onCancel)
  }
}

/** The jar's Cookie header for a hop; a failing jar never fails the send. */
async function jarCookies(jar: CookieJarPort, url: URL): Promise<string | null> {
  try {
    return await jar.cookieHeaderFor(url)
  } catch (err) {
    console.warn('[slinger] cookie jar lookup failed:', err instanceof Error ? err.message : err)
    return null
  }
}

async function storeJarCookies(jar: CookieJarPort, url: URL, setCookie: string[]): Promise<void> {
  if (setCookie.length === 0) return
  try {
    await jar.storeFromResponse(url, setCookie)
  } catch (err) {
    console.warn('[slinger] cookie jar store failed:', err instanceof Error ? err.message : err)
  }
}
