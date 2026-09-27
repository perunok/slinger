/**
 * Sync extension features of a link (docs/SYNC_DESIGN.md section 21): what the server supports, intersected with
 * what this client understands, stored in `cloud_links.sync_features` and switched on/off from the `features` of
 * every pull/snapshot answer BEFORE that page is applied.
 */
import type { Db } from '../db/database'
import type { ApplyCtx } from './apply'
import { CLIENT_FEATURES, type Features, type SyncFeature } from './mapping'
import { getLink, markDirty, updateLink } from './store'

/** Effective features of a link (none while unknown). */
export function linkFeatures(db: Db, workspaceId: string): Set<string> {
  return new Set(parseFeatures(getLink(db, workspaceId)?.sync_features ?? null))
}

function parseFeatures(raw: string | null): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** Server features (absent = an older server = none of the extensions) intersected with the client's. */
export function effectiveFeatures(server: readonly string[] | undefined): SyncFeature[] {
  return CLIENT_FEATURES.filter((f) => server?.includes(f) === true)
}

const FIELDS: Partial<Record<SyncFeature, string[]>> = { folder_scripts: ['scripts_json'], docs: ['description', 'description_type'] }

/**
 * Records the server's features for the link of `ctx` and, when they changed, activates/deactivates them in the
 * caller's transaction (applying = 1). Updates `ctx.features` in place. Returns true when something changed.
 */
export function updateLinkFeatures(ctx: ApplyCtx, server: readonly string[] | undefined): boolean {
  const { db, workspaceId } = ctx
  const link = getLink(db, workspaceId)
  if (!link) return false
  const next = effectiveFeatures(server)
  const prev = parseFeatures(link.sync_features)
  const same = link.sync_features !== null && prev.length === next.length && next.every((f) => prev.includes(f))
  if (same) return false
  const readOnly = link.read_only === 1
  for (const f of next) if (!prev.includes(f)) activate(ctx, f, readOnly)
  for (const f of prev) if (!next.includes(f as SyncFeature)) deactivate(ctx, f as SyncFeature)
  updateLink(db, workspaceId, { sync_features: JSON.stringify(next) })
  const mutable = ctx.features as Set<string>
  mutable.clear()
  for (const f of next) mutable.add(f)
  return true
}

/**
 * A feature appears (server upgraded, or first contact after this app update):
 * - collection/folder fields: stored merge bases (and open conflicts' base/remote copies) get the field as `null`,
 *   which is what an upgraded server holds for rows written before it knew the field; rows with a non-null local value
 *   are marked dirty, so they are uploaded (or merged against what another device uploaded meanwhile);
 * - resource types: every live row is marked dirty (uploaded; clashes with other devices' rows fold or rename).
 * A read-only link only adjusts the bases: it cannot upload anything.
 */
function activate(ctx: ApplyCtx, feature: SyncFeature, readOnly: boolean): void {
  const { db, workspaceId } = ctx
  const fields = FIELDS[feature]
  if (fields) {
    for (const f of fields) {
      db.prepare(
        `UPDATE sync_entities SET base_payload = json_set(base_payload, '$.${f}', NULL)
         WHERE workspace_id = ? AND entity_type IN ('collection', 'folder') AND base_payload IS NOT NULL AND json_type(base_payload, '$.${f}') IS NULL`,
      ).run(workspaceId)
      for (const col of ['base_json', 'remote_json']) {
        db.prepare(
          `UPDATE sync_conflicts SET ${col} = json_set(${col}, '$.${f}', NULL)
           WHERE workspace_id = ? AND status = 'open' AND entity_type IN ('collection', 'folder') AND ${col} IS NOT NULL AND json_type(${col}, '$.${f}') IS NULL`,
        ).run(workspaceId)
      }
    }
    if (readOnly) return
    const nonNull = fields.map((f) => `${f} IS NOT NULL`).join(' OR ')
    for (const [type, table] of [['collection', 'collections'], ['folder', 'folders']] as const) {
      for (const r of db.prepare(`SELECT id FROM ${table} WHERE workspace_id = ? AND deleted = 0 AND (${nonNull})`).all(workspaceId) as Array<{ id: string }>) {
        markDirty(db, type, r.id, workspaceId)
      }
    }
    return
  }
  if (readOnly) return
  const rows =
    feature === 'collection_variables'
      ? (db
          .prepare(
            `SELECT v.id FROM collection_variables v JOIN collections c ON c.id = v.collection_id
             WHERE v.workspace_id = ? AND v.deleted = 0 AND c.deleted = 0`,
          )
          .all(workspaceId) as Array<{ id: string }>)
      : (db.prepare('SELECT id FROM global_variables WHERE workspace_id = ? AND deleted = 0').all(workspaceId) as Array<{ id: string }>)
  const type = feature === 'collection_variables' ? 'collection_variable' : 'global_variable'
  for (const r of rows) markDirty(db, type, r.id, workspaceId)
}

/** A feature disappears (server downgraded): its fields leave the stored bases; nothing of its types is pushed any more. */
function deactivate(ctx: ApplyCtx, feature: SyncFeature): void {
  for (const f of FIELDS[feature] ?? []) {
    ctx.db
      .prepare(`UPDATE sync_entities SET base_payload = json_remove(base_payload, '$.${f}') WHERE workspace_id = ? AND entity_type IN ('collection', 'folder') AND base_payload IS NOT NULL`)
      .run(ctx.workspaceId)
  }
}

export type { Features }
