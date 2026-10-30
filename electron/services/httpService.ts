import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { CloudFetchInput, HttpRequestInput, HttpResponseData, ResponseDownloadTarget } from '../../shared/types'
import { clampMaxResponseBytes } from '../../shared/responseLimit'
import { IpcError, toErrorPayload, invalidInput } from '../lib/errors'
import { assertUuid, isUuid } from '../lib/ids'
import type { HistoryRepository } from '../repositories/history'
import type { FileAccess } from './fileGrants'
import type { CookieJarPort } from './cookieJarPort'
import { executeHttp, normalizeUrl, scrubRequestValues, type OAuth2TokenLookup } from './httpExecutor'
import type { NetworkRouter } from './network'
import { maskUserinfo } from './scriptHttp'

const RUN_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/
/** How long a file chosen for "Send and download to file" waits for its request. */
export const DOWNLOAD_TARGET_TTL_MS = 10 * 60_000

/**
 * Runs requests, tracks cancellable runs, and records every attempt (success or failure) in
 * history. History stores `historyUrl` when the renderer supplies it (secrets kept as {{name}}
 * placeholders), else the URL as typed (normalized), never an apiKey query parameter
 * added by auth and never an OAuth 2.0 token (applied by the executor after this URL was taken),
 * so credentials never end up in the log.
 */
export class HttpService {
  private readonly runs = new Map<string, AbortController>()
  /** Files the user picked in main's save dialog, by one-time id (the renderer never names a path to write). */
  private readonly downloads = new Map<string, { path: string; expires: number }>()

  constructor(
    private readonly history: HistoryRepository,
    private readonly files?: FileAccess,
    /** Replaces secret values that scripts of a session read with `{{name}}` (ScriptService.redact). */
    private readonly redact: (sessionId: string | null | undefined, text: string) => string = (_s, t) => t,
    /** Stored OAuth 2.0 access tokens by key (OAuth2Service.accessTokenFor); applied in main, never recorded. */
    private readonly oauth2Token?: OAuth2TokenLookup,
    /** Settings > Network (proxy, certificates, SSL verification); absent: direct connections. */
    private readonly network?: NetworkRouter,
    /** The workspace's cookie jar (CookieService.jar); used unless the input says `cookies: 'off'`. */
    private readonly cookieJar?: (workspaceId: string) => CookieJarPort,
  ) {}

  /** Remembers a file the user picked for "Send and download to file"; its id is good for one request. */
  registerDownload(path: string, now = Date.now()): ResponseDownloadTarget {
    for (const [id, d] of this.downloads) if (d.expires <= now) this.downloads.delete(id)
    const downloadId = randomUUID()
    this.downloads.set(downloadId, { path, expires: now + DOWNLOAD_TARGET_TTL_MS })
    return { downloadId, fileName: basename(path) }
  }

  private takeDownload(id: string): string {
    const d = this.downloads.get(id)
    this.downloads.delete(id)
    if (!d || d.expires <= Date.now()) throw invalidInput('The file for this download was not chosen, or it was chosen too long ago: choose it again')
    return d.path
  }

  /** Gives a download id back after a send that was refused before anything was written (the window may retry it). */
  private returnDownload(id: string, path: string): void {
    this.downloads.set(id, { path, expires: Date.now() + DOWNLOAD_TARGET_TTL_MS })
  }

