import type { CloudFetchInput, HttpRequestInput, HttpResponseData } from '../../shared/types'
import { toErrorPayload, invalidInput } from '../lib/errors'
import { assertUuid, isUuid } from '../lib/ids'
import type { HistoryRepository } from '../repositories/history'
import type { FileAccess } from './fileGrants'
import { executeHttp, normalizeUrl } from './httpExecutor'

const RUN_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/

/**
 * Runs requests, tracks cancellable runs, and records every attempt (success or failure) in
 * history. History stores `historyUrl` when the renderer supplies it (secrets kept as {{name}}
 * placeholders), else the URL as typed (normalized), never an apiKey query parameter
 * added by auth, so credentials never end up in the log.
 */
export class HttpService {
  private readonly runs = new Map<string, AbortController>()

  constructor(
    private readonly history: HistoryRepository,
    private readonly files?: FileAccess,
    /** Replaces secret values that scripts of a session read with `{{name}}` (ScriptService.redact). */
    private readonly redact: (sessionId: string | null | undefined, text: string) => string = (_s, t) => t,
  ) {}

  async execute(input: HttpRequestInput): Promise<HttpResponseData> {
    const workspaceId = assertUuid(input.workspaceId, 'workspaceId')
    const runId = input.requestRunId ?? null
    if (runId !== null) {
      if (!RUN_ID_RE.test(runId)) throw invalidInput('requestRunId must be 1-128 characters of [A-Za-z0-9._:-]')
      if (this.runs.has(runId)) throw invalidInput('a request with this requestRunId is already running')
    }
    const controller = new AbortController()
    if (runId !== null) this.runs.set(runId, controller)

    const started = performance.now()
    try {
      const response = await executeHttp(input, { signal: controller.signal, files: this.files })
      this.record(input, workspaceId, {
        statusCode: response.status,
        ok: response.status >= 200 && response.status < 300,
        errorMessage: null,
        durationMs: response.durationMs,
      })
      return response
    } catch (err) {
      this.record(input, workspaceId, {
        statusCode: null,
        ok: false,
        errorMessage: toErrorPayload(err).message,
        durationMs: performance.now() - started,
      })
      throw err
    } finally {
      if (runId !== null) this.runs.delete(runId)
    }
  }

  /**
   * Internal transport for the app's own cloud API calls: never recorded in history, never reads
   * local files, and has no run id (not cancellable). Kept separate from `execute` so history
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
      })
    } catch (err) {
      // A history failure (e.g. workspace deleted mid-request) must never hide the HTTP outcome.
      console.warn('[slinger] could not record history:', err instanceof Error ? err.message : err)
    }
  }
}
