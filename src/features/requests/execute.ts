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
 *
 * An MCP request (`draft.mcp`) takes the same steps, but step 3 opens (or reuses) an MCP client session and runs its
 * operation (`sendMcp`); its outcome is a synthetic HttpResponseData (JSON result, `mcp` set), so the runner,
 * workflows, assistants and test scripts (`pm.response.json()`) handle it like any response.
 */
import type {
  HttpResponseData,
  McpCallOutcome,
  McpConnectInput,
  McpTrustCommandInput,
  OAuth2Config,
  RunScriptsInput,
  ScriptEventName,
  ScriptRequestData,
  ScriptVariables,
} from '../../../shared/types'
import { settings } from '../../app/settings.svelte'
import { scopeStore } from '../../app/scope.svelte'
import { app } from '../../app/state.svelte'
import { api, errorInfo } from '../../lib/ipc'
import { prepareMcp, prepareRequest, secretsNeeded, withMcpOAuth2Token, type McpPreparedCall } from '../../lib/prepare'
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
import { uuid, type TemplateScope, type VariableInfo } from '../../lib/template'
import { mcpConnections, type McpConnection } from '../mcpRequests/connections.svelte'

export type ExecuteOutcome =
  | { ok: true; response: HttpResponseData; warnings: string[]; runId: string; elapsedMs: number; scripts: ScriptOutput }
  | { ok: false; kind: 'unresolved'; error: string; unresolved: string[]; scripts: ScriptOutput }
  | { ok: false; kind: 'invalid'; error: string; scripts: ScriptOutput }
  | { ok: false; kind: 'cancelled'; error: string; scripts: ScriptOutput }
  /**
   * `untrustedCommand`: an MCP request's stdio command that is not allowed on this device yet (the window asks the user).
   * `mcpError`: the error an MCP call ended with (JSON-RPC code and data when the server answered with one).
   */
  | {
      ok: false
      kind: 'failed'
      error: string
      code?: string
      untrustedCommand?: McpTrustCommandInput
      mcpError?: NonNullable<McpCallOutcome['error']>
      scripts: ScriptOutput
    }
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
  /** The current row of a data-driven run's data file (pm.iterationData, `{{column}}`), or null. */
  iterationData: ScriptVariables | null
}

export const newScriptRun = (): ScriptRunContext => ({
  sessionId: uuid(),
  variables: {},
  collectionVariables: {},
  iteration: 0,
  iterationCount: 1,
  iterationData: null,
})

export interface ExecuteContext {
  workspaceId: string
  requestId?: string | null
  /** Where the request lives: selects the collection and folder scripts. */
  collectionId?: string | null
  folderId?: string | null
  /** Collection runs pass one context for all their requests. */
  run?: ScriptRunContext
  /**
   * The environment to use instead of the active one (null: none). Collection runs pin the one they started with, so
   * switching environments while a run goes on in the background does not change the rest of the run. Absent: the
   * active environment of this workspace.
   */
  environment?: { id: string; name: string } | null
  /** Called with the run id as soon as it is assigned, so callers can cancel. */
  onRunId?: (runId: string) => void
  /** Set by the caller when it requested cancellation; used to label the failure. */
  wasCancelled?: () => boolean
  /** 'mcp': an AI assistant sent it (the history entry is flagged). */
  source?: 'mcp'
  /**
   * MCP requests: the connection registry key, `tab:<tabId>` for a request tab. Absent: a session shared by every send
   * to the same server, closed after 2 min without a call.
   */
  mcpSessionKey?: string
  /** MCP requests: who opens the connection. Absent: 'mcp' for an assistant, 'runner' within a run, else 'user'. */
  mcpOrigin?: McpConnectInput['origin']
}

/** Where an MCP request's OAuth 2.0 token is fetched (its Authorization panel lives in the Connection section). */
export const MCP_TOKEN_WHERE = 'the Connection section'

