/**
 * Runs one draft exactly the way a manual "Send" does, so request tabs and the collection runner behave
 * identically:
 *
 *   1. pre-request scripts (collection -> folders -> request) run in the main-process sandbox; environment,
 *      collection variable and global writes are persisted there, request mutations apply to an outgoing COPY of
 *      the draft only;
 *   2. templates are resolved (revealing just the secrets the request references) with the variables the
 *      scripts set (local > environment > collection variables > globals), using the scope of the request's own
 *      collection; an OAuth 2.0 token is looked up (and refreshed when it is about to expire) by its resolved settings;
 *   3. the request is executed over IPC;
 *   4. test scripts run against the response.
 *
 * One run id covers the whole send, so cancelHttpRequest(runId) stops a running script as well as the request.
 */
import type { HttpResponseData, RunScriptsInput, ScriptEventName, ScriptRequestData, ScriptVariables } from '../../../shared/types'
import { settings } from '../../app/settings.svelte'
import { scopeStore } from '../../app/scope.svelte'
import { app } from '../../app/state.svelte'
import { api, errorInfo } from '../../lib/ipc'
import { prepareRequest, secretsNeeded } from '../../lib/prepare'
import type { RequestDraft } from '../../lib/request'
import {
  applyRequestData,
  emptyScriptOutput,
  requestDataFromDraft,
  requestDataFromInput,
  responseDataFrom,
  scriptAuthView,
  scopeWithScriptVariables,
  scriptChain,
  type ScriptOutput,
} from '../../lib/scripts'
import { uuid } from '../../lib/template'

export type ExecuteOutcome =
  | { ok: true; response: HttpResponseData; warnings: string[]; runId: string; elapsedMs: number; scripts: ScriptOutput }
  | { ok: false; kind: 'unresolved'; error: string; unresolved: string[]; scripts: ScriptOutput }
  | { ok: false; kind: 'invalid'; error: string; scripts: ScriptOutput }
  | { ok: false; kind: 'cancelled'; error: string; scripts: ScriptOutput }
  | { ok: false; kind: 'failed'; error: string; code?: string; scripts: ScriptOutput }
  /** A pre-request script failed, so the request was not sent. */
  | { ok: false; kind: 'script'; error: string; scripts: ScriptOutput }

/** State shared by the requests of one collection run (a single send uses a fresh one). */
export interface ScriptRunContext {
  /** Groups the script runs (history keeps secrets that scripts read out of its URLs). */
  sessionId: string
  /** pm.variables: lives for the whole run, so one request's values reach the next. */
  variables: ScriptVariables
  /**
   * pm.collectionVariables of a request that is not saved in a collection (in memory, for this send / run only).
   * Requests in a collection use its persisted variables instead.
   */
  collectionVariables: ScriptVariables
  iteration: number
  iterationCount: number
}

export const newScriptRun = (): ScriptRunContext => ({ sessionId: uuid(), variables: {}, collectionVariables: {}, iteration: 0, iterationCount: 1 })

export interface ExecuteContext {
  workspaceId: string
  requestId?: string | null
  /** Where the request lives: selects the collection and folder scripts. */
  collectionId?: string | null
  folderId?: string | null
  /** Collection runs pass one context for all their requests. */
  run?: ScriptRunContext
  /** Called with the run id as soon as it is assigned, so callers can cancel. */
  onRunId?: (runId: string) => void
  /** Set by the caller when it requested cancellation; used to label the failure. */
  wasCancelled?: () => boolean
}

function scriptsOf(draft: RequestDraft, ctx: ExecuteContext, event: ScriptEventName) {
  const collection = ctx.collectionId ? (app.collections.find((c) => c.id === ctx.collectionId) ?? null) : null
  return scriptChain(event, {
    collection,
    folders: ctx.collectionId ? app.foldersOf(ctx.collectionId) : [],
    folderId: ctx.folderId ?? null,
    requestName: draft.name,
    requestEvents: draft.extras.scripts,
  })
}

