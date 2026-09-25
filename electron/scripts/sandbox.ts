/**
 * Runs a chain of Postman-style scripts in QuickJS (WebAssembly). Every script gets a FRESH QuickJS runtime and
 * context with a memory limit, a stack limit and an interrupt handler (deadline + cancellation). The context
 * has only the ECMAScript built-ins plus what prelude.js defines: no module loader, no std/os modules, no
 * filesystem, network, process, environment or timers. The single host function exchanges JSON text only.
 *
 * Pure apart from QuickJS: no Electron, no database. The caller supplies secret reads and cancellation
 * (worker.ts in the app, the test harness in vitest).
 */
import variant from '@jitl/quickjs-singlefile-cjs-release-sync'
import { newQuickJSWASMModuleFromVariant, type QuickJSContext, type QuickJSHandle, type QuickJSWASMModule } from 'quickjs-emscripten-core'
import type { ScriptSource } from '../../shared/types'
import PRELUDE from './prelude.js?raw'
import { RunHost, ScriptApiError } from './host'
import type { ScriptJob, ScriptJobResult, ScriptRunnerDeps } from './job'

let modulePromise: Promise<QuickJSWASMModule> | null = null

export function loadQuickJs(): Promise<QuickJSWASMModule> {
  modulePromise ??= newQuickJSWASMModuleFromVariant(variant).catch((err) => {
    modulePromise = null
    throw err
  })
  return modulePromise
}

/** Time budget for the post-script bookkeeping (`tests[...]` flush) after a timeout or cancel. */
const FINISH_BUDGET_MS = 250

interface ScriptOutcome {
  ok: boolean
  /** Stop the whole chain (cancelled). */
  abort: boolean
}

function describeError(ctx: QuickJSContext, handle: QuickJSHandle): string {
  let dumped: unknown
  try {
    dumped = ctx.dump(handle)
  } catch {
    return 'Error (the error value could not be read)'
  }
  if (dumped && typeof dumped === 'object') {
    const e = dumped as { name?: unknown; message?: unknown; stack?: unknown }
    const name = typeof e.name === 'string' ? e.name : 'Error'
    const message = typeof e.message === 'string' ? e.message : JSON.stringify(dumped)
    // QuickJS stacks look like "    at <eval> (request.js:3:7)"; report the first line inside the user script.
    const line = typeof e.stack === 'string' ? /\((?:collection|folder|request)\.js:(\d+)(?::\d+)?\)/.exec(e.stack) : null
    return `${name}: ${message}${line ? ` (line ${line[1]})` : ''}`
  }
  return `Uncaught ${typeof dumped === 'string' ? dumped : JSON.stringify(dumped)}`
}

