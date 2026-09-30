import { describe, expect, it, vi } from 'vitest'
import type { ApiFolder, ApiRequest, HttpResponseData } from '../../../shared/types'
import type { ExecuteOutcome } from '../requests/execute'
import { emptyScriptOutput } from '../../lib/scripts'
import { classifyStatus, CollectionRun, collectRunItems, DETAIL_ROWS, findRunItem, MAX_RUN_REQUESTS, resultsToJson, summarize, type ExecHooks, type RunItem, type RunState } from './runner'

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

describe('setNextRequest', () => {
  const next = (target: string | null): ExecuteOutcome => ({ ...ok(), scripts: { ...emptyScriptOutput(), nextRequest: target } })
  const runPlan = (ids: string[], plan: (id: string, count: number) => ExecuteOutcome, opts = { delayMs: 0, stopOnFailure: false }) => {
    const order: string[] = []
    const run = new CollectionRun(ids.map(item), opts, {
      execute: async (it) => {
        order.push(it.id)
        return plan(it.id, order.filter((x) => x === it.id).length)
      },
      cancel: async () => {},
    })
    return { order, run }
  }

  it('finds the target by id first, then by the first request with that name', () => {
    const items = [{ ...item('a'), name: 'Login' }, { ...item('b'), name: 'Login' }, { ...item('c'), name: 'a' }]
    expect(findRunItem(items, 'Login')).toBe(0)
    expect(findRunItem(items, 'a')).toBe(0)
    expect(findRunItem(items, 'c')).toBe(2)
    expect(findRunItem(items, 'nope')).toBe(-1)
  })

  it('jumps forward and lists the requests jumped over as skipped', async () => {
    const { order, run } = runPlan(['a', 'b', 'c', 'd'], (id) => (id === 'a' ? next('c') : ok()))
    const state = await run.start()
    expect(order).toEqual(['a', 'c', 'd'])
    expect(state.rows.map((r) => [r.item.id, r.status])).toEqual([['a', 'passed'], ['b', 'skipped'], ['c', 'passed'], ['d', 'passed']])
    expect(state.rows[1].reason).toBe('Skipped by setNextRequest("c")')
    expect(summarize(state)).toMatchObject({ passed: 3, skipped: 1, total: 4 })
  })

  it('jumps back to run requests again (a loop), with a unique key per row', async () => {
    // b loops back to a twice, then lets the run continue.
    const { order, run } = runPlan(['a', 'b', 'c'], (id, n) => (id === 'b' && n < 3 ? next('a') : ok()))
    const state = await run.start()
    expect(order).toEqual(['a', 'b', 'a', 'b', 'a', 'b', 'c'])
    expect(state.rows.map((r) => r.status).every((s) => s === 'passed')).toBe(true)
    expect(new Set(state.rows.map((r) => r.key)).size).toBe(state.rows.length)
    expect(state.completed).toBe(7)
  })

  it('null ends the run; the rest is skipped with the reason', async () => {
    const { order, run } = runPlan(['a', 'b', 'c'], (id) => (id === 'a' ? next(null) : ok()))
    const state = await run.start()
    expect(order).toEqual(['a'])
    expect(state.rows.slice(1).map((r) => [r.status, r.reason])).toEqual([
      ['skipped', 'Not run: the run was ended by setNextRequest(null)'],
      ['skipped', 'Not run: the run was ended by setNextRequest(null)'],
    ])
  })

  it('an unknown name ends the run', async () => {
    const { order, run } = runPlan(['a', 'b'], (id) => (id === 'a' ? next('Nope') : ok()))
    const state = await run.start()
    expect(order).toEqual(['a'])
    expect(state.rows[1].reason).toBe('Not run: setNextRequest("Nope") names no request of this run')
  })

  it('an endless loop stops after MAX_RUN_REQUESTS requests', async () => {
    const { order, run } = runPlan(['a', 'b'], () => next('a'))
    const state = await run.start()
    expect(order).toHaveLength(MAX_RUN_REQUESTS)
    expect(state.rows.at(-1)?.status).toBe('skipped')
    expect(state.rows.at(-1)?.reason).toContain(`stopped after ${MAX_RUN_REQUESTS} requests`)
  })

  it('stop on failure wins over a jump', async () => {
    const { order, run } = runPlan(['a', 'b', 'c'], (id) => (id === 'a' ? { ...next('c'), response: response(500) } : ok()), { delayMs: 0, stopOnFailure: true })
    const state = await run.start()
    expect(order).toEqual(['a'])
    expect(state.rows.map((r) => r.status)).toEqual(['failed', 'skipped', 'skipped'])
  })
})

