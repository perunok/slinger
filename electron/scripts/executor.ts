/**
 * Where script chains run. The app uses `WorkerExecutor` (worker threads, so the main process stays responsive
 * and a stuck worker can be terminated; the main thread never loads QuickJS). Unit tests may use `InlineExecutor`
 * (inline.ts: same sandbox, same thread).
 */
import { MessageChannel, Worker } from 'node:worker_threads'
import type { ScriptJob, ScriptJobResult, SendRequestCall, SendRequestOutcome } from './job'
import { sourceLabel } from './host'
import type { MainHttpReply, WorkerHttpMessage, WorkerJobMessage, WorkerReply } from './worker'

export interface ExecutorIo {
  /** Synchronous keychain read on the main thread; null when unavailable. */
  readSecret(variableId: string): string | null
  signal: AbortSignal
  /** Runs one pm.sendRequest on the main thread (never rejects). Absent: pm.sendRequest is unavailable. */
  sendHttp?(call: SendRequestCall, signal: AbortSignal): Promise<SendRequestOutcome>
}

export interface ScriptExecutor {
  run(job: ScriptJob, io: ExecutorIo): Promise<ScriptJobResult>
  dispose(): Promise<void>
}

/** A result for a chain that could not report back (worker crash, hard timeout, cancel of a stuck worker). */
export function failedResult(job: ScriptJob, kind: 'timeout' | 'cancelled' | 'internal', message: string, durationMs: number): ScriptJobResult {
  const first = job.scripts[0]
  return {
    errors: first ? [{ source: sourceLabel(job.event, first), kind, message }] : [],
    request: null,
    variables: job.variables,
    collectionVariables: job.collectionVariables,
    globals: job.globals,
    envOps: [],
    console: [],
    tests: [],
    durationMs,
  }
}

/** Used when no executor was configured: every run reports that scripts are unavailable. */
export class UnavailableExecutor implements ScriptExecutor {
  async run(job: ScriptJob): Promise<ScriptJobResult> {
    return failedResult(job, 'internal', 'Scripts are not available in this build', 0)
  }
  async dispose(): Promise<void> {}
}

export interface WorkerExecutorOptions {
  /** Creates one worker running worker.ts (bundled). */
  spawn: () => Worker
  /** Most chains running at the same time (one worker each). */
  maxWorkers?: number
  /** Workers kept warm between runs. */
  maxIdle?: number
  /** After a cancel, how long a worker may take to stop on its own before it is terminated. */
  cancelGraceMs?: number
}

export class WorkerExecutor implements ScriptExecutor {
  private readonly idle: Worker[] = []
  private readonly busy = new Set<Worker>()
  private readonly waiting: Array<() => void> = []
  private seq = 0
  private disposed = false
  private readonly maxWorkers: number
  private readonly maxIdle: number
  private readonly cancelGraceMs: number

  constructor(private readonly options: WorkerExecutorOptions) {
    this.maxWorkers = options.maxWorkers ?? 4
    this.maxIdle = options.maxIdle ?? 1
    this.cancelGraceMs = options.cancelGraceMs ?? 2000
  }

  async run(job: ScriptJob, io: ExecutorIo): Promise<ScriptJobResult> {
    if (this.disposed) return failedResult(job, 'internal', 'The script runner is shutting down', 0)
    while (this.busy.size >= this.maxWorkers) await new Promise<void>((r) => this.waiting.push(r))
    const worker = this.idle.pop() ?? this.options.spawn()
    worker.ref()
    this.busy.add(worker)
    let healthy = false
    try {
      const out = await this.exec(worker, job, io)
      healthy = out.healthy
      return out.result
    } finally {
      this.busy.delete(worker)
      if (healthy && !this.disposed && this.idle.length < this.maxIdle) {
        worker.unref()
        this.idle.push(worker)
      } else void worker.terminate()
      this.waiting.shift()?.()
    }
  }

