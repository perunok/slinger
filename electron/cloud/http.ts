/**
 * Minimal typed JSON transport for the cloud API, running in the main process. It never touches request
 * history, never logs headers or bodies, and maps failures to CloudApiError (docs/SYNC_DESIGN.md 7.6).
 */
import { CloudApiError } from './errors'

export interface CloudHttpOptions {
  /** Electron's net.fetch in the app (system proxy support); global fetch in tests. */
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export interface RequestOptions {
  body?: unknown
  token?: string | null
  query?: Record<string, string | number | undefined>
  timeoutMs?: number
}

export const normalizeBaseUrl = (url: string): string => url.trim().replace(/\/+$/, '')

export function assertBaseUrl(url: string): string {
  const u = normalizeBaseUrl(url)
  let parsed: URL
  try {
    parsed = new URL(u)
  } catch {
    throw new Error('The cloud address is not a valid URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('The cloud address must start with http:// or https://')
  return u
}

function retryAfter(header: string | null): number | null {
  if (!header) return null
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds) * 1000
  const date = Date.parse(header)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null
}

export class CloudHttp {
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(opts: CloudHttpOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a))
    this.timeoutMs = opts.timeoutMs ?? 30_000
  }

  async request<T>(method: string, baseUrl: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(normalizeBaseUrl(baseUrl) + path)
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v))
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? this.timeoutMs)
    let res: Response
    let text: string
    try {
      res = await this.fetchImpl(url.toString(), {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      })
      text = await res.text()
    } catch (err) {
      const aborted = controller.signal.aborted
      throw new CloudApiError({
        kind: 'network', status: 0, code: aborted ? 'timeout' : 'network_error',
        message: aborted ? 'The cloud did not answer in time' : `Could not reach the cloud (${err instanceof Error ? err.message : 'network error'})`,
      })
    } finally {
      clearTimeout(timer)
    }

    if (res.status >= 200 && res.status < 300) {
      if (!text) return undefined as T
      try {
        return JSON.parse(text) as T
      } catch {
        throw new CloudApiError({ kind: 'http', status: res.status, code: 'invalid_json', message: 'The cloud sent an unreadable answer' })
      }
    }
    let code = `http_${res.status}`
    let message = `The cloud answered HTTP ${res.status}`
    let details: Record<string, unknown> | undefined
    try {
      const j = JSON.parse(text) as { error?: { code?: unknown; message?: unknown; details?: unknown } | string; message?: unknown }
      if (typeof j.error === 'string') message = j.error
      else if (j.error && typeof j.error === 'object') {
        if (typeof j.error.code === 'string') code = j.error.code
        if (typeof j.error.message === 'string') message = j.error.message
        if (j.error.details && typeof j.error.details === 'object') details = j.error.details as Record<string, unknown>
      } else if (typeof j.message === 'string') message = j.message
    } catch {
      /* non-JSON error body */
    }
    throw new CloudApiError({ kind: 'http', status: res.status, code, message, details, retryAfterMs: retryAfter(res.headers.get('retry-after')) })
  }
}