describe('iterations and data-driven runs', () => {
  const data = [{ name: 'Acme' }, { name: 'Globex' }, { name: 'Initech' }]
  const next = (target: string | null): ExecuteOutcome => ({ ...ok(), scripts: { ...emptyScriptOutput(), nextRequest: target } })
  function iterRun(ids: string[], opts: { iterations: number; data?: typeof data; stopOnFailure?: boolean }, plan: (id: string, h: ExecHooks) => ExecuteOutcome = () => ok()) {
    const calls: Array<[string, number, unknown]> = []
    const updates: RunState[] = []
    const run = new CollectionRun(ids.map(item), { delayMs: 0, stopOnFailure: opts.stopOnFailure ?? false, iterations: opts.iterations, data: opts.data }, {
      execute: async (it, hooks) => {
        calls.push([it.id, hooks.iteration, hooks.data])
        return plan(it.id, hooks)
      },
      cancel: async () => {},
      onUpdate: (st) => updates.push(st),
    })
    return { run, calls, updates }
  }

  it('runs the selection once per iteration, with each iteration number and data row', async () => {
    const { run, calls, updates } = iterRun(['a', 'b'], { iterations: 3, data })
    expect(run.state.rows.map((r) => [r.item.id, r.iteration])).toEqual([['a', 0], ['b', 0], ['a', 1], ['b', 1], ['a', 2], ['b', 2]])
    const state = await run.start()
    expect(calls).toEqual([
      ['a', 0, data[0]], ['b', 0, data[0]],
      ['a', 1, data[1]], ['b', 1, data[1]],
      ['a', 2, data[2]], ['b', 2, data[2]],
    ])
    expect(summarize(state)).toMatchObject({ passed: 6, total: 6, iterations: 3 })
    expect(new Set(state.rows.map((r) => r.key)).size).toBe(6)
    // The state says which iteration is going on.
    expect([...new Set(updates.filter((u) => u.phase === 'running').map((u) => u.currentIteration))]).toEqual([0, 1, 2])
  })

  it('plain iterations (no data file) pass no data', async () => {
    const { run, calls } = iterRun(['a'], { iterations: 2 })
    await run.start()
    expect(calls).toEqual([['a', 0, null], ['a', 1, null]])
  })

  it('setNextRequest(null) ends only the current iteration', async () => {
    const { run, calls } = iterRun(['a', 'b'], { iterations: 2 }, (id, h) => (id === 'a' && h.iteration === 0 ? next(null) : ok()))
    const state = await run.start()
    expect(calls.map(([id, it]) => `${id}${it}`)).toEqual(['a0', 'a1', 'b1'])
    expect(state.rows.map((r) => [r.item.id, r.iteration, r.status])).toEqual([['a', 0, 'passed'], ['b', 0, 'skipped'], ['a', 1, 'passed'], ['b', 1, 'passed']])
    expect(state.rows[1]!.reason).toBe('Not run: setNextRequest(null) ended this iteration')
  })

  it('jumps stay inside their iteration', async () => {
    const { run, calls } = iterRun(['a', 'b', 'c'], { iterations: 2 }, (id, h) => (id === 'a' && h.iteration === 0 ? next('c') : ok()))
    const state = await run.start()
    expect(calls.map(([id, it]) => `${id}${it}`)).toEqual(['a0', 'c0', 'a1', 'b1', 'c1'])
    expect(state.rows.map((r) => `${r.item.id}${r.iteration}:${r.status}`)).toEqual(['a0:passed', 'b0:skipped', 'c0:passed', 'a1:passed', 'b1:passed', 'c1:passed'])
  })

  it('an unknown target ends the iteration and says so', async () => {
    const { run } = iterRun(['a', 'b'], { iterations: 2 }, (id, h) => (id === 'a' && h.iteration === 1 ? next('Nope') : ok()))
    const state = await run.start()
    expect(state.rows.map((r) => r.status)).toEqual(['passed', 'passed', 'passed', 'skipped'])
    expect(state.rows[3]!.reason).toBe('Not run: setNextRequest("Nope") names no request of this run (this iteration ended)')
  })

  it('stop on first failure stops every remaining iteration', async () => {
    const { run, calls } = iterRun(['a', 'b'], { iterations: 3, stopOnFailure: true }, (id, h) => (id === 'b' && h.iteration === 1 ? ok(500) : ok()))
    const state = await run.start()
    expect(calls.map(([id, it]) => `${id}${it}`)).toEqual(['a0', 'b0', 'a1', 'b1'])
    expect(state.rows.slice(4).map((r) => [r.status, r.reason])).toEqual([
      ['skipped', 'Skipped: run stopped after a failure'],
      ['skipped', 'Skipped: run stopped after a failure'],
    ])
  })

  it(`runs of more than ${DETAIL_ROWS} requests keep headers and bodies only for failures`, async () => {
    const { run } = iterRun(['a'], { iterations: DETAIL_ROWS + 1 }, (_id, h) => (h.iteration === 5 ? ok(500, 'boom') : ok(200, 'fine')))
    const state = await run.start()
    expect(state.rows[0]).toMatchObject({ status: 'passed', statusCode: 200, headers: [], bodyPreview: null, detailsDropped: true })
    expect(state.rows[5]).toMatchObject({ status: 'failed', bodyPreview: 'boom', headers: [{ key: 'A', value: 'b' }] })
    expect(state.rows[5]!.detailsDropped).toBeUndefined()
    // Smaller runs keep everything.
    const small = await iterRun(['a'], { iterations: 2 }).run.start()
    expect(small.rows[0]).toMatchObject({ bodyPreview: 'ok', headers: [{ key: 'A', value: 'b' }] })
  })

  it('the JSON export has the iterations, each result\'s iteration and the data rows that ran', async () => {
    const { run } = iterRun(['a'], { iterations: 2, data })
    const state = await run.start()
    const json = JSON.parse(resultsToJson('C', state, data))
    expect(json.iterations).toBe(2)
    expect(json.data).toEqual([data[0], data[1]])
    expect(json.results.map((r: { iteration: number; name: string }) => [r.iteration, r.name])).toEqual([[1, 'a'], [2, 'a']])
  })
})
