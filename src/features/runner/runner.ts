/**
 * Collection runner logic: runs items sequentially through an injectable executor.
 * No Svelte and no IPC in here; the dialog wires in `executeDraft` / `cancelRun`.
 */
import type { ApiFolder, ApiRequest, RequestHeader, ScriptConsoleEntry, ScriptErrorInfo, ScriptTestResult } from '../../../shared/types'
import { errorInfo } from '../../lib/ipc'
import { testCounts } from '../../lib/scripts'
import { buildTree, type TreeNode } from '../../lib/tree'
import type { ExecuteOutcome } from '../requests/execute'

export interface RunItem {
  id: string
  name: string
  method: string
  url: string
  request: ApiRequest
}

export type RowStatus = 'pending' | 'running' | 'passed' | 'failed' | 'cancelled' | 'skipped'

export interface RunRow {
  /** Unique within a run: pm.execution.setNextRequest and iterations run the same item more than once. */
  key: string
  /** 0-based iteration the row belongs to (always 0 without iterations). */
  iteration: number
  item: RunItem
  status: RowStatus
  statusCode: number | null
  statusText: string
  durationMs: number | null
  /** Why the row failed / was skipped (error text, unresolved variables, HTTP status). */
  reason: string | null
  headers: RequestHeader[]
  bodyPreview: string | null
  bodyTruncated: boolean
  /** pm.test results of this request's test scripts. */
  tests: ScriptTestResult[]
  scriptErrors: ScriptErrorInfo[]
  console: ScriptConsoleEntry[]
  /** Headers and body preview were not kept (a passed request of a large run, see DETAIL_ROWS). */
  detailsDropped?: boolean
}

export interface RunOptions {
  delayMs: number
  stopOnFailure: boolean
  /** Count a final 3xx response as a pass (default false: see `classifyStatus`). */
  treat3xxAsPass?: boolean
  /** How many times the whole selection runs (default 1). */
  iterations?: number
  /** Data-driven run: row i is iteration i's data scope (`{{column}}`, pm.iterationData). */
  data?: ReadonlyArray<Record<string, unknown>> | null
}

/**
 * What "pass" means for a run row. The HTTP executor follows redirects itself, so a 3xx that
 * reaches the runner is a redirect that did NOT end in a 2xx (no Location, 304/300, ...):
 *   2xx           passes
 *   3xx           fails, unless `treat3xxAsPass` is set
 *   1xx, 4xx, 5xx fail
 * Network errors, timeouts and unresolved variables never reach this function; they fail too.
 */
export function classifyStatus(status: number, opts: { treat3xxAsPass?: boolean } = {}): { passed: boolean; reason: string | null } {
  if (status >= 200 && status < 300) return { passed: true, reason: null }
  if (status >= 300 && status < 400 && opts.treat3xxAsPass) return { passed: true, reason: null }
  return { passed: false, reason: `HTTP ${status}` }
}

export type RunPhase = 'idle' | 'running' | 'done'

export interface RunState {
  phase: RunPhase
  /** Iteration by iteration, in run order. */
  rows: RunRow[]
  iterations: number
  /** 0-based iteration of the request running or last run. */
  currentIteration: number
  /** Number of rows that reached a final state. */
  completed: number
  startedAt: number | null
  finishedAt: number | null
  stopped: boolean
}

export interface ExecHooks {
  onRunId: (runId: string) => void
  wasCancelled: () => boolean
  /** 0-based iteration of this request, and that iteration's data row (null without a data file). */
  iteration: number
  data: Record<string, unknown> | null
}

export interface RunDeps {
  execute: (item: RunItem, hooks: ExecHooks) => Promise<ExecuteOutcome>
  cancel: (runId: string) => Promise<void>
  onUpdate?: (state: RunState) => void
  /** Called after every executed (not skipped) request, e.g. to refresh history. */
  onItemFinished?: (row: RunRow) => void
  now?: () => number
}

export const BODY_PREVIEW_CHARS = 2048
/** Most requests one run executes, so a setNextRequest loop without an exit cannot grow the results forever. */
export const MAX_RUN_REQUESTS = 10_000
/** Runs of more rows than this keep headers and body previews only for failed requests (memory stays bounded). */
export const DETAIL_ROWS = 1000
export const MAX_ITERATIONS = 10_000