  async execute(input: HttpRequestInput): Promise<HttpResponseData> {
    const workspaceId = assertUuid(input.workspaceId, 'workspaceId')
    const runId = input.requestRunId ?? null
    if (runId !== null) {
      if (!RUN_ID_RE.test(runId)) throw invalidInput('requestRunId must be 1-128 characters of [A-Za-z0-9._:-]')
      if (this.runs.has(runId)) throw invalidInput('a request with this requestRunId is already running')
    }
    const toFile = input.downloadId ? this.takeDownload(input.downloadId) : undefined
    const controller = new AbortController()
    if (runId !== null) this.runs.set(runId, controller)

    const started = performance.now()
    try {
      const response = await executeHttp(input, {
        signal: controller.signal,
        files: this.files,
        oauth2Token: this.oauth2Token,
        // The user's limit (Settings), enforced while the body streams in; a larger body is reported, not loaded.
        maxResponseBytes: clampMaxResponseBytes(input.maxResponseBytes),
        oversize: 'report',
        toFile,
        network: this.network,
        cookieJar: input.cookies !== 'off' ? this.cookieJar?.(workspaceId) : undefined,
      })
      // Redirect targets come from the server and may repeat values of the request (a token in the query): shown like errors.
      if (response.redirects) {
        response.redirects = response.redirects.map((r) => ({
          ...r,
          location: this.redact(input.scriptSessionId, scrubRequestValues(maskUserinfo(r.location), input)),
        }))
      }
      this.record(input, workspaceId, {
        statusCode: response.status,
        ok: response.status >= 200 && response.status < 300,
        errorMessage: null,
        durationMs: response.durationMs,
      })
      return response
    } catch (err) {
      // The message may quote resolved values (platform errors about the URL, a host from a secret variable): it goes
      // to history and back to the window (and so to an AI assistant) without them.
      const safe = this.safeError(err, input)
      // A token refused for a new origin: the user may allow it in the window, which retries with the same file.
      if (toFile !== undefined && input.downloadId && safe.details?.reason === 'oauth2_new_origin') this.returnDownload(input.downloadId, toFile)
      this.record(input, workspaceId, {
        statusCode: null,
        ok: false,
        errorMessage: safe.message,
        durationMs: performance.now() - started,
      })
      throw safe
    } finally {
      if (runId !== null) this.runs.delete(runId)
    }
  }

  /**
   * Internal transport for the app's own cloud API calls: never recorded in history, never reads
   * local files, and has no run id (not cancellable); bodies over 50 MB fail (executeHttp's default). Kept separate from `execute` so history
   * stays a log of the user's requests only.
   */
  async fetchInternal(input: CloudFetchInput): Promise<HttpResponseData> {
    return executeHttp({
      method: input.method,
      url: input.url,
      headers: input.headers,
      auth: { kind: 'none' },
      body: input.body ? { mode: 'raw', raw: { content: input.body.content, contentType: input.body.contentType } } : { mode: 'none' },
      timeoutMs: input.timeoutMs,
      workspaceId: '',
    })
  }

  private safeError(err: unknown, input: HttpRequestInput): IpcError {
    const payload = toErrorPayload(err)
    const message = this.redact(input.scriptSessionId, scrubRequestValues(payload.message, input))
    return new IpcError({ ...payload, message })
  }

  /** Cancelling an unknown or already finished run is a no-op. */
  cancel(runId: string): void {
    this.runs.get(runId)?.abort()
  }

  private record(
    input: HttpRequestInput,
    workspaceId: string,
    result: { statusCode: number | null; ok: boolean; errorMessage: string | null; durationMs: number },
  ): void {
    try {
      this.history.record({
        workspaceId,
        requestId: isUuid(input.requestId) ? input.requestId : null,
        requestName: input.requestName ?? null,
        method: (input.method || 'GET').trim().toUpperCase().slice(0, 32) || 'GET',
        url: this.redact(input.scriptSessionId, normalizeUrl(input.historyUrl ?? input.url ?? '')).slice(0, 8192),
        ...result,
        errorMessage: result.errorMessage === null ? null : this.redact(input.scriptSessionId, result.errorMessage),
        source: input.historySource === 'mcp' ? 'mcp' : null,
      })
    } catch (err) {
      // A history failure (e.g. workspace deleted mid-request) must never hide the HTTP outcome.
      console.warn('[slinger] could not record history:', err instanceof Error ? err.message : err)
    }
  }
}
