/**
 * Runs a workflow graph (./graph.ts). Pure: sending requests, evaluating JavaScript and waiting are injected, so this
 * is unit-tested without IPC (src/features/workflows/runWorkflow.ts supplies the real ones).
 *
 * Semantics:
 * - Every Start node fires once, in reading order (top to bottom, then left to right), with its configured value.
 * - A node runs when a value arrives at its input and sends values out of its ports. Each value goes down every edge of
 *   that port in turn, and the whole branch behind an edge finishes before the next edge or port (depth first,
 *   one step at a time, so runs are deterministic and request order is the order you see).
 * - For each sends every item down `item` (each item's branch finishes first), then the list down `done`.
 * - A node that fails sends `{ message }` down its `error` port when that port is connected; otherwise the run stops
 *   with that error (like an uncaught exception). If has no error port: a failing condition stops the run.
 * - Cycles are allowed (loop back through an If); `maxSteps` node executions per run stop runaway loops.
 */
import { NODE_DEFS, nodeTitle, type NodeConfigs, type VariableScope, type WorkflowEdge, type WorkflowGraph, type WorkflowNode } from './graph'

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

export interface EngineDeps {
  /** Sends the saved request; `variables` (the input's fields) resolve as `{{name}}` in it. */
  sendRequest(node: WorkflowNode<'request'>, input: unknown, signal: AbortSignal): Promise<Result<unknown>>
  /** Runs JavaScript (a function body; `input` is defined) in the script sandbox and returns what it returned. */
  evaluate(node: WorkflowNode, code: string, input: unknown, signal: AbortSignal): Promise<Result<unknown>>
  sleep(ms: number, signal: AbortSignal): Promise<void>
  onEvent?(event: RunEvent): void
  /** Defaults to 1000. */
  maxSteps?: number
}

export type RunEvent =
  | { type: 'node-start'; nodeId: string; input: unknown; step: number }
  /** `ports`: where it sent its value (For each: item and done, after all iterations). */
  | { type: 'node-end'; nodeId: string; ports: string[]; output: unknown; durationMs: number; step: number }
  /** For each: item `index` (0-based) of `count` is about to go down `item`. */
  | { type: 'node-progress'; nodeId: string; index: number; count: number; step: number }
  | { type: 'node-error'; nodeId: string; error: string; handled: boolean; durationMs: number; step: number }
  | { type: 'output'; nodeId: string; label: string; value: unknown; step: number }

export type RunPhase = 'running' | 'done' | 'failed' | 'stopped'

export interface RunSummary {
  phase: Exclude<RunPhase, 'running'>
  steps: number
  error: { nodeId: string | null; message: string } | null
}

export const DEFAULT_MAX_STEPS = 1000

class Stop extends Error {}
class Fail extends Error {
  constructor(
    readonly nodeId: string | null,
    message: string,
  ) {
    super(message)
  }
}

/** JavaScript for an expression node: the expression's value. */
export const expressionCode = (expr: string): string => `return (${expr.trim() || 'undefined'}\n)`

/** JavaScript for a Set variable node: stores the value in the scope and passes the input on. */
export function setVariableCode(cfg: NodeConfigs['setVariable']): string {
  const target: Record<VariableScope, string> = { run: 'pm.variables', environment: 'pm.environment', globals: 'pm.globals' }
  return [
    `const __value = (${cfg.value.trim() || 'input'}\n);`,
    `${target[cfg.scope]}.set(${JSON.stringify(cfg.name.trim())}, typeof __value === 'string' ? __value : JSON.stringify(__value));`,
    'return input',
  ].join('\n')
}

/** Start nodes in reading order. */
export function startNodes(graph: WorkflowGraph): WorkflowNode[] {
  return graph.nodes.filter((n) => n.type === 'start').sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)
}

function parseStartValue(text: string): Result<unknown> {
  if (!text.trim()) return { ok: true, value: null }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false, error: 'the value is not valid JSON' }
  }
}

export class WorkflowRun {
  #controller = new AbortController()
  #steps = 0
  #edgesFrom = new Map<string, WorkflowEdge[]>()
  #byId: Map<string, WorkflowNode>
  readonly maxSteps: number

  constructor(
    readonly graph: WorkflowGraph,
    private readonly deps: EngineDeps,
  ) {
    this.#byId = new Map(graph.nodes.map((n) => [n.id, n]))
    for (const e of graph.edges) {
      const key = `${e.source}\u0000${e.sourcePort}`
      this.#edgesFrom.set(key, [...(this.#edgesFrom.get(key) ?? []), e])
    }
    this.maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS
  }

  get stopped(): boolean {
    return this.#controller.signal.aborted
  }

  stop() {
    this.#controller.abort()
  }

