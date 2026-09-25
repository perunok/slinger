/**
 * Main-process side of `runScripts`: loads the active environment, decides read-only, hands the chain to the
 * sandbox executor, persists environment writes through EnvironmentRepository and remembers which secret
 * values a session's scripts read so HttpService can keep them out of history.
 *
 * Nothing a script prints or computes is logged here: console output travels only in the IPC result.
 */
import type { RunScriptsInput, RunScriptsResult, ScriptErrorInfo } from '../../shared/types'
import type { Db } from '../db/database'
import { invalidInput, toErrorPayload } from '../lib/errors'
import { requireEnvironment, requireWorkspace } from '../repositories/common'
import type { EnvironmentRepository } from '../repositories/environments'
import { DEFAULT_LIMITS, MAX_SCRIPT_WALL_CLOCK_MS, MAX_SEND_REQUEST_TIMEOUT_MS, type EnvOp, type EnvSnapshot, type ScriptJob } from '../scripts/job'
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

/** Keeps only the last write per key, in the order of those last writes. */
export function coalesceEnvOps(ops: EnvOp[]): EnvOp[] {
  const last = new Map<string, EnvOp>()
  for (const op of ops) {
    last.delete(op.key)
    last.set(op.key, op)
  }
  return [...last.values()]
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
    const secretIds = new Map<string, string>() // variable id -> key, for this environment only
    if (input.environmentId) {
      const env = requireEnvironment(this.db, input.environmentId)
      if (env.workspace_id !== workspace.id) throw invalidInput('environment belongs to a different workspace')
      const vars = this.environments.listVariables(env.id)
      environment = {
        name: env.name,
        variables: vars.map((v) => ({ id: v.id, key: v.key, value: v.isSecret ? null : v.value, secret: v.isSecret })),
      }
      for (const v of vars) if (v.isSecret) secretIds.set(v.id, v.key)
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
      collectionVariables: input.collectionVariables,
      globals: input.globals,
      info: input.info,
      environment,
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
          // Only secrets of the environment this run was given; anything else is refused.
          const key = secretIds.get(variableId)
          if (!key || !input.environmentId) return null
          try {
            const value = this.environments.reveal(variableId)
            this.remember(input.sessionId, key, value)
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
    let environmentChanged = false
    const ops = coalesceEnvOps(result.envOps)
    if (ops.length > 0 && input.environmentId) {
      if (readOnly || this.isReadOnly(workspace.id)) {
        errors.push({ source: 'Environment', kind: 'error', message: 'This workspace is read-only; environment changes from scripts were not saved.' })
      } else {
        for (const op of ops) {
          try {
            if (op.op === 'set') {
              const { secret } = this.environments.setValueFromScript(input.environmentId, op.key, op.value)
              if (secret) this.remember(input.sessionId, op.key, op.value)
            } else this.environments.unsetFromScript(input.environmentId, op.key)
            environmentChanged = true
          } catch (err) {
            errors.push({ source: 'Environment', kind: 'error', message: `Could not save "${op.key}": ${toErrorPayload(err).message}` })
          }
        }
      }
    }

    return {
      event: input.event,
      errors,
      request: result.request,
      variables: result.variables,
      collectionVariables: result.collectionVariables,
      globals: result.globals,
      environmentChanged,
      console: result.console,
      tests: result.tests,
      durationMs: result.durationMs,
    }
  }

  async dispose(): Promise<void> {
    for (const c of this.runs.values()) c.abort()
    await this.executor.dispose()
  }
}
