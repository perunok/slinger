/** Persistence of `sync_conflicts` rows (create/refresh/close). Display shaping and resolution live in conflicts.ts. */
import type { SyncConflictKind, SyncEntityType } from '../../shared/types'
import type { Db } from '../db/database'
import { newId } from '../lib/ids'
import { canonicalJson } from './mapping'
import type { Payload } from './types'

export interface ConflictRow {
  id: string
  workspace_id: string
  entity_type: SyncEntityType
  entity_id: string
  kind: SyncConflictKind
  groups: string
  base_json: string | null
  local_json: string | null
  remote_json: string | null
  remote_version: number
  label: string
  message: string
  status: 'open' | 'resolved' | 'auto_resolved'
  resolution: string | null
  created_at: number
  resolved_at: number | null
}

export interface ConflictInput {
  workspaceId: string
  type: SyncEntityType
  id: string
  kind: SyncConflictKind
  groups?: string[]
  base?: Payload | null
  local?: Payload | null
  remote?: Payload | null
  remoteVersion?: number
  label: string
  message?: string
}

const json = (p: Payload | null | undefined): string | null => (p == null ? null : canonicalJson(p))

export function findOpenConflict(db: Db, type: SyncEntityType, id: string): ConflictRow | undefined {
  return db.prepare("SELECT * FROM sync_conflicts WHERE entity_type = ? AND entity_id = ? AND status = 'open'").get(type, id) as
    | ConflictRow
    | undefined
}

export function getConflict(db: Db, id: string): ConflictRow | undefined {
  return db.prepare('SELECT * FROM sync_conflicts WHERE id = ?').get(id) as ConflictRow | undefined
}

/** Opens a conflict, or refreshes the already open one of the same entity in place (id and created_at are kept). */
export function upsertOpenConflict(db: Db, nowS: number, c: ConflictInput): ConflictRow {
  const existing = findOpenConflict(db, c.type, c.id)
  const values = {
    kind: c.kind,
    groups: JSON.stringify(c.groups ?? []),
    base_json: json(c.base),
    local_json: json(c.local),
    remote_json: json(c.remote),
    remote_version: c.remoteVersion ?? 0,
    label: c.label,
    message: c.message ?? '',
  }
  if (existing) {
    db.prepare(
      `UPDATE sync_conflicts SET kind = @kind, groups = @groups, base_json = @base_json, local_json = @local_json,
         remote_json = @remote_json, remote_version = @remote_version, label = @label, message = @message WHERE id = @id`,
    ).run({ ...values, id: existing.id })
    return getConflict(db, existing.id)!
  }
  const id = newId()
  db.prepare(
    `INSERT INTO sync_conflicts (id, workspace_id, entity_type, entity_id, kind, groups, base_json, local_json, remote_json,
       remote_version, label, message, status, created_at)
     VALUES (@id, @workspace_id, @entity_type, @entity_id, @kind, @groups, @base_json, @local_json, @remote_json,
       @remote_version, @label, @message, 'open', @created_at)`,
  ).run({ ...values, id, workspace_id: c.workspaceId, entity_type: c.type, entity_id: c.id, created_at: nowS })
  return getConflict(db, id)!
}

/** Records an informational, already-resolved conflict (auto-resolved duplicate keys, undone folder moves). */
export function recordAutoResolved(db: Db, nowS: number, c: ConflictInput, resolution: string | null = null): void {
  db.prepare(
    `INSERT INTO sync_conflicts (id, workspace_id, entity_type, entity_id, kind, groups, base_json, local_json, remote_json,
       remote_version, label, message, status, resolution, created_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto_resolved', ?, ?, ?)`,
  ).run(newId(), c.workspaceId, c.type, c.id, c.kind, JSON.stringify(c.groups ?? []), json(c.base), json(c.local), json(c.remote),
    c.remoteVersion ?? 0, c.label, c.message ?? '', resolution, nowS, nowS)
}

export function closeConflict(
  db: Db,
  conflictId: string,
  nowS: number,
  status: 'resolved' | 'auto_resolved',
  resolution: string | null = null,
): void {
  db.prepare("UPDATE sync_conflicts SET status = ?, resolution = ?, resolved_at = ? WHERE id = ? AND status = 'open'").run(
    status,
    resolution,
    nowS,
    conflictId,
  )
}

export function closeOpenConflictOf(db: Db, type: SyncEntityType, id: string, nowS: number, status: 'resolved' | 'auto_resolved' = 'auto_resolved'): void {
  const c = findOpenConflict(db, type, id)
  if (c) closeConflict(db, c.id, nowS, status)
}
