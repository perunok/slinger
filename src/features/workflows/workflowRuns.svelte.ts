/**
 * Workflow runs, independent of the open tab (closing it does not stop a run; reopening shows it). One run per workflow.
 * The engine (lib/workflow/engine.ts) gets the app's real abilities here:
 *
 * - Send request: `executeDraft`, exactly like a manual send (scripts, variables, secrets, OAuth 2.0, history). The
 *   input's fields resolve as `{{name}}` (they are the run's iteration data, like a data file row).
 * - Evaluate / If / For each / Set variable: the code runs in the main-process QuickJS sandbox through `runScripts`
 *   (same limits and libraries as request scripts; `pm.variables` is shared by the whole run).
 *
 * A run keeps the environment it started with, and needs its workspace: switching workspaces stops it.
 */
import type { RunScriptsResult, ScriptConsoleEntry } from '../../../shared/types'
import { WORKFLOW_INPUT_KEY as INPUT_KEY, WORKFLOW_OUTPUT_KEY as OUTPUT_KEY, workflowScript } from '../../../shared/workflowScript'
import { settings } from '../../app/settings.svelte'
import { app } from '../../app/state.svelte'
import { api, errorInfo } from '../../lib/ipc'
import { parseDocument } from '../../lib/request'
import { uuid } from '../../lib/template'
import { WorkflowRun, type EngineDeps, type Result, type RunEvent, type RunPhase, type RunSummary } from '../../lib/workflow/engine'
import { nodeTitle, type WorkflowGraph, type WorkflowNode } from '../../lib/workflow/graph'
import { inputVariables, preview, responseValue } from '../../lib/workflow/values'
import { cancelRun, executeDraft, newScriptRun, type ScriptRunContext } from '../requests/execute'

export type NodeStatus = 'idle' | 'running' | 'done' | 'error'

export interface NodeRunState {
  status: NodeStatus
  /** How many times it ran in this run. */
  runs: number
  input?: unknown
  output?: unknown
  /** Ports the last run sent to. */
  ports: string[]
  error?: string
  /** For each: the item being processed. */
  progress?: { index: number; count: number }
  durationMs?: number
}

export interface LogEntry {
  seq: number
  nodeId: string | null
  kind: 'start' | 'end' | 'error' | 'output' | 'console' | 'info'
  text: string
  value?: unknown
}

const LOG_CAP = 2000

export class WorkflowRunSession {
  readonly id = uuid()
  readonly startedAt = Date.now()
  phase = $state<RunPhase>('running')
  nodes = $state.raw<Record<string, NodeRunState>>({})
  log = $state.raw<LogEntry[]>([])
  summary = $state.raw<RunSummary | null>(null)
  finishedAt = $state<number | null>(null)
  #seq = 0
  run!: WorkflowRun

  constructor(
    readonly workflowId: string,
    readonly workspaceId: string,
    readonly graph: WorkflowGraph,
    readonly environment: { id: string; name: string } | null,
  ) {}

  get running(): boolean {
    return this.phase === 'running'
  }

  node(id: string): NodeRunState {
    return this.nodes[id] ?? { status: 'idle', runs: 0, ports: [] }
  }

