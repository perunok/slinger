/** Publish / link / unlink / discard and link-time de-duplication (docs/SYNC_DESIGN.md sections 9, 8.0). */
import type { CloudRole, SyncEntityType } from '../../shared/types'
import type { Db } from '../db/database'
import { newId } from '../lib/ids'
import { envVarSecretKey } from '../services/secrets'
import type { ApplyCtx } from './apply'
import { closeConflict, recordAutoResolved } from './conflictStore'
import { discardLocalChange } from './conflicts'
import { softDeleteRow } from './rows'
import { clearDirty, getEntity, markDirty } from './store'

export interface NewLink {
  workspaceId: string
  apiBaseUrl: string
  remoteWorkspaceId: string
  remoteName: string
  role: CloudRole | null
  clientId: string | null
  checkpoint: number
  /** '' = the initial snapshot download still has to run; null = no download needed (publish). */
  snapshotCursor: string | null
  userId: string | null
  nowS: number
}

export function insertLink(db: Db, l: NewLink): void {
  db.prepare(
    `INSERT INTO cloud_links (workspace_id, api_base_url, remote_workspace_id, sync_client_id, sync_checkpoint, created_at, updated_at,
       remote_name, remote_role, remote_user_id, link_state, auto_sync, read_only, access_state, snapshot_cursor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'initial', 1, ?, 'ok', ?)`,
  ).run(l.workspaceId, l.apiBaseUrl, l.remoteWorkspaceId, l.clientId, l.checkpoint, l.nowS, l.nowS, l.remoteName, l.role, l.userId, l.role === 'viewer' ? 1 : 0, l.snapshotCursor)
}

/** Marks every live row of a workspace dirty (initial upload). Soft-deleted rows are not uploaded. */
export function markAllLiveDirty(db: Db, workspaceId: string): number {
  const sql: Array<[SyncEntityType, string]> = [
    ['collection', 'SELECT id, workspace_id FROM collections WHERE workspace_id = ? AND deleted = 0'],
    ['environment', 'SELECT id, workspace_id FROM environments WHERE workspace_id = ? AND deleted = 0'],
    ['folder', 'SELECT id, workspace_id FROM folders WHERE workspace_id = ? AND deleted = 0'],
    ['request', 'SELECT id, workspace_id FROM requests WHERE workspace_id = ? AND deleted = 0'],
    [
      'environment_variable',
      `SELECT v.id AS id, e.workspace_id AS workspace_id FROM environment_variables v JOIN environments e ON e.id = v.environment_id
       WHERE e.workspace_id = ? AND v.deleted = 0 AND e.deleted = 0`,
    ],
    [
      'collection_version',
      `SELECT v.id AS id, v.workspace_id AS workspace_id FROM collection_versions v JOIN collections c ON c.id = v.collection_id
       WHERE v.workspace_id = ? AND v.deleted = 0 AND c.deleted = 0`,
    ],
  ]
  let n = 0
  for (const [type, query] of sql) {
    for (const r of db.prepare(query).all(workspaceId) as Array<{ id: string; workspace_id: string }>) {
      markDirty(db, type, r.id, r.workspace_id)
      n++
    }
  }
  return n
}

export function hasLiveContent(db: Db, workspaceId: string): boolean {
  for (const t of ['collections', 'environments']) {
    if (db.prepare(`SELECT 1 FROM ${t} WHERE workspace_id = ? AND deleted = 0 LIMIT 1`).get(workspaceId)) return true
  }
  return false
}

/**
 * Discards every local change: dirty or conflicted entities go back to their last synced state (or are
 * deleted when they never reached the cloud); all open conflicts are closed.
 */
export function discardAllPending(ctx: ApplyCtx): number {
  const { db, workspaceId } = ctx
  const entities = new Map<string, { type: SyncEntityType; id: string }>()
  for (const r of db.prepare('SELECT entity_type, entity_id FROM sync_dirty WHERE workspace_id = ?').all(workspaceId) as Array<{ entity_type: SyncEntityType; entity_id: string }>) {
    entities.set(`${r.entity_type}:${r.entity_id}`, { type: r.entity_type, id: r.entity_id })
  }
  for (const r of db.prepare("SELECT entity_type, entity_id FROM sync_entities WHERE workspace_id = ? AND state = 'conflict'").all(workspaceId) as Array<{ entity_type: SyncEntityType; entity_id: string }>) {
    entities.set(`${r.entity_type}:${r.entity_id}`, { type: r.entity_type, id: r.entity_id })
  }
  for (const e of entities.values()) discardLocalChange(ctx, e.type, e.id)
  for (const c of db.prepare("SELECT id FROM sync_conflicts WHERE workspace_id = ? AND status = 'open'").all(workspaceId) as Array<{ id: string }>) {
    closeConflict(db, c.id, ctx.nowS, 'auto_resolved')
  }
  return entities.size
}

