/**
 * Sync activity: what each sync cycle uploaded and downloaded, and what waits to be uploaded, for the Sync activity view.
 *
 * Runs live in memory only (the latest SYNC_ACTIVITY_RUNS per workspace since Slinger started): nothing is stored or
 * synced. Items are labelled from the local rows (`pathOf`: Collection / Folder / Request; deleted rows keep their names),
 * so they read the same as in the sidebar. The engine reports into the open run of a workspace; every change of a run is
 * pushed to the renderer as a `sync:event` `activity`.
 */
import { SYNC_ACTIVITY_ITEMS, SYNC_ACTIVITY_RUNS, type SyncActivityItem, type SyncEntityType, type SyncRun } from '../../shared/types'
import type { Db } from '../db/database'
import { pathOf } from './conflicts'
import { loadRow, payloadLabel, toWire } from './mapping'
import { changeOps } from './pending'
import { getEntity } from './store'
import type { ChangeLog } from './types'

export interface ActivityDeps {
  db: Db
  emit: (run: SyncRun) => void
  /** Epoch ms. */
  now: () => number
}

/** One entity as a labelled item. `created` decides new vs edited for an upsert. */
export function describeItem(db: Db, type: SyncEntityType, id: string, change: SyncActivityItem['change']): SyncActivityItem {
  const row = loadRow(db, type, id)
  const label = (row ? payloadLabel(type, toWire(type, row, new Set(['collection_variables', 'globals', 'folder_scripts', 'docs']))) : '') || id.slice(0, 8)
  return { entityType: type, entityId: id, path: pathOf(db, type, id, label), change }
}

export class SyncActivity {
  readonly #runs = new Map<string, SyncRun[]>()
  #seq = 0

  constructor(private readonly deps: ActivityDeps) {}

  /** Newest first (copies). */
  list(workspaceId: string): SyncRun[] {
    return [...(this.#runs.get(workspaceId) ?? [])].reverse().map(copy)
  }

  begin(workspaceId: string, trigger: SyncRun['trigger'], initial: boolean): SyncRun {
    const run: SyncRun = {
      id: ++this.#seq,
      workspaceId,
      trigger,
      startedAt: this.deps.now(),
      finishedAt: null,
      result: 'running',
      error: null,
      initial,
      uploaded: [],
      uploadedCount: 0,
      downloaded: [],
      downloadedCount: 0,
      conflicts: 0,
    }
    const runs = this.#runs.get(workspaceId) ?? []
    runs.push(run)
    if (runs.length > SYNC_ACTIVITY_RUNS) runs.splice(0, runs.length - SYNC_ACTIVITY_RUNS)
    this.#runs.set(workspaceId, runs)
    this.#emit(run)
    return run
  }

  /** Changes applied from the cloud (a ChangeLog of `runApply`). An upsert whose cloud version is 1 is new. */
  downloaded(run: SyncRun, changed: ChangeLog): void {
    if (!changed.size) return
    const { db } = this.deps
    for (const c of changed.values()) {
      run.downloadedCount++
      if (run.downloaded.length >= SYNC_ACTIVITY_ITEMS) continue
      const change = c.change === 'delete' ? 'deleted' : run.initial || getEntity(db, c.entityType, c.entityId)?.remote_version === 1 ? 'created' : 'updated'
      run.downloaded.push(describeItem(db, c.entityType, c.entityId, change))
    }
    this.#emit(run)
  }

  /** Operations the cloud accepted. */
  uploaded(run: SyncRun, ops: ReadonlyArray<{ type: SyncEntityType; id: string; change: SyncActivityItem['change'] }>): void {
    if (!ops.length) return
    for (const o of ops) {
      run.uploadedCount++
      if (run.uploaded.length < SYNC_ACTIVITY_ITEMS) run.uploaded.push(describeItem(this.deps.db, o.type, o.id, o.change))
    }
    this.#emit(run)
  }

  conflictsOpened(run: SyncRun, n: number): void {
    if (n <= 0) return
    run.conflicts += n
    this.#emit(run)
  }

  finish(run: SyncRun, error: string | null): void {
    run.finishedAt = this.deps.now()
    run.result = error ? 'error' : 'ok'
    run.error = error
    this.#emit(run)
  }

  #emit(run: SyncRun): void {
    this.deps.emit(copy(run))
  }
}

function copy(run: SyncRun): SyncRun {
  return { ...run, uploaded: [...run.uploaded], downloaded: [...run.downloaded] }
}

/**
 * Local changes waiting to be uploaded: exactly the operations the next push would send (`pendingOps`: not what was created
 * and deleted again, not edits changed back, not the children the cloud removes with their container), labelled, in
 * sidebar-like order.
 */
export function pendingItems(db: Db, workspaceId: string): SyncActivityItem[] {
  return listed(db, changeOps(db, workspaceId).pending)
}

/** Changes kept on this device (not uploaded until the user uploads them again), in the same shape and order. */
export function keptItems(db: Db, workspaceId: string): SyncActivityItem[] {
  return listed(db, changeOps(db, workspaceId).kept)
}

function listed(db: Db, ops: ReturnType<typeof changeOps>['pending']): SyncActivityItem[] {
  const items = ops.map((o) => describeItem(db, o.type, o.id, o.kind))
  items.sort((a, b) => a.path.join('\u0000').localeCompare(b.path.join('\u0000')))
  return items.slice(0, SYNC_ACTIVITY_ITEMS)
}