/** Requests of a collection (or of one folder incl. nested folders) in tree order. */
export function collectRunItems(folders: ApiFolder[], requests: ApiRequest[], folderId: string | null): RunItem[] {
  const tree = buildTree(folders, requests)
  let nodes: TreeNode[] = tree
  if (folderId) {
    const find = (list: TreeNode[]): TreeNode | null => {
      for (const n of list) {
        if (n.kind !== 'folder') continue
        if (n.id === folderId) return n
        const inner = find(n.children)
        if (inner) return inner
      }
      return null
    }
    const node = find(tree)
    nodes = node && node.kind === 'folder' ? node.children : []
  }
  const out: RunItem[] = []
  const walk = (list: TreeNode[]) => {
    for (const n of list) {
      if (n.kind === 'request') out.push({ id: n.id, name: n.request.name, method: n.request.method, url: n.request.url, request: n.request })
      else walk(n.children)
    }
  }
  walk(nodes)
  return out
}

function blankRow(item: RunItem, key = '', iteration = 0): RunRow {
  return {
    key,
    iteration,
    item,
    status: 'pending',
    statusCode: null,
    statusText: '',
    durationMs: null,
    reason: null,
    headers: [],
    bodyPreview: null,
    bodyTruncated: false,
    tests: [],
    scriptErrors: [],
    console: [],
  }
}

export function summarize(state: Pick<RunState, 'rows' | 'startedAt' | 'finishedAt' | 'iterations'>) {
  let passed = 0
  let failed = 0
  let skipped = 0
  for (const r of state.rows) {
    if (r.status === 'passed') passed++
    else if (r.status === 'failed') failed++
    else if (r.status === 'skipped' || r.status === 'cancelled' || r.status === 'pending') skipped++
  }
  const totalMs = state.startedAt !== null && state.finishedAt !== null ? state.finishedAt - state.startedAt : 0
  let testsPassed = 0
  let testsFailed = 0
  let testsSkipped = 0
  for (const r of state.rows) {
    const c = testCounts({ tests: r.tests, errors: r.scriptErrors })
    testsPassed += c.passed
    testsFailed += c.failed
    testsSkipped += c.skipped
  }
  return {
    passed,
    failed,
    skipped,
    total: state.rows.length,
    iterations: state.iterations,
    totalMs,
    tests: { passed: testsPassed, failed: testsFailed, skipped: testsSkipped, total: testsPassed + testsFailed + testsSkipped },
  }
}

export class CollectionRun {
  #state: RunState
  #cancelled = false
  #runId: string | null = null
  #wake: (() => void) | null = null
  #finished: Promise<RunState> | null = null
  #nextKey = 0
  readonly #iterations: number
  readonly #items: RunItem[]
  readonly #deps: RunDeps
  readonly #options: RunOptions

  constructor(items: RunItem[], options: RunOptions, deps: RunDeps) {
    this.#deps = deps
    this.#options = options
    this.#items = items
    this.#iterations = Math.min(Math.max(1, Math.floor(options.iterations ?? 1)), MAX_ITERATIONS)
    const rows: RunRow[] = []
    for (let it = 0; it < this.#iterations; it++) for (const item of items) rows.push(this.#blank(item, it))
    this.#state = { phase: 'idle', rows, iterations: this.#iterations, currentIteration: 0, completed: 0, startedAt: null, finishedAt: null, stopped: false }
  }

  #blank(item: RunItem, iteration: number): RunRow {
    return blankRow(item, String(this.#nextKey++), iteration)
  }

  get state(): RunState {
    return this.#state
  }
  get running(): boolean {
    return this.#state.phase === 'running'
  }
  /** Resolves when the run ended (immediately-resolved for a run that never started). */
  get finished(): Promise<RunState> {
    return this.#finished ?? Promise.resolve(this.#state)
  }

  start(): Promise<RunState> {
    if (this.#finished) return this.#finished
    this.#finished = this.#run()
    return this.#finished
  }

  /** Cancels the in-flight request (if any) and prevents further requests from starting. */
  stop(): void {
    if (this.#state.phase === 'done' || this.#cancelled) return
    this.#cancelled = true
    if (this.#runId) void this.#deps.cancel(this.#runId)
    this.#wake?.()
  }

  #emit(patch: Partial<RunState> = {}) {
    this.#state = { ...this.#state, ...patch, rows: this.#state.rows.slice() }
    this.#deps.onUpdate?.(this.#state)
  }

  /** Replaces one row, keeping its key and iteration; the completed count follows incrementally (large runs). */
  #setRow(i: number, row: RunRow) {
    const rows = this.#state.rows.slice()
    const before = rows[i]
    rows[i] = { ...row, key: before.key, iteration: before.iteration }
    const completed = this.#state.completed + (isFinal(rows[i].status) ? 1 : 0) - (isFinal(before.status) ? 1 : 0)
    this.#state = { ...this.#state, rows, completed, currentIteration: before.iteration }
    this.#deps.onUpdate?.(this.#state)
  }

  #setRows(rows: RunRow[]) {
    this.#state = { ...this.#state, rows, completed: rows.filter((r) => isFinal(r.status)).length }
    this.#deps.onUpdate?.(this.#state)
  }

  /** Index after the last row of row `i`'s iteration. */
  #iterationEnd(i: number): number {
    const rows = this.#state.rows
    let end = i + 1
    while (end < rows.length && rows[end].iteration === rows[i].iteration) end++
    return end
  }

  /** Skips the pending rows of row `i`'s iteration from `from` on; the run goes on with the next iteration. */
  #endIteration(i: number, from: number, reason: string) {
    const rows = this.#state.rows
    const end = this.#iterationEnd(i)
    this.#setRows([...rows.slice(0, from), ...rows.slice(from, end).map((r) => (r.status === 'pending' ? { ...r, status: 'skipped' as const, reason } : r)), ...rows.slice(end)])
  }

