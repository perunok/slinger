/**
 * Collection runner logic: runs items sequentially through an injectable executor.
 * No Svelte and no IPC in here; the dialog wires in `executeDraft` / `cancelRun`.
 */
import type { ApiFolder, ApiRequest, RequestHeader } from '../../../shared/types'
import { errorInfo } from '../../lib/ipc'
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
}

export interface RunOptions {
  delayMs: number
  stopOnFailure: boolean
}

export type RunPhase = 'idle' | 'running' | 'done'

export interface RunState {
  phase: RunPhase
  rows: RunRow[]
  /** Number of rows that reached a final state. */
  completed: number
  startedAt: number | null
  finishedAt: number | null
  stopped: boolean
}

export interface ExecHooks {
  onRunId: (runId: string) => void
  wasCancelled: () => boolean
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

function blankRow(item: RunItem): RunRow {
  return { item, status: 'pending', statusCode: null, statusText: '', durationMs: null, reason: null, headers: [], bodyPreview: null, bodyTruncated: false }
}

export function summarize(state: Pick<RunState, 'rows' | 'startedAt' | 'finishedAt'>) {
  let passed = 0
  let failed = 0
  let skipped = 0
  for (const r of state.rows) {
    if (r.status === 'passed') passed++
    else if (r.status === 'failed') failed++
    else if (r.status === 'skipped' || r.status === 'cancelled' || r.status === 'pending') skipped++
  }
  const totalMs = state.startedAt !== null && state.finishedAt !== null ? state.finishedAt - state.startedAt : 0
  return { passed, failed, skipped, total: state.rows.length, totalMs }
}

export class CollectionRun {
  #state: RunState
  #cancelled = false
  #runId: string | null = null
  #wake: (() => void) | null = null
  #finished: Promise<RunState> | null = null
  readonly #deps: RunDeps
  readonly #options: RunOptions

  constructor(items: RunItem[], options: RunOptions, deps: RunDeps) {
    this.#deps = deps
    this.#options = options
    this.#state = { phase: 'idle', rows: items.map(blankRow), completed: 0, startedAt: null, finishedAt: null, stopped: false }
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

  #setRow(i: number, row: RunRow) {
    const rows = this.#state.rows.slice()
    rows[i] = row
    this.#state = { ...this.#state, rows, completed: rows.filter((r) => r.status !== 'pending' && r.status !== 'running').length }
    this.#deps.onUpdate?.(this.#state)
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
    const rows = this.#state.rows
    let stopReason: string | null = null
    for (let i = 0; i < rows.length; i++) {
      if (this.#cancelled) break
      if (i > 0 && this.#options.delayMs > 0) {
        await this.#sleep(this.#options.delayMs)
        if (this.#cancelled) break
      }
      const item = rows[i].item
      this.#setRow(i, { ...blankRow(item), status: 'running' })
      this.#runId = null
      const t0 = now()
      let row: RunRow
      try {
        const outcome = await this.#deps.execute(item, {
          onRunId: (id) => {
            this.#runId = id
            // Stop was requested while the request was being prepared.
            if (this.#cancelled) void this.#deps.cancel(id)
          },
          wasCancelled: () => this.#cancelled,
        })
        row = this.#toRow(item, outcome, now() - t0)
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
    const base = blankRow(item)
    if (outcome.ok) {
      const res = outcome.response
      const text = res.bodyText
      const preview =
        text !== null ? text.slice(0, BODY_PREVIEW_CHARS) : res.bodyBase64 !== null ? `(binary body, ${res.bodyByteLength} bytes)` : null
      const failed = res.status >= 400
      return {
        ...base,
        status: failed ? 'failed' : 'passed',
        statusCode: res.status,
        statusText: res.statusText,
        durationMs: res.durationMs,
        reason: failed ? `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}` : null,
        headers: res.headers,
        bodyPreview: preview,
        bodyTruncated: text !== null && text.length > BODY_PREVIEW_CHARS,
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

export function resultsToJson(name: string, state: RunState): string {
  const s = summarize(state)
  return JSON.stringify(
    {
      collection: name,
      startedAt: state.startedAt ? new Date(state.startedAt).toISOString() : null,
      totalMs: s.totalMs,
      summary: { passed: s.passed, failed: s.failed, skipped: s.skipped, total: s.total },
      results: state.rows.map((r) => ({
        name: r.item.name,
        method: r.item.method,
        url: r.item.url,
        status: r.status,
        statusCode: r.statusCode,
        durationMs: r.durationMs,
        reason: r.reason,
      })),
    },
    null,
    2,
  )
}
