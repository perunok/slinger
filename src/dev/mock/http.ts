import { IpcError, type HttpRequestInput, type HttpResponseData, type RequestHeader } from '../../../shared/types'
import { clampMaxResponseBytes } from '../../../shared/responseLimit'
import type { SlingerIpcApi } from '../../../shared/ipc-contract'
import { cannedResponse, isMockHost, type CannedResponse } from './canned'
import { buildRequest, type BuiltRequest } from './requestBuilder'
import type { MockState } from './store'
import { mockAccessToken } from './oauth2'
import { bytesToBase64, nowSec, uuid } from './util'
import { mockCookieHeader, mockStoreCookies } from './cookies'
import { mergeCookieHeader } from '../../../shared/cookies'

type HttpApi = Pick<SlingerIpcApi, 'executeHttpRequest' | 'cancelHttpRequest' | 'cloudFetch' | 'chooseResponseDownloadFile'>

/** Where the mock "saves" downloads (nothing is written in the browser). */
export const MOCK_DOWNLOAD_DIR = '/home/user/Downloads'

/** Like main: a body over the request's limit is not returned (status and headers are); a download has no body. */
function applyLimit(data: HttpResponseData, input: HttpRequestInput, savedTo: string | null): HttpResponseData {
  if (savedTo) return { ...data, bodyText: null, bodyBase64: null, savedToFile: savedTo }
  const limit = clampMaxResponseBytes(input.maxResponseBytes)
  if (data.bodyByteLength <= limit) return data
  return { ...data, bodyText: null, bodyBase64: null, bodyTooLarge: { limitBytes: limit } }
}

const HISTORY_CAP = 500

interface RunControl {
  controller: AbortController
  cancelled: boolean
  timedOut: boolean
}

export function decodeBody(bytes: Uint8Array): Pick<HttpResponseData, 'bodyText' | 'bodyBase64' | 'bodyByteLength'> {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return { bodyText: text, bodyBase64: null, bodyByteLength: bytes.length }
  } catch {
    return { bodyText: null, bodyBase64: bytesToBase64(bytes), bodyByteLength: bytes.length }
  }
}

