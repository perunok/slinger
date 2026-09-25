/**
 * The production path: the worker bundle (built here with the same esbuild setup as scripts/build-main.mjs),
 * started with `eval: true` exactly like main.ts, driven through WorkerExecutor. Covers what cannot be tested
 * in-thread: cancellation from the main thread while a script spins, the synchronous secret bridge, a hard
 * terminate of a stuck worker, and that the main thread stays responsive during a long script.
 */
import { build } from 'esbuild'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { rawPlugin } from '../../../scripts/esbuild-raw.mjs'
import { WorkerExecutor } from '../../scripts/executor'
import { DEFAULT_LIMITS } from '../../scripts/job'
import { job, script } from './harness'

let dir: string
let source: string
let spawned = 0
let executor: WorkerExecutor

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'slinger-worker-'))
  await build({
    absWorkingDir: fileURLToPath(new URL('../../..', import.meta.url)),
    entryPoints: { 'script-worker': 'electron/scripts/worker.ts' },
    outdir: dir,
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'silent',
    plugins: [rawPlugin],
  })
  source = readFileSync(join(dir, 'script-worker.cjs'), 'utf8')
  executor = new WorkerExecutor({
    spawn: () => {
      spawned++
      return new Worker(source, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 } })
    },
    cancelGraceMs: 500,
  })
}, 60_000)

afterAll(async () => {
  await executor?.dispose()
  rmSync(dir, { recursive: true, force: true })
})

const io = (over: Partial<{ readSecret: (id: string) => string | null; signal: AbortSignal }> = {}) => ({
  readSecret: () => null,
  signal: new AbortController().signal,
  ...over,
})

describe('WorkerExecutor with the bundled worker', () => {
  it('runs a chain and reuses a warm worker', async () => {
    const before = spawned
    const a = await executor.run(job({ scripts: [script(`pm.variables.set('n', 1)`)] }), io())
    const b = await executor.run(job({ scripts: [script(`pm.variables.set('n', pm.variables.get('n') + 1)`)], variables: a.variables }), io())
    expect(a.errors).toEqual([])
    expect(b.variables).toEqual({ n: 2 })
    expect(spawned - before).toBeLessThanOrEqual(1)
  })

  it('reads a secret synchronously through the main thread, only when asked', async () => {
    const asked: string[] = []
    const env = { name: 'E', variables: [{ id: 'sec-1', key: 'token', value: null, secret: true }, { id: 'sec-2', key: 'other', value: null, secret: true }] }
    const r = await executor.run(
      job({ environment: env, scripts: [script(`pm.test('read', () => pm.expect(pm.environment.get('token')).to.equal('s3cr3t'))`)] }),
      io({ readSecret: (id) => (asked.push(id), id === 'sec-1' ? 's3cr3t' : 'other-value') }),
    )
    expect(r.tests[0]).toMatchObject({ status: 'passed' })
    expect(asked).toEqual(['sec-1'])
  })

  it('keeps the main thread responsive and cancels a spinning script from the main thread', async () => {
    const controller = new AbortController()
    let ticks = 0
    const timer = setInterval(() => ticks++, 10)
    setTimeout(() => controller.abort(), 300)
    const started = Date.now()
    const r = await executor.run(
      job({ scripts: [script('while (true) {}', 'folder', 'F'), script('console.log("never")')], limits: { ...DEFAULT_LIMITS, timeoutMs: 30_000 } }),
      io({ signal: controller.signal }),
    )
    clearInterval(timer)
    expect(Date.now() - started).toBeLessThan(3000)
    expect(ticks).toBeGreaterThan(5)
    expect(r.errors).toEqual([{ source: 'Pre-request · folder “F”', kind: 'cancelled', message: 'Cancelled' }])
    expect(r.console).toEqual([])
  })

  it('enforces the per-script deadline inside the worker', async () => {
    const r = await executor.run(job({ scripts: [script('for (;;) {}')], limits: { ...DEFAULT_LIMITS, timeoutMs: 250 } }), io())
    expect(r.errors[0]).toMatchObject({ kind: 'timeout', message: 'Script timed out after 250 ms' })
  })

  it('a cancel while a script waits for a secret wakes it up', async () => {
    const controller = new AbortController()
    const r = await executor.run(
      job({
        environment: { name: 'E', variables: [{ id: 's', key: 'k', value: null, secret: true }] },
        scripts: [script(`pm.environment.get('k'); while (true) {}`)],
        limits: { ...DEFAULT_LIMITS, timeoutMs: 30_000 },
      }),
      io({
        signal: controller.signal,
        // Simulates a slow keychain prompt: the user cancels meanwhile.
        readSecret: () => {
          controller.abort()
          return null
        },
      }),
    )
    expect(r.errors[0]?.kind).toBe('cancelled')
  })

  it('still works after a worker was terminated', async () => {
    const r = await executor.run(job({ scripts: [script(`console.log('alive')`)] }), io())
    expect(r.console.map((c) => c.message)).toEqual(['alive'])
  })
})
