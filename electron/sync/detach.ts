import type { Db } from '../db/database'

/**
 * Removes every trace of cloud sync for a workspace (link + bookkeeping) in the caller's transaction.
 * Local content and remote data are untouched. Used by unlink and before a linked workspace is deleted
 * locally (so the delete never becomes a delete storm on the remote and never trips the read-only triggers).
 */
export function detachSync(db: Db, workspaceId: string): void {
  for (const table of ['sync_conflicts', 'sync_sent_ops', 'sync_dirty', 'sync_entities', 'cloud_links']) {
    db.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).run(workspaceId)
  }
}