function abortError(run: RunControl, timeoutMs: number | undefined): IpcError | null {
  if (run.cancelled) return new IpcError({ code: 'network_error', message: 'Request cancelled' })
  if (run.timedOut) return new IpcError({ code: 'network_error', message: `Request timed out after ${timeoutMs} ms` })
  return null
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'))
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function runCanned(built: BuiltRequest, method: string, signal: AbortSignal): Promise<CannedResponse> {
  const canned = cannedResponse({ method, url: built.url, headers: built.headers, bodyText: built.bodyText })
  if (canned.delayMs) await abortableDelay(canned.delayMs, signal)
  return canned
}

function cannedToData(canned: CannedResponse, durationMs: number): HttpResponseData {
  const bytes = typeof canned.body === 'string' ? new TextEncoder().encode(canned.body) : canned.body
  const headers: RequestHeader[] = [
    { key: 'Content-Type', value: canned.contentType },
    { key: 'Content-Length', value: String(bytes.length) },
    { key: 'X-Slinger-Mock', value: 'true' },
    ...(canned.extraHeaders ?? []),
  ]
  return { status: canned.status, statusText: canned.statusText, durationMs, headers, ...decodeBody(bytes) }
}

async function runFetch(built: BuiltRequest, method: string, signal: AbortSignal): Promise<HttpResponseData> {
  const started = performance.now()
  const headers = new Headers()
  for (const h of built.headers) {
    try {
      headers.append(h.key, h.value)
    } catch {
      /* forbidden or malformed header name: the browser would drop it as well */
    }
  }
  const response = await fetch(built.url, { method, headers, body: built.body, signal })
  const bytes = new Uint8Array(await response.arrayBuffer())
  const out: RequestHeader[] = []
  response.headers.forEach((value, key) => out.push({ key, value }))
  return {
    status: response.status,
    statusText: response.statusText,
    durationMs: Math.round(performance.now() - started),
    headers: out,
    ...decodeBody(bytes),
  }
}

/** Like main: the workspace's jar adds its cookies (a Cookie header the user set wins per name) unless `cookies: 'off'`. */
function withJarCookies(s: MockState | null, input: HttpRequestInput, built: BuiltRequest): URL | null {
  if (!s || input.cookies === 'off' || !input.workspaceId) return null
  let url: URL
  try {
    url = new URL(built.url)
  } catch {
    return null
  }
  const own = built.headers.find((h) => h.key.toLowerCase() === 'cookie')
  const merged = mergeCookieHeader(own?.value, mockCookieHeader(s, input.workspaceId, url))
  if (merged) built.headers = [...built.headers.filter((h) => h.key.toLowerCase() !== 'cookie'), { key: 'Cookie', value: merged }]
  return url
}

async function perform(
  input: HttpRequestInput,
  run: RunControl,
  oauth2Token?: (tokenKey: string, origin: string) => string,
  s: MockState | null = null,
): Promise<HttpResponseData> {
  const method = input.method.toUpperCase()
  const built = buildRequest(input, oauth2Token)
  const jarUrl = withJarCookies(s, input, built)
  const store = (data: HttpResponseData) => {
    if (s && jarUrl) mockStoreCookies(s, input.workspaceId, jarUrl, data.headers.filter((h) => h.key.toLowerCase() === 'set-cookie').map((h) => h.value))
    return data
  }
  const started = performance.now()
  try {
    if (isMockHost(built.url)) {
      const canned = await runCanned(built, method, run.controller.signal)
      return store(cannedToData(canned, Math.max(1, Math.round(performance.now() - started))))
    }
    return store(await runFetch(built, method, run.controller.signal))
  } catch (e) {
    const aborted = abortError(run, input.timeoutMs)
    if (aborted) throw aborted
    if (e instanceof IpcError) throw e
    throw new IpcError({
      code: 'network_error',
      message: 'Failed to fetch (network error or blocked by CORS in the browser mock)',
      details: { cause: e instanceof Error ? e.message : String(e) },
    })
  }
}

function record(s: MockState, input: HttpRequestInput, result: { status: number | null; error: string | null; ms: number }): void {
  s.history.unshift({
    id: uuid(),
    workspaceId: input.workspaceId,
    requestId: input.requestId ?? null,
    requestName: input.requestName ?? null,
    method: input.method.toUpperCase(),
    url: input.url,
    statusCode: result.status,
    ok: result.status !== null && result.status < 400,
    errorMessage: result.error,
    durationMs: result.ms,
    createdAt: nowSec(),
    kind: 'send',
    source: input.historySource === 'mcp' ? 'mcp' : null,
    detail: null,
  })
  if (s.history.length > HISTORY_CAP) s.history.length = HISTORY_CAP
}

export function createHttpApi(s: MockState): HttpApi {
  const runs = new Map<string, RunControl>()
  const downloads = new Map<string, string>()
  return {
    async chooseResponseDownloadFile(suggestedName) {
      const name = suggestedName.split(/[\\/]/).pop()?.trim() || 'response'
      const downloadId = uuid()
      downloads.set(downloadId, `${MOCK_DOWNLOAD_DIR}/${name}`)
      return { downloadId, fileName: name }
    },
    executeHttpRequest(input) {
      let savedTo: string | null = null
      if (input.downloadId) {
        savedTo = downloads.get(input.downloadId) ?? null
        downloads.delete(input.downloadId)
        if (!savedTo) return Promise.reject(new IpcError({ code: 'invalid_input', message: 'The file for this download was not chosen, or it was chosen too long ago: choose it again' }))
      }
      // Registered synchronously so a cancel issued right after the call always finds it.
      const runId = input.requestRunId ?? uuid()
      const run: RunControl = { controller: new AbortController(), cancelled: false, timedOut: false }
      runs.set(runId, run)
      const timer =
        input.timeoutMs && input.timeoutMs > 0
          ? setTimeout(() => {
              run.timedOut = true
              run.controller.abort()
            }, input.timeoutMs)
          : null
      const started = performance.now()
      // perform() is async, so a build error (no OAuth 2.0 token, ...) still rejects and is recorded.
      return perform(input, run, (key, origin) => mockAccessToken(s, key, origin), s)
        .then((data) => applyLimit(data, input, savedTo))
        .then(
          (data) => {
            record(s, input, { status: data.status, error: null, ms: data.durationMs })
            return data
          },
          (e: unknown) => {
            const message = e instanceof Error ? e.message : String(e)
            record(s, input, { status: null, error: message, ms: Math.round(performance.now() - started) })
            throw e
          },
        )
        .finally(() => {
          if (timer) clearTimeout(timer)
          runs.delete(runId)
        })
    },
    // Internal cloud transport: same network path, but no history row (matches the real main process).
    cloudFetch(input) {
      const run: RunControl = { controller: new AbortController(), cancelled: false, timedOut: false }
      const timer = input.timeoutMs ? setTimeout(() => ((run.timedOut = true), run.controller.abort()), input.timeoutMs) : null
      return perform(
        {
          method: input.method,
          url: input.url,
          headers: input.headers,
          auth: { kind: 'none' },
          body: input.body ? { mode: 'raw', raw: input.body } : { mode: 'none' },
          timeoutMs: input.timeoutMs,
          workspaceId: '',
        },
        run,
      ).finally(() => {
        if (timer) clearTimeout(timer)
      })
    },
    async cancelHttpRequest(requestRunId) {
      const run = runs.get(requestRunId)
      if (!run) return
      run.cancelled = true
      run.controller.abort()
    },
  }
}

