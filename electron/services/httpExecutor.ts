import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { HttpRequestInput, HttpResponseData, RequestHeader } from '../../shared/types'
import { invalidInput, ioError, networkError } from '../lib/errors'
import type { FileAccess } from './fileGrants'

export const DEFAULT_TIMEOUT_MS = 60_000
export const MAX_TIMEOUT_MS = 10 * 60_000

const PLACEHOLDER_RE = /\{\{[^{}]*\}\}/
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//

/** True if the string still contains an unresolved `{{variable}}` placeholder. */
export const hasUnresolvedPlaceholder = (value: string | undefined | null): boolean =>
  !!value && PLACEHOLDER_RE.test(value)

/** Adds http:// when the scheme is missing ("localhost:3000/x", "//host/x"). Does not validate. */
export function normalizeUrl(url: string): string {
  const trimmed = url.trim()
  if (trimmed.startsWith('//')) return `http:${trimmed}`
  if (!trimmed || SCHEME_RE.test(trimmed)) return trimmed
  return `http://${trimmed}`
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

interface BuiltRequest {
  url: string
  method: string
  headers: Headers
  body: string | Buffer | FormData | undefined
}

/** Validates the input and builds fetch arguments. All auth kinds and body modes are applied here. */
export async function buildRequest(input: HttpRequestInput, files?: FileAccess): Promise<BuiltRequest> {
  assertNoUnresolvedPlaceholders(input)

  const method = (input.method ?? '').trim().toUpperCase()
  if (!/^[!#$%&'*+.^_`|~0-9A-Z-]+$/.test(method)) throw invalidInput('request method is invalid')

  const normalized = normalizeUrl(input.url ?? '')
  if (!normalized) throw invalidInput('request URL is required')
  let url: URL
  try {
    url = new URL(normalized)
  } catch {
    throw invalidInput(`"${input.url}" is not a valid URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw invalidInput('only http and https URLs can be requested')
  }

  const headers = new Headers()
  try {
    for (const h of headerList(input)) headers.append(h.key.trim(), h.value.trim())
  } catch (err) {
    throw invalidInput(`Invalid header: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Auth is server-side so credentials never have to be assembled in the renderer.
  const auth = input.auth
  try {
    switch (auth?.kind) {
      case 'basic': {
        const { username = '', password = '' } = auth.basic ?? {}
        headers.set('Authorization', `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`)
        break
      }
      case 'bearer':
        if (auth.bearer?.token) headers.set('Authorization', `Bearer ${auth.bearer.token}`)
        break
      case 'apiKey': {
        const key = auth.apiKey?.key.trim()
        if (!key) throw invalidInput('API key name is required')
        if (auth.apiKey!.addTo === 'query') url.searchParams.append(key, auth.apiKey!.value)
        else headers.set(key, auth.apiKey!.value)
        break
      }
      default:
        break
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'IpcError') throw err
    throw invalidInput(`Invalid auth: ${err instanceof Error ? err.message : String(err)}`)
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

  return { url: url.toString(), method, headers, body }
}

function describeNetworkError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause
    if (cause instanceof Error && cause.message) return cause.message
    return err.message
  }
  return String(err)
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
}

/**
 * Performs the HTTP request. Non-UTF-8 bodies come back as base64. durationMs covers connect,
 * headers and the complete body download. Throws IpcError for invalid input / network failure.
 */
export async function executeHttp(input: HttpRequestInput, options: ExecuteOptions = {}): Promise<HttpResponseData> {
  const built = await buildRequest(input, options.files)
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
  try {
    const response = await fetch(built.url, {
      method: built.method,
      headers: built.headers,
      body: built.body as RequestInit['body'],
      signal: controller.signal,
      redirect: 'follow',
    })
    const bytes = new Uint8Array(await response.arrayBuffer())
    const durationMs = Math.max(0, Math.round(performance.now() - started))
    const text = decodeBody(bytes, response.headers)
    const headers: RequestHeader[] = []
    response.headers.forEach((value, key) => headers.push({ key, value }))
    return {
      status: response.status,
      statusText: response.statusText,
      durationMs,
      headers,
      bodyText: text,
      bodyBase64: text === null ? Buffer.from(bytes).toString('base64') : null,
      bodyByteLength: bytes.byteLength,
    }
  } catch (err) {
    if (cancelled) throw networkError('Request cancelled', { cancelled: true })
    if (timedOut) throw networkError(`Request timed out after ${timeoutMs} ms`, { timedOut: true })
    throw networkError(describeNetworkError(err))
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onCancel)
  }
}