  async run(): Promise<RunSummary> {
    try {
      const starts = startNodes(this.graph)
      if (starts.length === 0) throw new Fail(null, 'Add a Start node: a run begins there.')
      for (const node of starts) await this.#fire(node, undefined)
      return { phase: 'done', steps: this.#steps, error: null }
    } catch (e) {
      if (e instanceof Stop || this.stopped) return { phase: 'stopped', steps: this.#steps, error: null }
      if (e instanceof Fail) return { phase: 'failed', steps: this.#steps, error: { nodeId: e.nodeId, message: e.message } }
      return { phase: 'failed', steps: this.#steps, error: { nodeId: null, message: e instanceof Error ? e.message : String(e) } }
    }
  }

  async #fire(node: WorkflowNode, input: unknown): Promise<void> {
    if (this.stopped) throw new Stop()
    if (this.#steps >= this.maxSteps) {
      throw new Fail(node.id, `Stopped after ${this.maxSteps} steps: does a loop never end?`)
    }
    const step = ++this.#steps
    const emit = this.deps.onEvent ?? (() => {})
    emit({ type: 'node-start', nodeId: node.id, input, step })
    const started = Date.now()
    const outcome = await this.#execute(node, input, step)
    if (this.stopped) throw new Stop()
    const durationMs = Date.now() - started
    if (!outcome.ok) {
      const handled = this.#connected(node, 'error')
      emit({ type: 'node-error', nodeId: node.id, error: outcome.error, handled, durationMs, step })
      if (!handled) throw new Fail(node.id, `${nodeTitle(node)}: ${outcome.error}`)
      await this.#send(node, 'error', { message: outcome.error })
      return
    }
    // For each has sent its values already (see #execute); the others report what they send, then send it.
    const { port, value, sent } = outcome.value
    emit({ type: 'node-end', nodeId: node.id, ports: sent ?? (port ? [port] : []), output: value, durationMs, step })
    if (port) await this.#send(node, port, value)
  }

  /** What the node sends (port null: nothing, e.g. Output). For each runs its iterations here. */
  async #execute(node: WorkflowNode, input: unknown, step: number): Promise<Result<{ port: string | null; value: unknown; sent?: string[] }>> {
    const signal = this.#controller.signal
    const send = (port: string | null, value: unknown, sent?: string[]) => ({ ok: true as const, value: { port, value, sent } })
    switch (node.type) {
      case 'start': {
        const parsed = parseStartValue((node.config as NodeConfigs['start']).value)
        return parsed.ok ? send('out', parsed.value) : parsed
      }
      case 'request': {
        const r = await this.deps.sendRequest(node as WorkflowNode<'request'>, input, signal)
        return r.ok ? send('response', r.value) : r
      }
      case 'evaluate': {
        const r = await this.deps.evaluate(node, (node.config as NodeConfigs['evaluate']).code, input, signal)
        return r.ok ? send('out', r.value ?? null) : r
      }
      case 'if': {
        const r = await this.deps.evaluate(node, expressionCode((node.config as NodeConfigs['if']).condition), input, signal)
        return r.ok ? send(r.value ? 'true' : 'false', input) : r
      }
      case 'forEach': {
        const r = await this.deps.evaluate(node, expressionCode((node.config as NodeConfigs['forEach']).list), input, signal)
        if (!r.ok) return r
        if (!Array.isArray(r.value)) return { ok: false, error: `the list is ${r.value === null ? 'null' : typeof r.value}, not an array` }
        const list = r.value as unknown[]
        const emit = this.deps.onEvent ?? (() => {})
        for (const [index, item] of list.entries()) {
          if (this.stopped) throw new Stop()
          emit({ type: 'node-progress', nodeId: node.id, index, count: list.length, step })
          await this.#send(node, 'item', item)
        }
        await this.#send(node, 'done', list)
        return send(null, list, list.length > 0 ? ['item', 'done'] : ['done'])
      }
      case 'delay': {
        await this.deps.sleep((node.config as NodeConfigs['delay']).ms, signal)
        return send('out', input)
      }
      case 'setVariable': {
        const cfg = node.config as NodeConfigs['setVariable']
        if (!cfg.name.trim()) return { ok: false, error: 'the variable has no name' }
        const r = await this.deps.evaluate(node, setVariableCode(cfg), input, signal)
        return r.ok ? send('out', input) : r
      }
      case 'output': {
        const emit = this.deps.onEvent ?? (() => {})
        emit({ type: 'output', nodeId: node.id, label: (node.config as NodeConfigs['output']).label.trim() || nodeTitle(node), value: input, step })
        return send(null, input)
      }
    }
  }

  #connected(node: WorkflowNode, port: string): boolean {
    return (this.#edgesFrom.get(`${node.id}\u0000${port}`)?.length ?? 0) > 0
  }

  async #send(node: WorkflowNode, port: string, value: unknown): Promise<void> {
    for (const edge of this.#edgesFrom.get(`${node.id}\u0000${port}`) ?? []) {
      const target = this.#byId.get(edge.target)
      if (target && NODE_DEFS[target.type].hasInput) await this.#fire(target, value)
    }
  }
}
