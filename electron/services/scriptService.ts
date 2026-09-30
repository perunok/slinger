/**
 * Main-process side of `runScripts`: loads the active environment, the request's collection variables and the
 * workspace's globals, decides read-only, hands the chain to the sandbox executor, persists writes to those three
 * scopes through their repositories and remembers which secret values a session's scripts read so HttpService can
 * keep them out of history.
 *
 * Nothing a script prints or computes is logged here: console output travels only in the IPC result.
 */
import type { RunScriptsInput, RunScriptsResult, ScriptErrorInfo } from '../../shared/types'
import type { Db } from '../db/database'
import { invalidInput, toErrorPayload } from '../lib/errors'
import { requireCollection, requireEnvironment, requireWorkspace } from '../repositories/common'
import type { EnvironmentRepository } from '../repositories/environments'
import type { CollectionVariableRepository, GlobalVariableRepository } from '../repositories/variables'
import { DEFAULT_LIMITS, MAX_SCRIPT_WALL_CLOCK_MS, MAX_SEND_REQUEST_TIMEOUT_MS, type EnvOp, type EnvSnapshot, type PersistedScopeSnapshot, type ScriptJob } from '../scripts/job'
import type { ScriptExecutor } from '../scripts/executor'
import type { FileAccess } from './fileGrants'
import { DEFAULT_TIMEOUT_MS } from './httpExecutor'
import { runScriptSendRequest } from './scriptHttp'

const RUN_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/
const SESSION_TTL_MS = 60 * 60 * 1000
const MAX_SESSIONS = 500

interface Session {
  /** secret value -> variable name, for `{{name}}` redaction. */
  values: Map<string, string>
  touched: number
}

/** Keeps only the last write per key, in the order of those last writes; a `clear` drops everything before it. */
export function coalesceEnvOps(ops: EnvOp[]): EnvOp[] {
  const last = new Map<string, EnvOp>()
  let cleared = false
  for (const op of ops) {
    if (op.op === 'clear') {
      last.clear()
      cleared = true
      continue
    }
    last.delete(op.key)
    last.set(op.key, op)
  }
  return [...(cleared ? [{ op: 'clear' } as const] : []), ...last.values()]
}

/** Where a persisted scope's script writes go. */
interface OpTarget {
  source: string
  set(key: string, value: string): { secret: boolean }
  unset(key: string): void
  clear(): void
}

/** Collection variables + globals, when the core provides them (older tests construct the service without). */
export interface ScriptVariableStores {
  collectionVariables: CollectionVariableRepository
  globals: GlobalVariableRepository
}

export class ScriptService {
  private readonly runs = new Map<string, AbortController>()
  private readonly sessions = new Map<string, Session>()

  constructor(
    private readonly db: Db,
    private readonly environments: EnvironmentRepository,
    private readonly executor: ScriptExecutor,
    private readonly now: () => number = Date.now,
    /** File grants for pm.sendRequest form-data / file bodies (none: such bodies are refused). */
    private readonly files?: FileAccess,
    /** Persisted collection variables and globals (absent: both are in-memory scopes, as before 0008). */
    private readonly stores?: ScriptVariableStores,
  ) {}

  private isReadOnly(workspaceId: string): boolean {
    const row = this.db.prepare('SELECT read_only FROM cloud_links WHERE workspace_id = ?').get(workspaceId) as { read_only: number } | undefined
    return row?.read_only === 1
  }

  private session(id: string): Session {
    const now = this.now()
    let s = this.sessions.get(id)
    if (!s) {
      for (const [k, v] of this.sessions) if (now - v.touched > SESSION_TTL_MS) this.sessions.delete(k)
      while (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!)
      s = { values: new Map(), touched: now }
      this.sessions.set(id, s)
    }
    s.touched = now
    return s
  }

  private remember(sessionId: string, key: string, value: string): void {
    if (value) this.session(sessionId).values.set(value, key)
  }