  private exec(worker: Worker, job: ScriptJob, io: ExecutorIo): Promise<{ result: ScriptJobResult; healthy: boolean }> {
    return new Promise((resolve) => {
      const started = Date.now()
      const jobId = ++this.seq
      const control = new SharedArrayBuffer(8)
      const ctl = new Int32Array(control)
      const { port1, port2 } = new MessageChannel()
      const http = new MessageChannel()
      // pm.sendRequest calls of this job in flight on this thread; all aborted when the job ends.
      const sends = new Map<number, AbortController>()
      let done = false
      let grace: NodeJS.Timeout | null = null

      const finish = (result: ScriptJobResult, healthy: boolean) => {
        if (done) return
        done = true
        clearTimeout(watchdog)
        if (grace) clearTimeout(grace)
        io.signal.removeEventListener('abort', onAbort)
        worker.off('message', onMessage)
        worker.off('error', onError)
        worker.off('exit', onExit)
        port1.close()
        http.port1.close()
        for (const c of sends.values()) c.abort()
        sends.clear()
        if (!healthy) void worker.terminate()
        resolve({ result, healthy })
      }
      const onMessage = (m: WorkerReply) => {
        if (m.type === 'result' && m.jobId === jobId) finish(m.result, true)
        else if (m.type === 'failed' && m.jobId === jobId) finish(failedResult(job, 'internal', `The script sandbox failed: ${m.message}`, Date.now() - started), false)
      }
      const onError = (err: Error) => finish(failedResult(job, 'internal', `The script sandbox crashed: ${err.message}`, Date.now() - started), false)
      const onExit = () => finish(failedResult(job, 'internal', 'The script sandbox stopped unexpectedly', Date.now() - started), false)
      const onAbort = () => {
        Atomics.store(ctl, 0, 1)
        // Wake a script that is waiting for a secret read, so it can notice the cancel.
        Atomics.store(ctl, 1, 2)
        Atomics.notify(ctl, 1)
        grace ??= setTimeout(() => finish(failedResult(job, 'cancelled', 'Cancelled', Date.now() - started), false), this.cancelGraceMs)
      }
      // Backstop only: each script has its own deadlines (CPU and wall clock) enforced inside the worker.
      const budget = job.scripts.length * (Math.max(job.limits.timeoutMs, job.limits.wallClockMs) + 1000) + 5000
      const watchdog = setTimeout(
        () => finish(failedResult(job, 'timeout', `Scripts did not finish within ${Math.round(budget / 1000)} s and were stopped`, Date.now() - started), false),
        budget,
      )

      port1.on('message', (m: { type?: string; id?: unknown }) => {
        if (m?.type !== 'secret' || typeof m.id !== 'string') return
        let value: string | null = null
        try {
          value = io.readSecret(m.id)
        } catch {
          value = null
        }
        port1.postMessage({ value })
        Atomics.store(ctl, 1, 1)
        Atomics.notify(ctl, 1)
      })
      http.port1.on('message', (m: WorkerHttpMessage) => {
        if (m?.type === 'http-abort') {
          sends.get(m.id)?.abort()
          sends.delete(m.id)
          return
        }
        if (m?.type !== 'http' || typeof m.id !== 'number' || done) return
        const reply = (outcome: SendRequestOutcome) => {
          if (!sends.delete(m.id) || done) return
          http.port1.postMessage({ id: m.id, outcome } satisfies MainHttpReply)
        }
        const controller = new AbortController()
        sends.set(m.id, controller)
        if (!io.sendHttp) {
          reply({ ok: false, error: 'pm.sendRequest is not available here', logLine: '→ pm.sendRequest is not available here' })
          return
        }
        io.sendHttp(m.call, AbortSignal.any([controller.signal, io.signal])).then(reply, (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          reply({ ok: false, error: message, logLine: `→ ${m.call.method} failed: ${message}` })
        })
      })
      worker.on('message', onMessage)
      worker.on('error', onError)
      worker.on('exit', onExit)
      io.signal.addEventListener('abort', onAbort)
      if (io.signal.aborted) onAbort()
      const msg: WorkerJobMessage = { type: 'run', jobId, job, control, port: port2, httpPort: http.port2 }
      worker.postMessage(msg, [port2, http.port2])
    })
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const all = [...this.idle, ...this.busy]
    this.idle.length = 0
    await Promise.all(all.map((w) => w.terminate()))
  }
}
