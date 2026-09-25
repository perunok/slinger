import type { Workspace } from '../../shared/types'
import { detachSync } from '../sync/detach'
import { newId } from '../lib/ids'
import { cleanName, nowSeconds } from '../lib/text'
import type { SecretStore } from '../services/secrets'
import { toWorkspace, requireWorkspace, type Db, type WorkspaceRow } from './common'

export class WorkspaceRepository {
  constructor(
    private readonly db: Db,
    private readonly secrets?: SecretStore,
  ) {}

  list(): Workspace[] {
    return (
      this.db
        .prepare('SELECT * FROM workspaces WHERE deleted = 0 ORDER BY created_at, id')
        .all() as WorkspaceRow[]
    ).map(toWorkspace)
  }

  get(id: string): Workspace {
    return toWorkspace(requireWorkspace(this.db, id))
  }

  create(name: string): Workspace {
    const clean = cleanName(name, 'workspace name')
    const now = nowSeconds()
    const id = newId()
    this.db
      .prepare(
        `INSERT INTO workspaces (id, name, workspace_type, version, deleted, created_at, updated_at)
         VALUES (?, ?, 'personal', 1, 0, ?, ?)`,
      )
      .run(id, clean, now, now)
    return this.get(id)
  }

  rename(id: string, name: string): Workspace {
    requireWorkspace(this.db, id)
    const clean = cleanName(name, 'workspace name')
    this.db
      .prepare('UPDATE workspaces SET name = ?, updated_at = ?, version = version + 1 WHERE id = ? AND deleted = 0')
      .run(clean, nowSeconds(), id.toLowerCase())
    return this.get(id)
  }

  /**
   * Soft-deletes the workspace and everything under it in one transaction.
   * Keychain secrets of the deleted environments are purged after the transaction commits.
   */
  softDelete(id: string): void {
    requireWorkspace(this.db, id)
    const wid = id.toLowerCase()
    const now = nowSeconds()
    const secretRefs = this.db.transaction(() => {
      // A linked workspace is detached first: deleting locally never deletes remote data, and the
      // read-only triggers must not block the delete.
      detachSync(this.db, wid)
      const secretRefs = (
        this.db
          .prepare(
            `SELECT v.secret_ref FROM environment_variables v
             JOIN environments e ON e.id = v.environment_id
             WHERE e.workspace_id = ? AND v.deleted = 0 AND v.secret_ref IS NOT NULL`,
          )
          .all(wid) as Array<{ secret_ref: string }>
      ).map((r) => r.secret_ref)

      const bump = (table: string, where: string) =>
        this.db
          .prepare(
            `UPDATE ${table} SET deleted = 1, updated_at = ?, version = version + 1 WHERE ${where} AND deleted = 0`,
          )
          .run(now, wid)
      bump('workspaces', 'id = ?')
      bump('collections', 'workspace_id = ?')
      bump('folders', 'workspace_id = ?')
      bump('requests', 'workspace_id = ?')
      bump('environments', 'workspace_id = ?')
      this.db
        .prepare('UPDATE collection_versions SET deleted = 1 WHERE workspace_id = ? AND deleted = 0')
        .run(wid)
      this.db
        .prepare(
          `UPDATE environment_variables SET deleted = 1, secret_ref = NULL, updated_at = ?, version = version + 1
           WHERE deleted = 0 AND environment_id IN (SELECT id FROM environments WHERE workspace_id = ?)`,
        )
        .run(now, wid)
      return secretRefs
    })()
    for (const ref of secretRefs) {
      try {
        this.secrets?.delete(ref)
      } catch (err) {
        console.warn(`[slinger] could not delete keychain entry ${ref}:`, err instanceof Error ? err.message : err)
      }
    }
  }

  /** First-launch bootstrap: guarantee at least one live workspace. */
  ensureDefault(): Workspace {
    const existing = this.list()[0]
    return existing ?? this.create('Personal')
  }
}