  /** Replaces secret values that scripts of `sessionId` read or wrote with `{{name}}`. */
  redact(sessionId: string | null | undefined, text: string): string {
    if (!sessionId) return text
    const s = this.sessions.get(sessionId)
    if (!s || s.values.size === 0) return text
    let out = text
    // Longest first, so a secret that contains another one is replaced whole.
    for (const [value, key] of [...s.values].sort((a, b) => b[0].length - a[0].length)) {
      if (out.includes(value)) out = out.split(value).join(`{{${key}}}`)
      const encoded = encodeURIComponent(value)
      if (encoded !== value && out.includes(encoded)) out = out.split(encoded).join(`{{${key}}}`)
    }
    return out
  }

  cancel(runId: string): void {
    this.runs.get(runId)?.abort()
  }

  async run(input: RunScriptsInput): Promise<RunScriptsResult> {
    const workspace = requireWorkspace(this.db, input.workspaceId)
    if (!RUN_ID_RE.test(input.runId)) throw invalidInput('runId must be 1-128 characters of [A-Za-z0-9._:-]')
    if (!RUN_ID_RE.test(input.sessionId)) throw invalidInput('sessionId must be 1-128 characters of [A-Za-z0-9._:-]')
    if (this.runs.has(input.runId)) throw invalidInput('scripts with this runId are already running')

    let environment: EnvSnapshot | null = null
    // variable id -> where to reveal it, for this environment's and this workspace's secrets only
    const secretIds = new Map<string, { key: string; reveal: (id: string) => string }>()
    if (input.environmentId) {
      const env = requireEnvironment(this.db, input.environmentId)
      if (env.workspace_id !== workspace.id) throw invalidInput('environment belongs to a different workspace')
      const vars = this.environments.listVariables(env.id)
      environment = {
        name: env.name,
        variables: vars.map((v) => ({ id: v.id, key: v.key, value: v.isSecret ? null : v.value, secret: v.isSecret })),
      }
      for (const v of vars) if (v.isSecret) secretIds.set(v.id, { key: v.key, reveal: (id) => this.environments.reveal(id) })
    }
    // Persisted collection variables (of the request's collection) and globals (of the workspace).
    let persistedCollection: PersistedScopeSnapshot | null | undefined
    let persistedGlobals: PersistedScopeSnapshot | undefined
    const stores = this.stores
    if (stores) {
      if (input.collectionId) {
        const collection = requireCollection(this.db, input.collectionId)
        if (collection.workspace_id !== workspace.id) throw invalidInput('collection belongs to a different workspace')
        persistedCollection = { variables: stores.collectionVariables.forScripts(collection.id) }
      } else if (input.collectionId === null) persistedCollection = null
      persistedGlobals = { variables: stores.globals.forScripts(workspace.id) }
      for (const v of persistedGlobals.variables) if (v.secret) secretIds.set(v.id, { key: v.key, reveal: (id) => stores.globals.reveal(id) })
    }
    const readOnly = this.isReadOnly(workspace.id)
    const timeoutMs = Math.min(Math.max(Math.round(input.timeoutMs ?? DEFAULT_LIMITS.timeoutMs), 100), 60_000)
    // pm.sendRequest: per-call timeout = the request's own timeout (else the HTTP default), capped; the script's
    // wall clock allows for its requests on top of its CPU budget, bounded.
    const sendRequestTimeoutMs = Math.min(Math.max(Math.round(input.sendRequestTimeoutMs ?? DEFAULT_TIMEOUT_MS), 1000), MAX_SEND_REQUEST_TIMEOUT_MS)
    const wallClockMs = Math.min(timeoutMs + DEFAULT_LIMITS.maxSendRequests * sendRequestTimeoutMs, MAX_SCRIPT_WALL_CLOCK_MS)
    const job: ScriptJob = {
      event: input.event,
      scripts: input.scripts,
      request: input.request,
      response: input.response ?? null,
      variables: input.variables,
      collectionVariables: input.collectionVariables ?? {},
      globals: input.globals ?? {},
      info: input.info,
      iterationData: input.iterationData ?? {},
      environment,
      persistedCollection,
      persistedGlobals,
      readOnly,
      continueOnError: input.continueOnError === true,
      limits: { ...DEFAULT_LIMITS, timeoutMs, sendRequestTimeoutMs, wallClockMs },
    }

    const controller = new AbortController()
    this.runs.set(input.runId, controller)
    let result
    try {
      result = await this.executor.run(job, {
        signal: controller.signal,
        // pm.sendRequest: the app's HTTP engine, never recorded in history; cancelling the run aborts it.
        sendHttp: (call, signal) =>
          runScriptSendRequest(call, AbortSignal.any([signal, controller.signal]), {
            files: this.files,
            redact: (text) => this.redact(input.sessionId, text),
          }),
        readSecret: (variableId) => {
          // Only secrets of the environment / globals this run was given; anything else is refused.
          const target = secretIds.get(variableId)
          if (!target) return null
          try {
            const value = target.reveal(variableId)
            this.remember(input.sessionId, target.key, value)
            return value
          } catch {
            return null
          }
        },
      })
    } finally {
      this.runs.delete(input.runId)
    }

    const errors: ScriptErrorInfo[] = [...result.errors]
    const nowReadOnly = readOnly || this.isReadOnly(workspace.id)
    const apply = (ops: EnvOp[], target: OpTarget): boolean => {
      const list = coalesceEnvOps(ops)
      if (list.length === 0) return false
      if (nowReadOnly) {
        errors.push({ source: target.source, kind: 'error', message: `This workspace is read-only; ${target.source.toLowerCase()} changes from scripts were not saved.` })
        return false
      }
      let changed = false
      for (const op of list) {
        try {
          if (op.op === 'set') {
            const { secret } = target.set(op.key, op.value)
            if (secret) this.remember(input.sessionId, op.key, op.value)
          } else if (op.op === 'unset') target.unset(op.key)
          else target.clear()
          changed = true
        } catch (err) {
          const what = op.op === 'clear' ? 'the cleared variables' : `"${op.key}"`
          errors.push({ source: target.source, kind: 'error', message: `Could not save ${what}: ${toErrorPayload(err).message}` })
        }
      }
      return changed
    }
    const envId = input.environmentId
    const environmentChanged = envId
      ? apply(result.envOps, {
          source: 'Environment',
          set: (k, v) => this.environments.setValueFromScript(envId, k, v),
          unset: (k) => this.environments.unsetFromScript(envId, k),
          clear: () => {},
        })
      : false
    const collectionId = persistedCollection ? input.collectionId! : null
    const collectionVariablesChanged =
      stores && collectionId
        ? apply(result.collectionOps ?? [], {
            source: 'Collection variables',
            set: (k, v) => stores.collectionVariables.setValueFromScript(collectionId, k, v),
            unset: (k) => stores.collectionVariables.unsetFromScript(collectionId, k),
            clear: () => stores.collectionVariables.clearFromScript(collectionId),
          })
        : false
    const globalsChanged = stores
      ? apply(result.globalOps ?? [], {
          source: 'Globals',
          set: (k, v) => stores.globals.setValueFromScript(workspace.id, k, v),
          unset: (k) => stores.globals.unsetFromScript(workspace.id, k),
          clear: () => stores.globals.clearFromScript(workspace.id),
        })
      : false

    return {
      event: input.event,
      errors,
      request: result.request,
      variables: result.variables,
      collectionVariables: result.collectionVariables,
      globals: result.globals,
      environmentChanged,
      collectionVariablesChanged,
      globalsChanged,
      console: result.console,
      tests: result.tests,
      ...(result.nextRequest !== undefined ? { nextRequest: result.nextRequest } : {}),
      durationMs: result.durationMs,
    }
  }

  async dispose(): Promise<void> {
    for (const c of this.runs.values()) c.abort()
    await this.executor.dispose()
  }
}
