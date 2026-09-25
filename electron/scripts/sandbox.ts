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
import LIBRARIES from 'virtual:sandbox-libs'
import { RunHost, ScriptApiError } from './host'
import type { ScriptJob, ScriptJobResult, ScriptRunnerDeps } from './job'

/** Names of the built-in libraries (require()), comma-separated, as the prelude asks for them. */
const LIBRARY_NAMES = Object.keys(LIBRARIES).join(',')

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
  /**
   * The runtime was interrupted (timeout / cancel) or could not be freed cleanly. QuickJS can leave objects
   * of an interrupted promise job unreachable-but-referenced, and freeing such a runtime aborts the whole WASM
   * module, so an interrupted runtime is NOT freed: the module instance is dropped instead (V8 frees its memory)
   * and the next script loads a fresh one (~10 ms).
   */
  tainted: boolean
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

/** How often a script waiting for pm.sendRequest responses checks for cancellation. */
const WAIT_POLL_MS = 50

async function runOne(qjs: QuickJSWASMModule, host: RunHost, script: ScriptSource, deps: ScriptRunnerDeps): Promise<ScriptOutcome> {
  const limits = host.job.limits
  const now = deps.now ?? Date.now
  const rt = qjs.newRuntime()
  let stop: 'timeout' | 'cancelled' | null = null
  let wallTimeout = false
  const started = now()
  // CPU budget: time spent waiting for pm.sendRequest responses is added back (see the wait loop below).
  let deadline = started + limits.timeoutMs
  const wallDeadline = started + Math.max(limits.wallClockMs, limits.timeoutMs)
  let honourCancel = true
  let tainted = false
  const done = (ok: boolean, abort: boolean): ScriptOutcome => ({ ok, abort, tainted: tainted || stop !== null })
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
    let freeCtx = true
    let settleFn: QuickJSHandle | null = null
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
      // Built-in libraries: text only. With no argument, the library names; with a name, that library's bundled
      // source ('' for an unknown name), which the prelude evaluates INSIDE this context on the first require().
      const libs = ctx.newFunction('__slinger_lib', (nameH?: QuickJSHandle) => {
        if (nameH === undefined || ctx.typeof(nameH) !== 'string') return ctx.newString(LIBRARY_NAMES)
        const name = ctx.getString(nameH)
        return ctx.newString(Object.hasOwn(LIBRARIES, name) ? LIBRARIES[name] : '')
      })
      ctx.setProp(ctx.global, '__slinger_lib', libs)
      libs.dispose()

      const prelude = ctx.evalCode(PRELUDE, 'slinger-prelude.js', { type: 'global', strict: false })
      if (prelude.error) {
        const msg = describeError(ctx, prelude.error)
        prelude.error.dispose()
        host.error(script, stop ?? 'internal', stop === 'timeout' ? `Script timed out after ${limits.timeoutMs} ms` : `Could not start the script sandbox: ${msg}`)
        return done(false, stop === 'cancelled')
      }
      prelude.value.dispose()
      // The prelude's pm.sendRequest settle function: kept as a host handle only, removed from the global scope.
      const sf = ctx.getProp(ctx.global, '__slinger_settle')
      if (ctx.typeof(sf) === 'function') settleFn = sf
      else sf.dispose()
      const del = ctx.evalCode('delete globalThis.__slinger_settle', 'slinger-prelude.js', { type: 'global' })
      if (del.error) del.error.dispose()
      else del.value.dispose()

      // Settle promise jobs (async tests, .then chains); the interrupt handler still applies.
      const drain = (): string | null => {
        for (let guard = 0; guard < 10_000 && rt.hasPendingJob(); guard++) {
          const jobs = rt.executePendingJobs(-1)
          if (jobs.error) {
            const msg = describeError(jobs.error.context, jobs.error)
            jobs.error.dispose()
            return msg
          }
          if (jobs.value === 0) break
        }
        return null
      }

      let failed: string | null = null
      const r = ctx.evalCode(script.code, `${script.origin}.js`, { type: 'global', strict: false })
      if (r.error) {
        failed = describeError(ctx, r.error)
        r.error.dispose()
      } else {
        r.value.dispose()
        failed = drain()
        // pm.sendRequest: the script is finished only when every request it started was handed back to it (callback
        // or promise) and the resulting jobs ran. Waiting does not count against the CPU budget, only the wall clock.
        while (failed === null && stop === null && host.pendingSends() > 0) {
          const next = host.takeSettled()
          if (!next) {
            if (deps.isCancelled()) {
              stop = 'cancelled'
              break
            }
            const remaining = wallDeadline - now()
            if (remaining <= 0) {
              stop = 'timeout'
              wallTimeout = true
              break
            }
            const waitStart = now()
            await host.waitForSettled(Math.min(remaining, WAIT_POLL_MS))
            deadline += now() - waitStart
            continue
          }
          if (!settleFn) break
          const { logLine: _log, ...payload } = next.outcome
          const idH = ctx.newNumber(next.id)
          const payloadH = ctx.newString(JSON.stringify(payload))
          const res = ctx.callFunction(settleFn, ctx.undefined, idH, payloadH)
          idH.dispose()
          payloadH.dispose()
          if (res.error) {
            failed = describeError(ctx, res.error)
            res.error.dispose()
            break
          }
          res.value.dispose()
          failed = drain()
        }
      }
      host.abortSends()

      // Flush `tests[...]` and unfinished async tests, with a small fresh budget even after a timeout.
      honourCancel = false
      deadline = now() + FINISH_BUDGET_MS
      const reason = stop
      const fin = ctx.evalCode('typeof __slinger_finish === "function" && __slinger_finish()', 'slinger-finish.js', { type: 'global' })
      if (fin.error) fin.error.dispose()
      else fin.value.dispose()

      if (reason === 'cancelled') {
        host.error(script, 'cancelled', 'Cancelled')
        return done(false, true)
      }
      if (reason === 'timeout') {
        host.error(
          script,
          'timeout',
          wallTimeout
            ? `Script did not finish within ${Math.round(Math.max(limits.wallClockMs, limits.timeoutMs) / 1000)} s (still waiting for pm.sendRequest responses)`
            : `Script timed out after ${limits.timeoutMs} ms`,
        )
        return done(false, false)
      }
      if (failed !== null) {
        const memory = /out of memory/i.test(failed)
        host.error(script, memory ? 'memory' : 'error', memory ? `Script ran out of memory (limit ${Math.round(limits.memoryBytes / 1048576)} MB)` : failed)
        return done(false, false)
      }
      return done(true, false)
    } finally {
      host.abortSends()
      if (settleFn && freeCtx && stop === null) {
        try {
          settleFn.dispose()
        } catch {
          tainted = true
        }
      }
      if (stop !== null) freeCtx = false
      if (freeCtx) {
        try {
          ctx.dispose()
        } catch {
          tainted = true
        }
      }
    }
  } finally {
    if (stop === null && !tainted) {
      try {
        rt.dispose()
      } catch {
        tainted = true
      }
    }
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
      outcome = await runOne(qjs, host, script, deps)
    } catch (err) {
      // A failure of the engine itself (not of the script).
      host.error(script, 'internal', `The script sandbox failed: ${err instanceof Error ? err.message : String(err)}`)
      outcome = { ok: false, abort: job.event === 'prerequest', tainted: true }
    }
    if (outcome.tainted) {
      // Drop this module instance (see ScriptOutcome.tainted); later scripts get a fresh one.
      modulePromise = null
      try {
        qjs = await loadQuickJs()
      } catch (err) {
        host.error(script, 'internal', `The script sandbox could not be reloaded: ${err instanceof Error ? err.message : String(err)}`)
        break
      }
    }
    if (outcome.abort) break
    if (!outcome.ok && job.event === 'prerequest' && !job.continueOnError) break
  }
  return host.result(now() - started)
}