  addLog(entry: Omit<LogEntry, 'seq'>) {
    const next = [...this.log, { ...entry, seq: ++this.#seq }]
    this.log = next.length > LOG_CAP ? next.slice(next.length - LOG_CAP) : next
  }

  #patch(id: string, patch: Partial<NodeRunState>) {
    this.nodes = { ...this.nodes, [id]: { ...this.node(id), ...patch } }
  }

  onEvent(e: RunEvent) {
    const node = this.graph.nodes.find((n) => n.id === e.nodeId)
    const title = node ? nodeTitle(node) : ''
    switch (e.type) {
      case 'node-start':
        this.#patch(e.nodeId, { status: 'running', runs: this.node(e.nodeId).runs + 1, input: e.input, error: undefined, progress: undefined })
        break
      case 'node-progress':
        this.#patch(e.nodeId, { progress: { index: e.index, count: e.count } })
        this.addLog({ nodeId: e.nodeId, kind: 'info', text: `${title}: item ${e.index + 1} of ${e.count}` })
        break
      case 'node-end':
        this.#patch(e.nodeId, { status: 'done', output: e.output, ports: e.ports, durationMs: e.durationMs, progress: undefined })
        // An Output node already logged its value (the `output` event).
        if (node?.type !== 'output') this.addLog({ nodeId: e.nodeId, kind: 'end', text: `${title}${e.ports.length ? ` → ${e.ports.join(', ')}` : ''}: ${preview(e.output, 160)}`, value: e.output })
        break
      case 'node-error':
        this.#patch(e.nodeId, { status: 'error', error: e.error, ports: e.handled ? ['error'] : [], durationMs: e.durationMs })
        this.addLog({ nodeId: e.nodeId, kind: 'error', text: `${title}: ${e.error}${e.handled ? ' (sent to its error output)' : ''}` })
        break
      case 'output':
        this.addLog({ nodeId: e.nodeId, kind: 'output', text: `${e.label}: ${preview(e.value, 160)}`, value: e.value })
        break
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    function done() {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}

/** The engine's abilities for one run (exported for tests). */
export function workflowDeps(session: WorkflowRunSession, scriptRun: ScriptRunContext): EngineDeps {
  const { workspaceId, environment } = session
  const logConsole = (node: WorkflowNode, entries: ScriptConsoleEntry[]) => {
    for (const c of entries) session.addLog({ nodeId: node.id, kind: 'console', text: `${nodeTitle(node)} · ${c.level}: ${c.message}` })
  }
  const cancellable = (signal: AbortSignal) => {
    let runId: string | null = null
    const abort = () => runId && void cancelRun(runId)
    signal.addEventListener('abort', abort, { once: true })
    return {
      onRunId: (id: string) => {
        runId = id
        if (signal.aborted) abort()
      },
      done: () => signal.removeEventListener('abort', abort),
    }
  }

  return {
    async sendRequest(node, input, signal): Promise<Result<unknown>> {
      const request = app.requestById(node.config.requestId)
      if (!request) return { ok: false, error: node.config.requestId ? 'its request was deleted' : 'no request chosen' }
      const c = cancellable(signal)
      scriptRun.iterationData = inputVariables(input)
      try {
        const outcome = await executeDraft(parseDocument(request), {
          workspaceId,
          requestId: request.id,
          collectionId: request.collectionId,
          folderId: request.folderId,
          run: scriptRun,
          environment,
          onRunId: c.onRunId,
          wasCancelled: () => signal.aborted,
          // An MCP request node connects as the workflow (main never trusts a stdio command for it either).
          mcpOrigin: 'workflow',
        })
        logConsole(node, outcome.scripts.console)
        app.historyTick++
        if (!outcome.ok) return { ok: false, error: outcome.error }
        return { ok: true, value: responseValue(outcome.response, outcome.scripts.tests) }
      } finally {
        scriptRun.iterationData = null
        c.done()
      }
    },

    async evaluate(node, code, input, signal): Promise<Result<unknown>> {
      const c = cancellable(signal)
      const runId = uuid()
      c.onRunId(runId)
      let result: RunScriptsResult
      try {
        result = await api().runScripts({
          runId,
          sessionId: scriptRun.sessionId,
          workspaceId,
          environmentId: environment?.id ?? null,
          event: 'prerequest',
          scripts: [{ origin: 'request', name: nodeTitle(node), code: workflowScript(code) }],
          request: { method: 'GET', url: 'http://workflow.invalid/', headers: [], body: { mode: 'none' } },
          response: null,
          variables: scriptRun.variables,
          collectionId: null,
          collectionVariables: scriptRun.collectionVariables,
          info: { requestName: nodeTitle(node), requestId: null, iteration: 0, iterationCount: 1 },
          iterationData: input === undefined ? {} : { [INPUT_KEY]: input },
          timeoutMs: settings.scriptTimeoutMs,
        })
      } catch (e) {
        return { ok: false, error: errorInfo(e).message }
      } finally {
        c.done()
      }
      logConsole(node, result.console)
      const { [OUTPUT_KEY]: output, ...variables } = result.variables
      scriptRun.variables = variables
      scriptRun.collectionVariables = result.collectionVariables
      await Promise.all([result.environmentChanged ? app.refreshEnvVariables() : null, result.globalsChanged ? app.reloadGlobals() : null])
      const failure = result.errors[0]
      if (failure) return { ok: false, error: failure.kind === 'timeout' ? `took longer than ${settings.scriptTimeoutMs} ms` : failure.message }
      return { ok: true, value: output }
    },

    sleep,
    onEvent: (e) => session.onEvent(e),
  }
}

class WorkflowRunsStore {
  /** By workflow id: the current or last run. */
  sessions = $state.raw<Record<string, WorkflowRunSession>>({})

  forWorkflow(id: string | null | undefined): WorkflowRunSession | null {
    return id ? (this.sessions[id] ?? null) : null
  }

  /** Starts a run of `graph` (a running one for the same workflow is returned as is). */
  start(workflowId: string, graph: WorkflowGraph): WorkflowRunSession {
    const existing = this.sessions[workflowId]
    if (existing?.running) return existing
    const workspaceId = app.workspaceId!
    const active = app.activeEnvironment
    const environment = active && active.workspaceId === workspaceId ? { id: active.id, name: active.name } : null
    const session = new WorkflowRunSession(workflowId, workspaceId, structuredClone($state.snapshot(graph)) as WorkflowGraph, environment)
    session.run = new WorkflowRun(session.graph, workflowDeps(session, newScriptRun()))
    session.addLog({ nodeId: null, kind: 'info', text: `Run started${environment ? ` with environment “${environment.name}”` : ' without an environment'}` })
    this.sessions = { ...this.sessions, [workflowId]: session }
    void session.run.run().then((summary) => {
      session.summary = summary
      session.phase = summary.phase
      session.finishedAt = Date.now()
      const seconds = ((session.finishedAt - session.startedAt) / 1000).toFixed(1)
      const text =
        summary.phase === 'done'
          ? `Finished: ${summary.steps} steps in ${seconds} s`
          : summary.phase === 'stopped'
            ? `Stopped after ${summary.steps} steps`
            : `Failed: ${summary.error?.message ?? 'unknown error'}`
      session.addLog({ nodeId: summary.error?.nodeId ?? null, kind: summary.phase === 'failed' ? 'error' : 'info', text })
    })
    return session
  }

  stop(workflowId: string) {
    this.sessions[workflowId]?.run.stop()
  }

  /** Forgets a finished run (Clear in the run panel); a running one is kept. */
  clear(workflowId: string) {
    if (this.sessions[workflowId]?.running) return
    const { [workflowId]: _gone, ...rest } = this.sessions
    this.sessions = rest
  }

  /** Runs of other workspaces stop: they need their workspace's requests and scripts. */
  workspaceWillChange(workspaceId: string) {
    for (const s of Object.values(this.sessions)) if (s.workspaceId !== workspaceId) s.run.stop()
    this.sessions = Object.fromEntries(Object.entries(this.sessions).filter(([, s]) => s.workspaceId === workspaceId))
  }

  runningCount(workspaceId: string | null): number {
    return Object.values(this.sessions).filter((s) => s.running && s.workspaceId === workspaceId).length
  }
}

export const workflowRuns = new WorkflowRunsStore()
app.workspaceWillChange.push((id) => workflowRuns.workspaceWillChange(id))