/** The command main refused (its error details), as the window's Allow dialog needs it. */
export function untrustedCommandOf(details: Record<string, unknown>): McpTrustCommandInput {
  const { command, args, cwd, env } = details as Partial<McpTrustCommandInput>
  return {
    command: typeof command === 'string' ? command : '',
    args: Array.isArray(args) ? args.map(String) : [],
    cwd: typeof cwd === 'string' ? cwd : '',
    env: Array.isArray(env) ? env.map((e) => ({ key: String(e?.key ?? ''), value: String(e?.value ?? '') })) : [],
  }
}

/** Shown (and returned to runs, workflows and assistants) when a stdio command still has to be allowed in the window. */
export const UNTRUSTED_COMMAND_MESSAGE =
  'This command has not been allowed on this device yet. Open the request in Slinger and run it once to allow it.'

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
  const activeEnvironmentId = app.activeEnvironment?.workspaceId === ctx.workspaceId ? app.activeEnvironmentId : null
  const environmentId = ctx.environment !== undefined ? (ctx.environment?.id ?? null) : activeEnvironmentId

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
      ...(run.iterationData ? { iterationData: run.iterationData } : {}),
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
      // pm.request edits of an MCP request are ignored: they have no MCP meaning.
      if (pre.request && !input.mcp) draft = applyRequestData(draft, pre.request)
    }
  } catch (e) {
    return { ok: false, kind: 'failed', error: `Could not run the pre-request scripts: ${errorInfo(e).message}`, scripts }
  }
  if (ctx.wasCancelled?.()) return cancelled()

  // 2. Templates, with what the scripts set. A pinned environment that is no longer the active one is read fresh here,
  // after the pre-request scripts (which may have written to it).
  let envLayer: { name: string | null; vars: VariableInfo[] } | undefined
  if (environmentId !== activeEnvironmentId) {
    try {
      const vars = environmentId ? await api().listEnvironmentVariables(environmentId) : []
      envLayer = {
        name: ctx.environment?.name ?? null,
        vars: vars.map((v) => ({ key: v.key, value: v.isSecret ? null : (v.value ?? ''), secret: v.isSecret, id: v.id })),
      }
    } catch (e) {
      return { ok: false, kind: 'failed', error: `Could not read the environment "${ctx.environment?.name ?? ''}": ${errorInfo(e).message}`, scripts }
    }
  }
  const scope = scopeWithScriptVariables(scopeStore.scopeFor(ctx.collectionId, envLayer), {
    collection: ctx.collectionId ? undefined : run.collectionVariables,
    data: run.iterationData,
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

  if (draft.mcp) return sendMcp(draft, ctx, { runId, scriptSessionId: run.sessionId, scope, secrets, scripts, cancelled, runScripts })

  const prepared = prepareRequest(draft, { workspaceId: ctx.workspaceId, requestId: ctx.requestId, scope, secrets })
  if (!prepared.ok) {
    return prepared.unresolved.length > 0
      ? { ok: false, kind: 'unresolved', error: prepared.error, unresolved: prepared.unresolved, scripts }
      : { ok: false, kind: 'invalid', error: prepared.error, scripts }
  }

  // OAuth 2.0: main keeps the token; find it for these settings, refreshing it first when it is about to expire.
  if (prepared.oauth2 && prepared.input.auth.oauth2) {
    const token = await oauth2TokenKey(prepared.oauth2)
    if (!token.ok) return { ...token.failure, scripts }
    prepared.input.auth.oauth2.tokenKey = token.tokenKey
    if (ctx.wasCancelled?.()) return cancelled()
  }

  // 3. The request.
  const started = performance.now()
  let response: HttpResponseData
  try {
    response = await api().executeHttpRequest({
      ...prepared.input,
      requestRunId: runId,
      scriptSessionId: run.sessionId,
      ...(ctx.source ? { historySource: ctx.source } : {}),
    })
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

type Failure = { ok: false; kind: 'invalid' | 'failed'; error: string; code?: string }

/** Why there is no usable OAuth 2.0 token, and where to get one (`where`: the Authorization tab, or an MCP request's Connection section). */
export function oauth2TokenMessage(problem: 'missing' | 'expired', where = 'the Authorization tab'): string {
  return `${problem === 'missing' ? 'No access token yet' : 'The access token has expired'}: click Get New Access Token in ${where}.`
}

/** The stored token's key for these OAuth 2.0 settings, refreshed first when it is about to expire. */
async function oauth2TokenKey(
  config: OAuth2Config,
  where?: string,
): Promise<{ ok: true; tokenKey: string } | { ok: false; failure: Failure }> {
  try {
    const status = await api().refreshOAuth2Token(config, { ifExpiring: true })
    if (!status.hasToken) return { ok: false, failure: { ok: false, kind: 'invalid', error: oauth2TokenMessage('missing', where) } }
    if (status.expired) return { ok: false, failure: { ok: false, kind: 'invalid', error: oauth2TokenMessage('expired', where) } }
    return { ok: true, tokenKey: status.tokenKey }
  } catch (e) {
    const info = errorInfo(e)
    return { ok: false, failure: { ok: false, kind: 'failed', error: info.message, code: info.code } }
  }
}

interface McpSendState {
  runId: string
  /** The run's script session (History hides the secret values its scripts read). */
  scriptSessionId: string
  scope: TemplateScope
  secrets: ReadonlyMap<string, string>
  scripts: ScriptOutput
  cancelled: () => ExecuteOutcome
  runScripts: (event: ScriptEventName, draft: RequestDraft, extra?: Partial<RunScriptsInput>) => Promise<unknown>
}

/** Steps 2-4 of an MCP request: resolve, connect (or reuse the session), run the operation, then the test scripts. */
async function sendMcp(draft: RequestDraft, ctx: ExecuteContext, s: McpSendState): Promise<ExecuteOutcome> {
  const { runId, scripts, cancelled } = s
  const prepared = prepareMcp(draft, { workspaceId: ctx.workspaceId, requestId: ctx.requestId, scope: s.scope, secrets: s.secrets })
  if (!prepared.ok) {
    return prepared.unresolved.length > 0
      ? { ok: false, kind: 'unresolved', error: prepared.error, unresolved: prepared.unresolved, scripts }
      : { ok: false, kind: 'invalid', error: prepared.error, scripts }
  }

  // OAuth 2.0: the MCP transport sends the token itself, so it is revealed for this connect only (like a secret variable).
  let connect = prepared.connect
  if (prepared.oauth2) {
    const token = await oauth2TokenKey(prepared.oauth2.config, MCP_TOKEN_WHERE)
    if (!token.ok) return { ...token.failure, scripts }
    try {
      connect = withMcpOAuth2Token(connect, prepared.oauth2, await api().revealOAuth2Token(token.tokenKey))
    } catch (e) {
      const info = errorInfo(e)
      return { ok: false, kind: 'failed', error: info.message, code: info.code, scripts }
    }
    if (ctx.wasCancelled?.()) return cancelled()
  }

  // 3. Connect (or reuse the open session), then the operation.
  const origin = ctx.mcpOrigin ?? (ctx.source === 'mcp' ? 'mcp' : ctx.run ? 'runner' : 'user')
  const connectInput: McpConnectInput = { ...connect, workspaceId: ctx.workspaceId, origin }
  const started = performance.now()
  let conn: McpConnection | null = null
  let outcome: McpCallOutcome | null = null
  try {
    for (let attempt = 0; attempt < 2 && !outcome; attempt++) {
      try {
        conn = await mcpConnections.getSession(ctx.mcpSessionKey ?? null, connectInput)
      } catch (e) {
        const info = errorInfo(e)
        if (info.details?.reason === 'untrusted_command') {
          return { ok: false, kind: 'failed', error: UNTRUSTED_COMMAND_MESSAGE, code: info.code, untrustedCommand: untrustedCommandOf(info.details), scripts }
        }
        if (ctx.wasCancelled?.()) return cancelled()
        return { ok: false, kind: 'failed', error: `Could not connect to the MCP server: ${info.message}`, code: info.code, scripts }
      }
      if (ctx.wasCancelled?.()) return cancelled()
      try {
        outcome = await api().mcpClientCall({
          ...prepared.call,
          sessionId: conn.sessionId,
          requestRunId: runId,
          workspaceId: ctx.workspaceId,
          requestId: ctx.requestId ?? null,
          requestName: draft.name,
          scriptSessionId: s.scriptSessionId,
          ...(ctx.source ? { historySource: ctx.source } : {}),
        })
      } catch (e) {
        const info = errorInfo(e)
        // The session closed under us (server gone, idle close in main): reconnect once.
        if (info.code === 'not_found' && attempt === 0) {
          mcpConnections.release(conn.key)
          mcpConnections.forget(conn.key)
          conn = null
          continue
        }
        if (ctx.wasCancelled?.()) return cancelled()
        return { ok: false, kind: 'failed', error: info.message, code: info.code, scripts }
      }
    }
  } finally {
    if (conn) mcpConnections.release(conn.key)
  }
  if (!outcome) return { ok: false, kind: 'failed', error: 'The MCP session closed.', scripts }
  if (ctx.wasCancelled?.()) return cancelled()
  if (!outcome.ok && !outcome.isError) {
    const error = outcome.error ?? { code: null, message: 'The MCP call failed.' }
    return { ok: false, kind: 'failed', error: error.message || 'The MCP call failed.', mcpError: error, scripts }
  }
  const elapsedMs = Math.round(performance.now() - started)
  const response = mcpResponse(outcome, prepared.call.operation, prepared.target)

  // 4. Test scripts: the request as shown in History (secrets as {{name}}), the result as a JSON response.
  if (!ctx.wasCancelled?.()) {
    try {
      await s.runScripts('test', draft, {
        request: { ...requestDataFromDraft(draft), url: prepared.historyUrl },
        response: responseDataFrom(response),
      })
    } catch (e) {
      scripts.errors.push({ source: 'Tests', kind: 'internal', message: `Could not run the test scripts: ${errorInfo(e).message}` })
    }
  }
  return { ok: true, response, warnings: prepared.warnings, runId, elapsedMs, scripts }
}

/**
 * The synthetic response of an MCP call: 200 OK, or 500 "Tool error" for a tool result with isError; the result as JSON.
 * `name`: the tool or prompt name, or the resource URI as shown to the user (secrets as `{{name}}`).
 */
export function mcpResponse(outcome: McpCallOutcome, operation: McpPreparedCall['operation'], name: string | null): HttpResponseData {
  const bodyText = JSON.stringify(outcome.result, null, 2)
  return {
    status: outcome.isError ? 500 : 200,
    statusText: outcome.isError ? 'Tool error' : 'OK',
    durationMs: outcome.durationMs,
    headers: [{ key: 'Content-Type', value: 'application/json' }],
    bodyText,
    bodyBase64: null,
    bodyByteLength: new TextEncoder().encode(bodyText).length,
    mcp: { ...outcome, operation, name },
  }
}

/** `pm.request.auth` for test scripts: the same read-only view as in pre-request scripts. */
function withAuthView(data: ScriptRequestData, draft: RequestDraft): ScriptRequestData {
  const auth = scriptAuthView(draft.auth)
  return auth ? { ...data, auth } : data
}

export async function cancelRun(runId: string): Promise<void> {
  // The same run id cancels the scripts and an HTTP request, or an MCP call.
  await Promise.all([
    api()
      .cancelHttpRequest(runId)
      .catch(() => {
        /* the run may already have finished */
      }),
    api()
      .mcpClientCancel(runId)
      .catch(() => {
        /* likewise */
      }),
  ])
}
