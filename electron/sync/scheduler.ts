/**
 * Auto-sync timers (docs/SYNC_DESIGN.md 7.5). Fully driven by an injected clock/timers: the real app calls
 * `start()` (one 5 s interval), tests call `tick()` with a fake clock.
 */
import type { Clock, Timers } from '../lib/clock'
import type { SyncEngine } from './engine'
import { hasDirty } from './store'
import type { Db } from '../db/database'

export const POLL_MS = 5_000
export const DEBOUNCE_MS = 1_500
export const FOCUSED_INTERVAL_MS = 60_000
export const BLURRED_INTERVAL_MS = 300_000
export const START_DELAY_MS = 2_000

export class SyncScheduler {
  private focused = true
  private poller: unknown = null
  private startTimer: unknown = null

  constructor(
    private readonly db: Db,
    private readonly engine: SyncEngine,
    private readonly clock: Clock,
    private readonly timers: Timers,
  ) {}

  start(): void {
    if (this.poller) return
    const loop = () => {
      this.tick()
      this.poller = this.timers.setTimeout(loop, POLL_MS)
    }
    this.poller = this.timers.setTimeout(loop, POLL_MS)
    this.startTimer = this.timers.setTimeout(() => this.syncAll(false), START_DELAY_MS)
  }

  stop(): void {
    if (this.poller) this.timers.clearTimeout(this.poller)
    if (this.startTimer) this.timers.clearTimeout(this.startTimer)
    this.poller = this.startTimer = null
    for (const l of this.engine.activeLinks()) {
      const rt = this.engine.rt(l.workspace_id)
      if (rt.debounce) this.timers.clearTimeout(rt.debounce)
      rt.debounce = null
    }
  }

  setFocused(focused: boolean): void {
    const changed = this.focused !== focused
    this.focused = focused
    if (changed && focused) this.syncAll(true)
  }

  /** App start, window focus, power resume, network back: run every auto-sync link now. */
  syncAll(ignoreBackoff: boolean): void {
    for (const l of this.engine.activeLinks()) {
      if (l.auto_sync !== 1 || l.access_state !== 'ok') continue
      const rt = this.engine.rt(l.workspace_id)
      if (!ignoreBackoff && rt.nextRetryAtMs && this.clock.now() < rt.nextRetryAtMs) continue
      void this.engine.runCycle(l.workspace_id)
    }
  }

  /** One poll: dirty rows trigger a debounced cycle, otherwise the periodic full cycle when due. */
  tick(): void {
    const now = this.clock.now()
    for (const l of this.engine.activeLinks()) {
      if (l.auto_sync !== 1 || l.access_state !== 'ok') continue
      const rt = this.engine.rt(l.workspace_id)
      if (rt.running) continue
      if (rt.nextRetryAtMs && now < rt.nextRetryAtMs) continue
      if (hasDirty(this.db, l.workspace_id)) {
        rt.dirtySince ??= now
        if (!rt.debounce && !this.onlyFrozen(l.workspace_id)) {
          rt.debounce = this.timers.setTimeout(() => {
            rt.debounce = null
            rt.dirtySince = null
            void this.engine.runCycle(l.workspace_id)
          }, DEBOUNCE_MS)
        }
        if (!this.onlyFrozen(l.workspace_id)) continue
      } else {
        rt.dirtySince = null
      }
      const interval = this.focused ? FOCUSED_INTERVAL_MS : BLURRED_INTERVAL_MS
      if (now - rt.lastCycleAtMs >= interval) void this.engine.runCycle(l.workspace_id)
    }
  }

  /** Dirty rows that are all frozen in conflicts must not keep triggering cycles. */
  private onlyFrozen(workspaceId: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM sync_dirty d LEFT JOIN sync_entities e ON e.entity_type = d.entity_type AND e.entity_id = d.entity_id
           WHERE d.workspace_id = ? AND COALESCE(e.state, 'synced') != 'conflict' LIMIT 1`,
        )
        .get(workspaceId) === undefined
    )
  }
}
