import { describe, expect, it, vi } from 'vitest'
import type { ApiFolder, ApiRequest, HttpResponseData } from '../../../shared/types'
import type { ExecuteOutcome } from '../requests/execute'
import { CollectionRun, collectRunItems, resultsToJson, summarize, type RunItem, type RunState } from './runner'

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
const ok = (status = 200, body: string | null = 'ok'): ExecuteOutcome => ({ ok: true, response: response(status, body), warnings: [], runId: 'r', elapsedMs: 5 })

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
      c: { ok: false, kind: 'failed', error: 'connect ECONNREFUSED' },
      d: { ok: false, kind: 'unresolved', error: 'Unresolved variables', unresolved: ['token'] },
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
        it.id === 'a' ? ok(200, big) : { ok: true, response: { ...response(200, null), bodyBase64: 'AAEC', bodyByteLength: 3 }, warnings: [], runId: 'r', elapsedMs: 1 },
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
      gate.resolve({ ok: false, kind: 'cancelled', error: 'Request cancelled' })
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
    const cancel = vi.fn(async () => gate.resolve({ ok: false, kind: 'cancelled', error: 'x' }))
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
    expect(JSON.parse(resultsToJson('C', updates.at(-1)!)).summary).toEqual({ passed: 2, failed: 0, skipped: 0, total: 2 })
  })
})
