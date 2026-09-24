import type { HistoryEntry } from '../../shared/types'
import { assertUuid, newId } from '../lib/ids'
import { nowSeconds } from '../lib/text'
import { requireWorkspace, type Db } from './common'

interface HistoryRow {
  id: string
  workspace_id: string
  request_id: string | null
  request_name: string | null
  method: string
  url: string
  status_code: number | null
  ok: number
  error_message: string | null
  duration_ms: number
  created_at: number
}

const toEntry = (r: HistoryRow): HistoryEntry => ({
  id: r.id,
  workspaceId: r.workspace_id,
  requestId: r.request_id,
  requestName: r.request_name,
  method: r.method,
  url: r.url,
  statusCode: r.status_code,
  ok: r.ok === 1,
  errorMessage: r.error_message,
  durationMs: r.duration_ms,
  createdAt: r.created_at,
})

export interface NewHistoryEntry {
  workspaceId: string
  requestId: string | null
  requestName: string | null
  method: string
  url: string
  statusCode: number | null
  ok: boolean
  errorMessage: string | null
  durationMs: number
}

/** Retention cap per workspace; oldest rows are pruned on insert. */
export const HISTORY_LIMIT_PER_WORKSPACE = 1000
export const DEFAULT_HISTORY_PAGE = 100

/**
 * History is an append-only log, not user-authored data: "clear" and "delete entry" remove rows
 * for real (there is nothing to restore), unlike workspaces/collections/requests which soft-delete.
 */
export class HistoryRepository {
  constructor(private readonly db: Db) {}

  record(entry: NewHistoryEntry): HistoryEntry {
    const workspaceId = requireWorkspace(this.db, entry.workspaceId).id
    // A deleted/unknown request must not violate the FK; keep the name for display instead.
    let requestId: string | null = null
    if (entry.requestId) {
      const live = this.db
        .prepare('SELECT id FROM requests WHERE id = ? AND deleted = 0')
        .get(assertUuid(entry.requestId, 'requestId')) as { id: string } | undefined
      requestId = live?.id ?? null
    }
    const id = newId()
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO history (id, workspace_id, request_id, request_name, method, url, status_code, ok,
             error_message, duration_ms, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, workspaceId, requestId, entry.requestName, entry.method, entry.url, entry.statusCode,
          entry.ok ? 1 : 0, entry.errorMessage, Math.max(0, Math.round(entry.durationMs)), nowSeconds())
      this.db
        .prepare(
          `DELETE FROM history WHERE workspace_id = ? AND id NOT IN (
             SELECT id FROM history WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT ?)`,
        )
        .run(workspaceId, workspaceId, HISTORY_LIMIT_PER_WORKSPACE)
    })()
    return toEntry(this.db.prepare('SELECT * FROM history WHERE id = ?').get(id) as HistoryRow)
  }

  list(workspaceId: string, limit = DEFAULT_HISTORY_PAGE): HistoryEntry[] {
    const ws = requireWorkspace(this.db, workspaceId).id
    const n = Math.min(Math.max(Math.trunc(Number.isFinite(limit) ? limit : DEFAULT_HISTORY_PAGE), 1), HISTORY_LIMIT_PER_WORKSPACE)
    return (
      this.db
        .prepare('SELECT * FROM history WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
        .all(ws, n) as HistoryRow[]
    ).map(toEntry)
  }

  clear(workspaceId: string): void {
    const ws = requireWorkspace(this.db, workspaceId).id
    this.db.prepare('DELETE FROM history WHERE workspace_id = ?').run(ws)
  }

  /** Idempotent: deleting an entry that is already gone is not an error. */
  deleteEntry(id: string): void {
    this.db.prepare('DELETE FROM history WHERE id = ?').run(assertUuid(id, 'historyId'))
  }
}