  /**
   * Applies pm.execution.setNextRequest after row `i` ran, within its iteration: the rest of the iteration is replaced by
   * the run's items from the target on (items jumped over forwards are listed as skipped). null, or a name that matches
   * no request, ends the iteration (with one iteration: the run).
   */
  #jump(i: number, target: string | null) {
    const rows = this.#state.rows
    const iteration = rows[i].iteration
    if (target === null) return this.#endIteration(i, i + 1, this.#iterations > 1 ? 'Not run: setNextRequest(null) ended this iteration' : 'Not run: the run was ended by setNextRequest(null)')
    const k = findRunItem(this.#items, target)
    if (k < 0) {
      const ended = this.#iterations > 1 ? ' (this iteration ended)' : ''
      return this.#endIteration(i, i + 1, `Not run: setNextRequest("${target}") names no request of this run${ended}`)
    }
    const cur = this.#items.findIndex((it) => it.id === rows[i].item.id)
    const jumped =
      k > cur
        ? this.#items.slice(cur + 1, k).map((it) => ({ ...this.#blank(it, iteration), status: 'skipped' as const, reason: `Skipped by setNextRequest("${target}")` }))
        : []
    const end = this.#iterationEnd(i)
    this.#setRows([...rows.slice(0, i + 1), ...jumped, ...this.#items.slice(k).map((it) => this.#blank(it, iteration)), ...rows.slice(end)])
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms)
      const self = this
      function done() {
        clearTimeout(timer)
        self.#wake = null
        resolve()
      }
      this.#wake = done
    })
  }

  async #run(): Promise<RunState> {
    const now = this.#deps.now ?? Date.now
    this.#emit({ phase: 'running', startedAt: now() })
    let stopReason: string | null = null
    let executed = 0
    // Requests of the current iteration: a setNextRequest loop without an exit is cut off per iteration.
    let iteration = -1
    let inIteration = 0
    // Rows can change while running (setNextRequest), so the bound is re-read every time.
    for (let i = 0; i < this.#state.rows.length; i++) {
      if (this.#state.rows[i].status !== 'pending') continue
      if (this.#state.rows[i].iteration !== iteration) {
        iteration = this.#state.rows[i].iteration
        inIteration = 0
      }
      if (inIteration >= MAX_RUN_REQUESTS) {
        const what = this.#iterations > 1 ? 'the iteration' : 'the run'
        this.#endIteration(i, i, `Not run: ${what} stopped after ${MAX_RUN_REQUESTS} requests (setNextRequest loop?)`)
        continue
      }
      if (this.#cancelled) break
      if (executed > 0 && this.#options.delayMs > 0) {
        await this.#sleep(this.#options.delayMs)
        if (this.#cancelled) break
      }
      executed++
      inIteration++
      const item = this.#state.rows[i].item
      this.#setRow(i, { ...blankRow(item), status: 'running' })
      this.#runId = null
      const t0 = now()
      let row: RunRow
      let next: string | null | undefined
      try {
        const outcome = await this.#deps.execute(item, {
          onRunId: (id) => {
            this.#runId = id
            // Stop was requested while the request was being prepared.
            if (this.#cancelled) void this.#deps.cancel(id)
          },
          wasCancelled: () => this.#cancelled,
          iteration,
          data: this.#options.data?.[iteration] ?? null,
        })
        row = this.#toRow(item, outcome, now() - t0)
        next = outcome.scripts.nextRequest
      } catch (e) {
        row = { ...blankRow(item), status: 'failed', durationMs: now() - t0, reason: errorInfo(e).message }
      }
      this.#runId = null
      this.#setRow(i, row)
      this.#deps.onItemFinished?.(row)
      if (row.status === 'failed' && this.#options.stopOnFailure) {
        stopReason = 'Skipped: run stopped after a failure'
        break
      }
      if (next !== undefined && !this.#cancelled) this.#jump(i, next)
    }
    const finalRows = this.#state.rows.slice()
    for (let i = 0; i < finalRows.length; i++) {
      if (finalRows[i].status === 'pending') {
        finalRows[i] = { ...finalRows[i], status: 'skipped', reason: this.#cancelled ? 'Not run: stopped by user' : (stopReason ?? 'Not run') }
      }
    }
    this.#state = { ...this.#state, rows: finalRows, phase: 'done', finishedAt: now(), stopped: this.#cancelled, completed: finalRows.length }
    this.#deps.onUpdate?.(this.#state)
    return this.#state
  }

  #toRow(item: RunItem, outcome: ExecuteOutcome, elapsed: number): RunRow {
    const scripts = outcome.scripts
    const base: RunRow = { ...blankRow(item), tests: scripts.tests, scriptErrors: scripts.errors, console: scripts.console }
    if (outcome.ok) {
      const res = outcome.response
      const text = res.bodyText
      const preview =
        text !== null ? text.slice(0, BODY_PREVIEW_CHARS) : res.bodyBase64 !== null ? `(binary body, ${res.bodyByteLength} bytes)` : null
      const verdict = classifyStatus(res.status, { treat3xxAsPass: this.#options.treat3xxAsPass })
      const counts = testCounts(scripts)
      const detail = res.statusText ? ` ${res.statusText}` : ''
      const reasons: string[] = []
      if (!verdict.passed) reasons.push(`HTTP ${res.status}${detail}${res.status >= 300 && res.status < 400 ? ' (redirect did not end in a 2xx response)' : ''}`)
      if (counts.failed > 0) reasons.push(`${counts.failed} of ${counts.total} test${counts.total === 1 ? '' : 's'} failed`)
      const passed = reasons.length === 0
      // Large runs keep what explains a failure; a passed request keeps its status, time and tests.
      const keep = !passed || this.#state.rows.length <= DETAIL_ROWS
      return {
        ...base,
        status: passed ? 'passed' : 'failed',
        statusCode: res.status,
        statusText: res.statusText,
        durationMs: res.durationMs,
        reason: passed ? null : reasons.join('; '),
        headers: keep ? res.headers : [],
        bodyPreview: keep ? preview : null,
        bodyTruncated: keep && text !== null && text.length > BODY_PREVIEW_CHARS,
        ...(keep ? {} : { detailsDropped: true }),
      }
    }
    if (outcome.kind === 'cancelled') return { ...base, status: 'cancelled', durationMs: elapsed, reason: 'Cancelled' }
    const reason =
      outcome.kind === 'unresolved' && outcome.unresolved.length > 0
        ? `${outcome.error} (${outcome.unresolved.map((v) => `{{${v}}}`).join(', ')})`
        : outcome.error
    return { ...base, status: 'failed', durationMs: elapsed, reason }
  }
}

/** Index of the run item setNextRequest names: by request id, else by the first request with that name; -1 if none. */
export function findRunItem(items: RunItem[], target: string): number {
  const byId = items.findIndex((it) => it.id === target)
  return byId >= 0 ? byId : items.findIndex((it) => it.name === target)
}

const isFinal = (s: RowStatus) => s !== 'pending' && s !== 'running'

/** `data`: the run's data rows (the file's rows, not only the iterations that ran), exported next to the results. */
export function resultsToJson(name: string, state: RunState, data?: ReadonlyArray<Record<string, unknown>> | null): string {
  const s = summarize(state)
  return JSON.stringify(
    {
      collection: name,
      startedAt: state.startedAt ? new Date(state.startedAt).toISOString() : null,
      totalMs: s.totalMs,
      iterations: state.iterations,
      summary: { passed: s.passed, failed: s.failed, skipped: s.skipped, total: s.total, tests: s.tests },
      ...(data ? { data: data.slice(0, state.iterations) } : {}),
      results: state.rows.map((r) => ({
        iteration: r.iteration + 1,
        name: r.item.name,
        method: r.item.method,
        url: r.item.url,
        status: r.status,
        statusCode: r.statusCode,
        durationMs: r.durationMs,
        reason: r.reason,
        tests: r.tests.map((t) => ({ name: t.name, status: t.status, error: t.error })),
        scriptErrors: r.scriptErrors.map((e) => ({ source: e.source, message: e.message })),
      })),
    },
    null,
    2,
  )
}
