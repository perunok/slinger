import { describe, expect, it, vi } from 'vitest'
import type { ApiFolder, ApiRequest, HttpResponseData } from '../../../shared/types'
import type { ExecuteOutcome } from '../requests/execute'
import { emptyScriptOutput } from '../../lib/scripts'
import { classifyStatus, CollectionRun, collectRunItems, resultsToJson, summarize, type RunItem, type RunState } from './runner'

const req = (id: string, folderId: string | null, sortOrder = 0): ApiRequest => ({
  id, workspaceId: 'w', collectionId: 'c', folderId, name: id, method: 'GET', url: `https://x/${id}`, documentJson: '{}', sortOrder, createdAt: 0, updatedAt: 0, version: 1,
})
const folder = (id: string, parent: string | null, sortOrder = 0): ApiFolder =>
  ({ id, workspaceId: 'w', collectionId: 'c', parentFolderId: parent, name: id, sortOrder, createdAt: 0, updatedAt: 0, version: 1 }) as ApiFolder
const item = (id: string): RunItem => {
  const request = req(id, null)
  return { id, name: id, method: 'GET', url: request.url, request }
}
const response = (status: number, body: string | null = 'ok'): HttpResponseData => ({
  status, statusText: status === 200 ? 'OK' : 'Err', durationMs: 5, headers: [{ key: 'A', value: 'b' }], bodyText: body, bodyBase64: null, bodyByteLength: body?.length ?? 0,
})
const ok = (status = 200, body: string | null = 'ok'): ExecuteOutcome => ({ ok: true, response: response(status, body), warnings: [], runId: 'r', elapsedMs: 5, scripts: emptyScriptOutput() })

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

describe('collectRunItems', () => {
  const folders = [folder('f1', null, 0), folder('f2', 'f1', 0)]
  const requests = [req('root', null, 0), req('a', 'f1', 0), req('b', 'f2', 0), req('c', 'f1', 1)]
  it('walks folders first, in tree order', () => {
    expect(collectRunItems(folders, requests, null).map((i) => i.id)).toEqual(['b', 'a', 'c', 'root'])
  })
  it('restricts to a folder including nested folders', () => {
    expect(collectRunItems(folders, requests, 'f1').map((i) => i.id)).toEqual(['b', 'a', 'c'])
    expect(collectRunItems(folders, requests, 'f2').map((i) => i.id)).toEqual(['b'])
    expect(collectRunItems(folders, requests, 'nope')).toEqual([])
  })
})