/**
 * Environments/variables would clash on the server's unique keys, so link-time merges them by natural key
 * (docs/SYNC_DESIGN.md 9.2 step 5). A local environment with no remote counterpart whose name equals (case-insensitive)
 * a remote environment is folded into it: its variables are matched by key (remote metadata wins; local secret values
 * are kept when the remote has none) or re-parented, then it is dropped. Collections/folders/requests are never matched.
 */
export function dedupeEnvironments(ctx: ApplyCtx): number {
  const { db, workspaceId } = ctx
  const envs = db.prepare('SELECT * FROM environments WHERE workspace_id = ? AND deleted = 0 ORDER BY id').all(workspaceId) as Array<Record<string, string | number | null>>
  const remoteEnvs = envs.filter((e) => (getEntity(db, 'environment', e.id as string)?.remote_version ?? 0) > 0)
  const localOnly = envs.filter((e) => (getEntity(db, 'environment', e.id as string)?.remote_version ?? 0) === 0)
  let merged = 0
  for (const local of localOnly) {
    const remote = remoteEnvs.find((r) => String(r.name).toLowerCase() === String(local.name).toLowerCase())
    if (!remote) continue
    const remoteVars = db.prepare('SELECT * FROM environment_variables WHERE environment_id = ? AND deleted = 0').all(remote.id) as Array<Record<string, string | number | null>>
    const localVars = db.prepare('SELECT * FROM environment_variables WHERE environment_id = ? AND deleted = 0').all(local.id) as Array<Record<string, string | number | null>>
    for (const v of localVars) {
      const w = remoteVars.find((x) => x.key === v.key)
      if (!w) {
        // Re-parent: the variable is uploaded into the remote environment as a new variable.
        db.prepare('UPDATE environment_variables SET environment_id = ?, version = version + 1 WHERE id = ?').run(remote.id, v.id)
        markDirty(db, 'environment_variable', v.id as string, workspaceId)
        continue
      }
      mergeVariable(ctx, v, w)
      softDeleteRow(ctx, 'environment_variable', v.id as string)
      db.prepare('DELETE FROM sync_entities WHERE entity_type = ? AND entity_id = ?').run('environment_variable', v.id)
      clearDirty(db, 'environment_variable', v.id as string)
    }
    softDeleteRow(ctx, 'environment', local.id as string)
    db.prepare('DELETE FROM sync_entities WHERE entity_type = ? AND entity_id = ?').run('environment', local.id)
    clearDirty(db, 'environment', local.id as string)
    merged++
  }
  return merged
}

function mergeVariable(ctx: ApplyCtx, local: Record<string, string | number | null>, remote: Record<string, string | number | null>): void {
  const { db, secrets } = ctx
  const localSecret = local.is_secret === 1
  const remoteSecret = remote.is_secret === 1
  const remoteId = remote.id as string
  if (remoteSecret && remote.secret_missing === 1) {
    // Remote gave no value: keep the local one (secret or plaintext) as this device's value.
    const value = localSecret ? secrets.get(envVarSecretKey(local.id as string)) : ((local.value as string | null) ?? null)
    if (value !== null) {
      secrets.set(envVarSecretKey(remoteId), value)
      db.prepare('UPDATE environment_variables SET secret_missing = 0 WHERE id = ?').run(remoteId)
    }
  } else if (!remoteSecret && !localSecret && (local.value ?? '') !== (remote.value ?? '')) {
    recordAutoResolved(db, ctx.nowS, {
      workspaceId: ctx.workspaceId, type: 'environment_variable', id: remoteId, kind: 'duplicate_key', label: String(remote.key),
      message: `Both this device and the cloud had a variable "${String(remote.key)}" with different values. The cloud value was kept.`,
    })
  }
}

/** Fresh local workspace for "download the cloud workspace". */
export function createLocalWorkspace(db: Db, name: string, nowS: number): string {
  const id = newId()
  db.prepare(
    `INSERT INTO workspaces (id, name, workspace_type, version, deleted, created_at, updated_at) VALUES (?, ?, 'team', 1, 0, ?, ?)`,
  ).run(id, name.slice(0, 200) || 'Cloud workspace', nowS, nowS)
  return id
}
