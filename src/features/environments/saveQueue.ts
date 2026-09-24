import { errorInfo } from '../../lib/ipc'
/**
 * Debounced, per-key serialised autosave queue.
 *  - at most one save per key is in flight; edits made meanwhile trigger exactly one follow-up save
 *    (so a create is never issued twice: the follow-up runs after the first one recorded the id)
 *  - failures are retained (state 'error') until retried, edited again or flushed
 *  - `block(key)` returning a reason keeps the key 'blocked' (unsaved) without calling save
 */
export type KeyState = 'dirty' | 'saving' | 'error' | 'blocked' | 'saved'

export interface SaveQueueOptions {
  save: (key: string) => Promise<void>
  block?: (key: string) => string | null
  debounceMs?: number
  onchange?: () => void
}

interface Entry {
  state: KeyState
  error?: string
  reason?: string
  timer?: ReturnType<typeof setTimeout>
  dirtyAgain: boolean
  inflight?: Promise<void>
}

export interface FlushResult {
  ok: boolean
  failed: string[]
}

const msg = (e: unknown): string => (errorInfo(e).message || 'Save failed')

export class SaveQueue {
  #entries = new Map<string, Entry>()
  #opts: SaveQueueOptions
  #debounce: number

  constructor(opts: SaveQueueOptions) {
    this.#opts = opts
    this.#debounce = opts.debounceMs ?? 600
  }

  stateOf(key: string): KeyState | undefined {
    return this.#entries.get(key)?.state
  }
  errorOf(key: string): string | undefined {
    return this.#entries.get(key)?.error
  }
  counts() {
    const c = { dirty: 0, saving: 0, errors: 0, blocked: 0 }
    for (const e of this.#entries.values()) {
      if (e.state === 'dirty') c.dirty++
      else if (e.state === 'saving') e.dirtyAgain ? c.dirty++ : c.saving++
      else if (e.state === 'error') c.errors++
      else if (e.state === 'blocked') c.blocked++
    }
    return c
  }
  get pending(): number {
    const c = this.counts()
    return c.dirty + c.saving + c.errors + c.blocked
  }

  /** Marks `key` changed and (re)starts its debounce; `immediate` saves on the next tick. */
  touch(key: string, opts: { immediate?: boolean } = {}): void {
    let e = this.#entries.get(key)
    if (!e) this.#entries.set(key, (e = { state: 'dirty', dirtyAgain: false }))
    if (e.inflight) {
      e.dirtyAgain = true
      this.#opts.onchange?.()
      return
    }
    e.state = 'dirty'
    e.error = undefined
    clearTimeout(e.timer)
    e.timer = setTimeout(() => void this.#run(key), opts.immediate ? 0 : this.#debounce)
    this.#opts.onchange?.()
  }

  /** Forget a key (row removed / blank again). An in-flight save still completes. */
  discard(key: string): void {
    const e = this.#entries.get(key)
    if (!e) return
    clearTimeout(e.timer)
    this.#entries.delete(key)
    this.#opts.onchange?.()
  }

  discardAll(): void {
    for (const k of [...this.#entries.keys()]) this.discard(k)
  }

  /** Re-evaluates blocked keys (call after an edit that may have resolved a conflict). */
  recheck(): void {
    for (const [k, e] of this.#entries) if (e.state === 'blocked') this.touch(k)
  }

  retry(key: string): Promise<void> {
    const e = this.#entries.get(key)
    if (!e) return Promise.resolve()
    clearTimeout(e.timer)
    return this.#run(key)
  }

  blockReason(key: string): string | undefined {
    return this.#entries.get(key)?.reason
  }

  async #run(key: string): Promise<void> {
    const e = this.#entries.get(key)
    if (!e) return
    if (e.inflight) {
      e.dirtyAgain = true
      return e.inflight
    }
    clearTimeout(e.timer)
    const reason = this.#opts.block?.(key)
    if (reason) {
      e.state = 'blocked'
      e.reason = reason
      this.#opts.onchange?.()
      return
    }
    e.reason = undefined
    e.state = 'saving'
    e.dirtyAgain = false
    this.#opts.onchange?.()
    const p = (async () => {
      let failure: string | undefined
      try {
        await this.#opts.save(key)
      } catch (err) {
        failure = msg(err)
      }
      e.inflight = undefined
      if (this.#entries.get(key) !== e) return // discarded meanwhile
      if (e.dirtyAgain) {
        e.dirtyAgain = false
        e.state = 'dirty'
        e.timer = setTimeout(() => void this.#run(key), this.#debounce)
      } else if (failure !== undefined) {
        e.state = 'error'
        e.error = failure
      } else {
        e.state = 'saved'
        e.error = undefined
      }
      this.#opts.onchange?.()
    })()
    e.inflight = p
    return p
  }

  /** Saves everything pending now and waits. Failed/blocked keys are retried once. */
  async flush(): Promise<FlushResult> {
    for (let round = 0; round < 8; round++) {
      const keys = [...this.#entries].filter(([, e]) => e.state === 'dirty' || e.state === 'saving' || (round === 0 && (e.state === 'error' || e.state === 'blocked'))).map(([k]) => k)
      if (keys.length === 0) break
      await Promise.all(keys.map((k) => this.#settle(k)))
    }
    const failed = [...this.#entries].filter(([, e]) => e.state === 'error' || e.state === 'blocked' || e.state === 'dirty').map(([k]) => k)
    return { ok: failed.length === 0, failed }
  }

  async #settle(key: string): Promise<void> {
    const e = this.#entries.get(key)
    if (!e) return
    if (e.inflight) await e.inflight
    const now = this.#entries.get(key)
    if (now && now.state !== 'saved' && !now.inflight) await this.#run(key)
  }

  dispose(): void {
    for (const e of this.#entries.values()) clearTimeout(e.timer)
  }
}