describe('CollectionRun', () => {
  it('runs sequentially in order and classifies results', async () => {
    const order: string[] = []
    let active = 0
    let maxActive = 0
    const outcomes: Record<string, ExecuteOutcome> = {
      a: ok(200),
      b: ok(404),
      c: { ok: false, kind: 'failed', error: 'connect ECONNREFUSED', scripts: emptyScriptOutput() },
      d: { ok: false, kind: 'unresolved', error: 'Unresolved variables', unresolved: ['token'], scripts: emptyScriptOutput() },
    }
    const onFinished = vi.fn()
    const run = new CollectionRun(['a', 'b', 'c', 'd'].map(item), { delayMs: 0, stopOnFailure: false }, {
      execute: async (it) => {
        active++
        maxActive = Math.max(maxActive, active)
        order.push(it.id)
        await Promise.resolve()
        active--
        return outcomes[it.id]
      },
      cancel: async () => {},
      onItemFinished: onFinished,
    })
    const state = await run.start()
    expect(order).toEqual(['a', 'b', 'c', 'd'])
    expect(maxActive).toBe(1)
    expect(state.rows.map((r) => r.status)).toEqual(['passed', 'failed', 'failed', 'failed'])
    expect(state.rows[1].reason).toBe('HTTP 404 Err')
    expect(state.rows[2].reason).toBe('connect ECONNREFUSED')
    expect(state.rows[3].reason).toContain('{{token}}')
    expect(onFinished).toHaveBeenCalledTimes(4)
    expect(summarize(state)).toMatchObject({ passed: 1, failed: 3, skipped: 0, total: 4 })
    expect(state.phase).toBe('done')
  })

  it('previews at most 2 KB of body and marks binary bodies', async () => {
    const big = 'x'.repeat(5000)
    const run = new CollectionRun([item('a'), item('b')], { delayMs: 0, stopOnFailure: false }, {
      execute: async (it) =>
        it.id === 'a' ? ok(200, big) : { ok: true, response: { ...response(200, null), bodyBase64: 'AAEC', bodyByteLength: 3 }, warnings: [], runId: 'r', elapsedMs: 1, scripts: emptyScriptOutput() },
      cancel: async () => {},
    })
    const s = await run.start()
    expect(s.rows[0].bodyPreview).toHaveLength(2048)
    expect(s.rows[0].bodyTruncated).toBe(true)
    expect(s.rows[1].bodyPreview).toContain('binary')
  })

  it('stops after the first failure when asked', async () => {
    const execute = vi.fn(async (it: RunItem) => (it.id === 'b' ? ok(500) : ok(200)))
    const run = new CollectionRun(['a', 'b', 'c', 'd'].map(item), { delayMs: 0, stopOnFailure: true }, { execute, cancel: async () => {} })
    const s = await run.start()
    expect(execute).toHaveBeenCalledTimes(2)
    expect(s.rows.map((r) => r.status)).toEqual(['passed', 'failed', 'skipped', 'skipped'])
    expect(s.stopped).toBe(false)
  })

  it('stop cancels the in-flight request and skips the rest', async () => {
    const gate = deferred<ExecuteOutcome>()
    const cancel = vi.fn(async () => {
      gate.resolve({ ok: false, kind: 'cancelled', error: 'Request cancelled', scripts: emptyScriptOutput() })
    })
    const execute = vi.fn(async (it: RunItem, hooks: { onRunId: (id: string) => void }) => {
      hooks.onRunId(`run-${it.id}`)
      return it.id === 'a' ? ok(200) : gate.promise
    })
    const run = new CollectionRun(['a', 'b', 'c'].map(item), { delayMs: 0, stopOnFailure: false }, { execute, cancel })
    const done = run.start()
    await vi.waitFor(() => expect(run.state.rows[1].status).toBe('running'))
    run.stop()
    const s = await done
    expect(cancel).toHaveBeenCalledWith('run-b')
    expect(execute).toHaveBeenCalledTimes(2)
    expect(s.rows.map((r) => r.status)).toEqual(['passed', 'cancelled', 'skipped'])
    expect(s.stopped).toBe(true)
    expect(summarize(s).skipped).toBe(2)
  })

  it('stop during the delay prevents the next request', async () => {
    const execute = vi.fn(async () => ok())
    const run = new CollectionRun([item('a'), item('b')], { delayMs: 60000, stopOnFailure: false }, { execute, cancel: async () => {} })
    const done = run.start()
    await vi.waitFor(() => expect(run.state.completed).toBe(1))
    run.stop()
    const s = await done
    expect(execute).toHaveBeenCalledTimes(1)
    expect(s.rows[1].status).toBe('skipped')
  })

  it('stop before the run id is known cancels as soon as it is assigned', async () => {
    const gate = deferred<ExecuteOutcome>()
    let onRunId!: (id: string) => void
    const cancel = vi.fn(async () => gate.resolve({ ok: false, kind: 'cancelled', error: 'x', scripts: emptyScriptOutput() }))
    const run = new CollectionRun([item('a')], { delayMs: 0, stopOnFailure: false }, {
      execute: (_it, hooks) => {
        onRunId = hooks.onRunId
        return gate.promise
      },
      cancel,
    })
    const done = run.start()
    await vi.waitFor(() => expect(run.state.rows[0].status).toBe('running'))
    run.stop()
    expect(cancel).not.toHaveBeenCalled()
    onRunId('late')
    await done
    expect(cancel).toHaveBeenCalledWith('late')
  })

  it('reports executor exceptions as failures and keeps going', async () => {
    const run = new CollectionRun([item('a'), item('b')], { delayMs: 0, stopOnFailure: false }, {
      execute: async (it) => {
        if (it.id === 'a') throw new Error('boom')
        return ok()
      },
      cancel: async () => {},
    })
    const s = await run.start()
    expect(s.rows.map((r) => r.status)).toEqual(['failed', 'passed'])
    expect(s.rows[0].reason).toBe('boom')
  })

  it('emits progress updates', async () => {
    const updates: RunState[] = []
    const run = new CollectionRun([item('a'), item('b')], { delayMs: 0, stopOnFailure: false }, {
      execute: async () => ok(),
      cancel: async () => {},
      onUpdate: (s) => updates.push(s),
    })
    await run.start()
    expect(updates.at(-1)?.completed).toBe(2)
    expect(Math.max(...updates.map((u) => u.completed))).toBe(2)
    expect(JSON.parse(resultsToJson('C', updates.at(-1)!)).summary).toEqual({
      passed: 2,
      failed: 0,
      skipped: 0,
      total: 2,
      tests: { passed: 0, failed: 0, skipped: 0, total: 0 },
    })
  })

  it('a failing test script fails the row; test counts reach the summary and the JSON export', async () => {
    const withTests = (statuses: Array<'passed' | 'failed'>, errors: string[] = []): ExecuteOutcome => ({
      ...(ok() as Extract<ExecuteOutcome, { ok: true }>),
      scripts: {
        ...emptyScriptOutput(),
        scriptCount: 1,
        tests: statuses.map((status, i) => ({ name: `t${i}`, status, error: status === 'failed' ? 'AssertionError: nope' : null, source: 'Tests · request “x”' })),
        errors: errors.map((message) => ({ source: 'Tests · request “x”', kind: 'error' as const, message })),
        console: [{ level: 'log' as const, message: 'hi', timestamp: 1, source: 'Tests · request “x”' }],
      },
    })
    const outcomes: Record<string, ExecuteOutcome> = { a: withTests(['passed', 'passed']), b: withTests(['passed', 'failed']), c: withTests([], ['TypeError: boom']) }
    const run = new CollectionRun(['a', 'b', 'c'].map(item), { delayMs: 0, stopOnFailure: false }, { execute: async (it) => outcomes[it.id], cancel: async () => {} })
    const s = await run.start()
    expect(s.rows.map((r) => r.status)).toEqual(['passed', 'failed', 'failed'])
    expect(s.rows[1].reason).toBe('1 of 2 tests failed')
    expect(s.rows[2].reason).toBe('1 of 1 test failed')
    expect(s.rows[0].console.map((c) => c.message)).toEqual(['hi'])
    expect(summarize(s).tests).toEqual({ passed: 3, failed: 2, skipped: 0, total: 5 })
    const json = JSON.parse(resultsToJson('C', s))
    expect(json.summary.tests).toEqual({ passed: 3, failed: 2, skipped: 0, total: 5 })
    expect(json.results[1].tests).toEqual([
      { name: 't0', status: 'passed', error: null },
      { name: 't1', status: 'failed', error: 'AssertionError: nope' },
    ])
  })

  it('a pre-request script failure is a failed row with the script error as the reason', async () => {
    const run = new CollectionRun([item('a')], { delayMs: 0, stopOnFailure: false }, {
      execute: async () => ({ ok: false, kind: 'script', error: 'Pre-request script failed (x): Error: nope', scripts: emptyScriptOutput() }),
      cancel: async () => {},
    })
    const s = await run.start()
    expect(s.rows[0]).toMatchObject({ status: 'failed', reason: 'Pre-request script failed (x): Error: nope' })
  })
})

