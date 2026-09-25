/**
 * Runs one draft exactly the way a manual "Send" does: resolve templates (revealing the
 * secrets the request needs), execute over IPC, classify the outcome. Used by request tabs
 * and by the collection runner so both behave identically.
 */
import type { HttpResponseData } from '../../../shared/types'
import { scopeStore } from '../../app/scope.svelte'
import { api, errorInfo } from '../../lib/ipc'
import { prepareRequest, secretsNeeded } from '../../lib/prepare'
import type { RequestDraft } from '../../lib/request'
import { uuid } from '../../lib/template'

export type ExecuteOutcome =
  | { ok: true; response: HttpResponseData; warnings: string[]; runId: string; elapsedMs: number }
  | { ok: false; kind: 'unresolved'; error: string; unresolved: string[] }
  | { ok: false; kind: 'invalid'; error: string }
  | { ok: false; kind: 'cancelled'; error: string }
  | { ok: false; kind: 'failed'; error: string; code?: string }

export interface ExecuteContext {
  workspaceId: string
  requestId?: string | null
  /** Called with the run id as soon as it is assigned, so callers can cancel. */
  onRunId?: (runId: string) => void
  /** Set by the caller when it requested cancellation; used to label the failure. */
  wasCancelled?: () => boolean
}

export async function executeDraft(draft: RequestDraft, ctx: ExecuteContext): Promise<ExecuteOutcome> {
  const scope = scopeStore.scope

  // Reveal only the secrets this request references; they live in memory for this call only.
  const secrets = new Map<string, string>()
  try {
    for (const v of secretsNeeded(draft, scope)) {
      if (!v.id) continue
      secrets.set(v.key, await api().revealEnvironmentVariable(v.id))
    }
  } catch (e) {
    return { ok: false, kind: 'failed', error: `Could not read a secret variable: ${errorInfo(e).message}` }
  }

  const prepared = prepareRequest(draft, { workspaceId: ctx.workspaceId, requestId: ctx.requestId, scope, secrets })
  if (!prepared.ok) {
    return prepared.unresolved.length > 0
      ? { ok: false, kind: 'unresolved', error: prepared.error, unresolved: prepared.unresolved }
      : { ok: false, kind: 'invalid', error: prepared.error }
  }

  const runId = uuid()
  ctx.onRunId?.(runId)
  const started = performance.now()
  try {
    const response = await api().executeHttpRequest({ ...prepared.input, requestRunId: runId })
    return { ok: true, response, warnings: prepared.warnings, runId, elapsedMs: Math.round(performance.now() - started) }
  } catch (e) {
    const info = errorInfo(e)
    if (ctx.wasCancelled?.()) return { ok: false, kind: 'cancelled', error: 'Request cancelled' }
    return { ok: false, kind: 'failed', error: info.message, code: info.code }
  }
}

export async function cancelRun(runId: string): Promise<void> {
  try {
    await api().cancelHttpRequest(runId)
  } catch {
    /* the run may already have finished */
  }
}
