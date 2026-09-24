import type { HttpRequestInput, HttpResponseData } from '../../shared/types'
import { toErrorPayload, invalidInput } from '../lib/errors'
import { assertUuid, isUuid } from '../lib/ids'
import type { HistoryRepository } from '../repositories/history'
import { executeHttp, normalizeUrl } from './httpExecutor'

const RUN_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/

/**
 * Runs requests, tracks cancellable runs, and records every attempt (success or failure) in
 * history. History stores the URL as typed (normalized) without any apiKey query parameter
 * added by auth, so credentials never end up in the log.
 */
export class HttpService {
  private readonly runs = new Map<string, AbortController>()

  constructor(private readonly history: HistoryRepository) {}

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
      const response = await executeHttp(input, { signal: controller.signal })
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
        url: normalizeUrl(input.url ?? '').slice(0, 8192),
        ...result,
      })
    } catch (err) {
      // A history failure (e.g. workspace deleted mid-request) must never hide the HTTP outcome.
      console.warn('[slinger] could not record history:', err instanceof Error ? err.message : err)
    }
  }
}