export async function executeDraft(input: RequestDraft, ctx: ExecuteContext): Promise<ExecuteOutcome> {
  const scripts = emptyScriptOutput()
  const run = ctx.run ?? newScriptRun()
  const runId = uuid()
  ctx.onRunId?.(runId)
  const cancelled = (): ExecuteOutcome => ({ ok: false, kind: 'cancelled', error: 'Request cancelled', scripts })
  const environmentId = app.activeEnvironment?.workspaceId === ctx.workspaceId ? app.activeEnvironmentId : null

  const runScripts = async (event: ScriptEventName, draft: RequestDraft, extra: Partial<RunScriptsInput> = {}) => {
    const chain = scriptsOf(draft, ctx, event)
    if (chain.length === 0) return null
    const result = await api().runScripts({
      runId,
      sessionId: run.sessionId,
      workspaceId: ctx.workspaceId,
      environmentId,
      event,
      scripts: chain,
      request: requestDataFromDraft(draft),
      response: null,
      variables: run.variables,
      collectionId: ctx.collectionId ?? null,
      collectionVariables: ctx.collectionId ? {} : run.collectionVariables,
      info: { requestName: draft.name, requestId: ctx.requestId ?? null, iteration: run.iteration, iterationCount: run.iterationCount },
      timeoutMs: settings.scriptTimeoutMs,
      sendRequestTimeoutMs: draft.timeoutMs ?? undefined,
      continueOnError: settings.scriptContinueOnError,
      ...extra,
    })
    run.variables = result.variables
    if (!ctx.collectionId) run.collectionVariables = result.collectionVariables
    scripts.console.push(...result.console)
    scripts.tests.push(...result.tests)
    scripts.errors.push(...result.errors)
    scripts.scriptCount += chain.length
    if (result.nextRequest !== undefined) scripts.nextRequest = result.nextRequest
    // Reload the scopes (and so the template scope) the scripts wrote to.
    await Promise.all([
      result.environmentChanged ? app.refreshEnvVariables() : null,
      result.collectionVariablesChanged && ctx.collectionId ? app.reloadCollectionVariables(ctx.collectionId) : null,
      result.globalsChanged ? app.reloadGlobals() : null,
    ])
    return result
  }

  // 1. Pre-request scripts, on a copy of the draft.
  let draft = input
  try {
    const pre = await runScripts('prerequest', draft)
    if (pre) {
      if (pre.errors.some((e) => e.kind === 'cancelled') || ctx.wasCancelled?.()) return cancelled()
      if (pre.errors.length > 0 && !settings.scriptContinueOnError) {
        const f = pre.errors[0]
        return { ok: false, kind: 'script', error: `Pre-request script failed (${f.source}): ${f.message}`, scripts }
      }
      if (pre.request) draft = applyRequestData(draft, pre.request)
    }
  } catch (e) {
    return { ok: false, kind: 'failed', error: `Could not run the pre-request scripts: ${errorInfo(e).message}`, scripts }
  }
  if (ctx.wasCancelled?.()) return cancelled()

  // 2. Templates, with what the scripts set.
  const scope = scopeWithScriptVariables(scopeStore.scopeFor(ctx.collectionId), {
    collection: ctx.collectionId ? undefined : run.collectionVariables,
    local: run.variables,
  })
  // Reveal only the secrets this request references; they live in memory for this call only.
  const secrets = new Map<string, string>()
  try {
    for (const v of secretsNeeded(draft, scope)) {
      if (!v.id) continue
      secrets.set(v.key, v.source === 'global' ? await api().revealGlobalVariable(v.id) : await api().revealEnvironmentVariable(v.id))
    }
  } catch (e) {
    return { ok: false, kind: 'failed', error: `Could not read a secret variable: ${errorInfo(e).message}`, scripts }
  }

  const prepared = prepareRequest(draft, { workspaceId: ctx.workspaceId, requestId: ctx.requestId, scope, secrets })
  if (!prepared.ok) {
    return prepared.unresolved.length > 0
      ? { ok: false, kind: 'unresolved', error: prepared.error, unresolved: prepared.unresolved, scripts }
      : { ok: false, kind: 'invalid', error: prepared.error, scripts }
  }

  // OAuth 2.0: main keeps the token; find it for these settings, refreshing it first when it is about to expire.
  if (prepared.oauth2 && prepared.input.auth.oauth2) {
    try {
      const status = await api().refreshOAuth2Token(prepared.oauth2, { ifExpiring: true })
      if (!status.hasToken) {
        return { ok: false, kind: 'invalid', error: 'No access token yet: click Get New Access Token in the Authorization tab.', scripts }
      }
      if (status.expired) {
        return { ok: false, kind: 'invalid', error: 'The access token has expired: click Get New Access Token in the Authorization tab.', scripts }
      }
      prepared.input.auth.oauth2.tokenKey = status.tokenKey
    } catch (e) {
      const info = errorInfo(e)
      return { ok: false, kind: 'failed', error: info.message, code: info.code, scripts }
    }
    if (ctx.wasCancelled?.()) return cancelled()
  }

  // 3. The request.
  const started = performance.now()
  let response: HttpResponseData
  try {
    response = await api().executeHttpRequest({ ...prepared.input, requestRunId: runId, scriptSessionId: run.sessionId })
  } catch (e) {
    const info = errorInfo(e)
    if (ctx.wasCancelled?.()) return cancelled()
    return { ok: false, kind: 'failed', error: info.message, code: info.code, scripts }
  }
  const elapsedMs = Math.round(performance.now() - started)

  // 4. Test scripts. They see the request as sent, but with secret variables still as {{name}}.
  if (!ctx.wasCancelled?.()) {
    try {
      const shown = prepareRequest(draft, { workspaceId: ctx.workspaceId, requestId: ctx.requestId, scope, allowUnresolved: true })
      await runScripts('test', draft, {
        request: shown.ok ? withAuthView(requestDataFromInput(shown.input), draft) : requestDataFromDraft(draft),
        response: responseDataFrom(response),
      })
    } catch (e) {
      scripts.errors.push({ source: 'Tests', kind: 'internal', message: `Could not run the test scripts: ${errorInfo(e).message}` })
    }
  }
  return { ok: true, response, warnings: prepared.warnings, runId, elapsedMs, scripts }
}

/** `pm.request.auth` for test scripts: the same read-only view as in pre-request scripts. */
function withAuthView(data: ScriptRequestData, draft: RequestDraft): ScriptRequestData {
  const auth = scriptAuthView(draft.auth)
  return auth ? { ...data, auth } : data
}

export async function cancelRun(runId: string): Promise<void> {
  try {
    await api().cancelHttpRequest(runId)
  } catch {
    /* the run may already have finished */
  }
}