function runOne(qjs: QuickJSWASMModule, host: RunHost, script: ScriptSource, deps: ScriptRunnerDeps): ScriptOutcome {
  const limits = host.job.limits
  const now = deps.now ?? Date.now
  const rt = qjs.newRuntime()
  let stop: 'timeout' | 'cancelled' | null = null
  let deadline = now() + limits.timeoutMs
  let honourCancel = true
  try {
    rt.setMemoryLimit(limits.memoryBytes)
    rt.setMaxStackSize(limits.stackBytes)
    rt.setInterruptHandler(() => {
      if (honourCancel && deps.isCancelled()) {
        stop ??= 'cancelled'
        return true
      }
      if (now() > deadline) {
        stop ??= 'timeout'
        return true
      }
      return false
    })
    const ctx = rt.newContext()
    try {
      host.begin(script)
      const bridge = ctx.newFunction('__slinger_call', (opH, argsH) => {
        let out: string
        try {
          const op = ctx.getString(opH)
          const args = JSON.parse(ctx.getString(argsH)) as unknown[]
          const value = host.dispatch(op, args)
          out = JSON.stringify(value === undefined ? {} : { v: value })
        } catch (err) {
          const message = err instanceof ScriptApiError || err instanceof Error ? err.message : String(err)
          out = JSON.stringify({ e: message })
        }
        return ctx.newString(out)
      })
      ctx.setProp(ctx.global, '__slinger_call', bridge)
      bridge.dispose()

      const prelude = ctx.evalCode(PRELUDE, 'slinger-prelude.js', { type: 'global', strict: false })
      if (prelude.error) {
        const msg = describeError(ctx, prelude.error)
        prelude.error.dispose()
        host.error(script, stop ?? 'internal', stop === 'timeout' ? `Script timed out after ${limits.timeoutMs} ms` : `Could not start the script sandbox: ${msg}`)
        return { ok: false, abort: stop === 'cancelled' }
      }
      prelude.value.dispose()

      let failed: string | null = null
      const r = ctx.evalCode(script.code, `${script.origin}.js`, { type: 'global', strict: false })
      if (r.error) {
        failed = describeError(ctx, r.error)
        r.error.dispose()
      } else {
        r.value.dispose()
        // Settle promise jobs (async tests, .then chains); the interrupt handler still applies.
        for (let guard = 0; guard < 10_000 && rt.hasPendingJob(); guard++) {
          const jobs = rt.executePendingJobs(-1)
          if (jobs.error) {
            failed = describeError(jobs.error.context, jobs.error)
            jobs.error.dispose()
            break
          }
          if (jobs.value === 0) break
        }
      }

      // Flush `tests[...]` and unfinished async tests, with a small fresh budget even after a timeout.
      honourCancel = false
      deadline = now() + FINISH_BUDGET_MS
      const reason = stop
      const fin = ctx.evalCode('typeof __slinger_finish === "function" && __slinger_finish()', 'slinger-finish.js', { type: 'global' })
      if (fin.error) fin.error.dispose()
      else fin.value.dispose()

      if (reason === 'cancelled') {
        host.error(script, 'cancelled', 'Cancelled')
        return { ok: false, abort: true }
      }
      if (reason === 'timeout') {
        host.error(script, 'timeout', `Script timed out after ${limits.timeoutMs} ms`)
        return { ok: false, abort: false }
      }
      if (failed !== null) {
        const memory = /out of memory/i.test(failed)
        host.error(script, memory ? 'memory' : 'error', memory ? `Script ran out of memory (limit ${Math.round(limits.memoryBytes / 1048576)} MB)` : failed)
        return { ok: false, abort: false }
      }
      return { ok: true, abort: false }
    } finally {
      ctx.dispose()
    }
  } finally {
    rt.dispose()
  }
}

/**
 * Runs `job.scripts` in order. A failing pre-request script stops the chain unless `continueOnError`; test scripts
 * are independent (each one runs even if an earlier one failed). Cancellation stops the chain.
 */
export async function runScriptChain(job: ScriptJob, deps: ScriptRunnerDeps): Promise<ScriptJobResult> {
  const now = deps.now ?? Date.now
  const started = now()
  const host = new RunHost(job, deps)
  let qjs: QuickJSWASMModule
  try {
    qjs = await loadQuickJs()
  } catch (err) {
    for (const s of job.scripts) host.error(s, 'internal', `The script sandbox could not be loaded: ${err instanceof Error ? err.message : String(err)}`)
    return host.result(now() - started)
  }
  for (const script of job.scripts) {
    if (deps.isCancelled()) {
      host.error(script, 'cancelled', 'Cancelled before it started')
      break
    }
    let outcome: ScriptOutcome
    try {
      outcome = runOne(qjs, host, script, deps)
    } catch (err) {
      // A failure of the engine itself (not of the script): drop the module so the next run starts clean.
      modulePromise = null
      host.error(script, 'internal', `The script sandbox failed: ${err instanceof Error ? err.message : String(err)}`)
      outcome = { ok: false, abort: job.event === 'prerequest' }
    }
    if (outcome.abort) break
    if (!outcome.ok && job.event === 'prerequest' && !job.continueOnError) break
  }
  return host.result(now() - started)
}
