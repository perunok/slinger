import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SaveQueue } from './saveQueue'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function deferred() {
  let resolve!: () => void, reject!: (e: Error) => void
  const promise = new Promise<void>((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}

describe('SaveQueue', () => {
  it('debounces repeated touches into one save', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const q = new SaveQueue({ save, debounceMs: 600 })
    q.touch('a')
    await vi.advanceTimersByTimeAsync(400)
    q.touch('a')
    await vi.advanceTimersByTimeAsync(400)
    expect(save).not.toHaveBeenCalled()
    expect(q.counts().dirty).toBe(1)
    await vi.advanceTimersByTimeAsync(300)
    expect(save).toHaveBeenCalledTimes(1)
    expect(q.stateOf('a')).toBe('saved')
    expect(q.pending).toBe(0)
  })

  it('flush saves immediately and waits for in-flight saves', async () => {
    const d = deferred()
    const save = vi.fn().mockReturnValue(d.promise)
    const q = new SaveQueue({ save })
    q.touch('a')
    const flushed = q.flush()
    await vi.advanceTimersByTimeAsync(0)
    expect(save).toHaveBeenCalledTimes(1)
    let done = false
    void flushed.then(() => (done = true))
    await vi.advanceTimersByTimeAsync(10)
    expect(done).toBe(false)
    d.resolve()
    expect((await flushed).ok).toBe(true)
  })

  it('serialises saves per key: an edit during a create yields one follow-up, never a parallel create', async () => {
    const first = deferred()
    let ids = 0
    let inFlight = 0
    let maxParallel = 0
    const save = vi.fn(async () => {
      inFlight++
      maxParallel = Math.max(maxParallel, inFlight)
      if (save.mock.calls.length === 1) await first.promise
      ids++
      inFlight--
    })
    const q = new SaveQueue({ save, debounceMs: 100 })
    q.touch('a', { immediate: true })
    await vi.advanceTimersByTimeAsync(0)
    q.touch('a')
    q.touch('a')
    expect(q.counts().dirty).toBe(1)
    first.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(save).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(save).toHaveBeenCalledTimes(2)
    expect(maxParallel).toBe(1)
    expect(ids).toBe(2)
  })

  it('flush retries a previously failed key once and succeeds', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined)
    const q = new SaveQueue({ save, debounceMs: 10 })
    q.touch('a')
    await vi.advanceTimersByTimeAsync(10)
    expect(q.stateOf('a')).toBe('error')
    expect(await q.flush()).toEqual({ ok: true, failed: [] })
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('keeps a failed key in error state until retried', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined)
    const q = new SaveQueue({ save, debounceMs: 10 })
    q.touch('a')
    await vi.advanceTimersByTimeAsync(10)
    expect(q.stateOf('a')).toBe('error')
    expect(q.errorOf('a')).toBe('boom')
    expect(q.counts().errors).toBe(1)
    await q.retry('a')
    expect(q.stateOf('a')).toBe('saved')
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('flush reports keys that still fail', async () => {
    const q = new SaveQueue({ save: vi.fn().mockRejectedValue(new Error('nope')), debounceMs: 10 })
    q.touch('a')
    const p = q.flush()
    await vi.advanceTimersByTimeAsync(0)
    expect(await p).toEqual({ ok: false, failed: ['a'] })
  })

  it('blocked keys are not saved, are reported unsaved, and save once unblocked', async () => {
    let reason: string | null = 'dup'
    const save = vi.fn().mockResolvedValue(undefined)
    const q = new SaveQueue({ save, block: () => reason, debounceMs: 10 })
    q.touch('a')
    await vi.advanceTimersByTimeAsync(10)
    expect(save).not.toHaveBeenCalled()
    expect(q.stateOf('a')).toBe('blocked')
    expect((await Promise.all([q.flush()]))[0].ok).toBe(false)
    reason = null
    q.recheck()
    await vi.advanceTimersByTimeAsync(10)
    expect(save).toHaveBeenCalledTimes(1)
    expect(q.stateOf('a')).toBe('saved')
  })

  it('discard cancels a pending save', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const q = new SaveQueue({ save, debounceMs: 10 })
    q.touch('a')
    q.discard('a')
    await vi.advanceTimersByTimeAsync(50)
    expect(save).not.toHaveBeenCalled()
    expect(q.pending).toBe(0)
  })
})