describe('pass/fail classification', () => {
  it('passes 2xx only by default', () => {
    for (const status of [200, 201, 204, 299]) expect(classifyStatus(status).passed).toBe(true)
    for (const status of [100, 301, 302, 304, 399, 400, 404, 500, 503]) expect(classifyStatus(status).passed).toBe(false)
  })
  it('treat3xxAsPass only widens 3xx', () => {
    const opts = { treat3xxAsPass: true }
    expect(classifyStatus(302, opts).passed).toBe(true)
    expect(classifyStatus(304, opts).passed).toBe(true)
    expect(classifyStatus(404, opts).passed).toBe(false)
    expect(classifyStatus(500, opts).passed).toBe(false)
  })

  const runWith = async (status: number, treat3xxAsPass?: boolean) => {
    const run = new CollectionRun([item('a')], { delayMs: 0, stopOnFailure: false, treat3xxAsPass }, { execute: async () => ok(status), cancel: async () => {} })
    return (await run.start()).rows[0]
  }
  it('a 3xx row fails by default with an explanatory reason and keeps its status code', async () => {
    const row = await runWith(302)
    expect(row).toMatchObject({ status: 'failed', statusCode: 302 })
    expect(row.reason).toContain('HTTP 302')
    expect(row.reason).toContain('redirect')
  })
  it('a 3xx row passes with treat3xxAsPass', async () => {
    expect(await runWith(302, true)).toMatchObject({ status: 'passed', statusCode: 302, reason: null })
  })
  it('4xx and 5xx fail even with treat3xxAsPass', async () => {
    expect((await runWith(404, true)).status).toBe('failed')
    expect((await runWith(500, true)).status).toBe('failed')
  })
})
