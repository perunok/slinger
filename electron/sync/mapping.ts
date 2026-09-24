/**
 * Local row <-> wire payload mapping, field groups, canonical JSON and pre-send limits
 * (docs/SYNC_DESIGN.md sections 3 and 6). Pure apart from `loadRow`.
 */
import type { SyncConflictGroup, SyncEntityType } from '../../shared/types'
import type { Db } from '../db/database'
import type { Payload } from './types'

export type GroupName = SyncConflictGroup['group']
export type AnyRow = Record<string, string | number | null>

export const TABLE: Record<SyncEntityType, string> = {
  collection: 'collections',
  folder: 'folders',
  request: 'requests',
  environment: 'environments',
  environment_variable: 'environment_variables',
  collection_version: 'collection_versions',
}

/** Field groups per entity type: the unit of 3-way merging (design section 6). */
export const GROUPS: Record<SyncEntityType, Partial<Record<GroupName, string[]>>> = {
  collection: { name: ['name'] },
  folder: { name: ['name'], location: ['collection_id', 'parent_folder_id'], order: ['sort_order'] },
  request: {
    content: ['name', 'method', 'url', 'document_json'],
    location: ['collection_id', 'folder_id'],
    order: ['sort_order'],
  },
  environment: { name: ['name'] },
  environment_variable: { key: ['key'], value: ['value', 'is_secret'] },
  collection_version: {},
}

export const GROUP_LABELS: Record<GroupName, string> = {
  name: 'Name',
  content: 'Request',
  location: 'Location',
  order: 'Order',
  key: 'Key',
  value: 'Value',
}

/** Server-side caps the engine enforces BEFORE sending (design section 3). */
export const LIMITS = {
  documentJsonBytes: 900_000,
  /** Server cap for collection/folder/environment names (request names: `requestNameChars`); longer ones are quarantined, never truncated. */
  nameChars: 200,
  requestNameChars: 500,
  urlChars: 8192,
  variableKeyChars: 128,
  variableValueChars: 65_536,
  snapshotJsonBytes: 8_000_000,
} as const
export const VARIABLE_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/

export function loadRow(db: Db, type: SyncEntityType, id: string): AnyRow | undefined {
  return db.prepare(`SELECT * FROM ${TABLE[type]} WHERE id = ?`).get(id) as AnyRow | undefined
}

/** Workspace that owns the row (variables resolve through their environment). */
export function workspaceIdOfRow(db: Db, type: SyncEntityType, row: AnyRow): string | null {
  if (type === 'environment_variable') {
    const env = db.prepare('SELECT workspace_id FROM environments WHERE id = ?').get(row.environment_id) as
      | { workspace_id: string }
      | undefined
    return env?.workspace_id ?? null
  }
  return row.workspace_id as string
}

const iso = (seconds: number): string => new Date(seconds * 1000).toISOString()

/** Local row -> wire payload. A secret variable never carries a value. */
export function toWire(type: SyncEntityType, row: AnyRow): Payload {
  switch (type) {
    case 'collection':
    case 'environment':
      return { name: row.name }
    case 'folder':
      return {
        collection_id: row.collection_id,
        parent_folder_id: row.parent_folder_id ?? null,
        name: row.name,
        sort_order: row.sort_order,
      }
    case 'request':
      return {
        collection_id: row.collection_id,
        folder_id: row.folder_id ?? null,
        name: row.name,
        method: row.method,
        url: row.url,
        document_json: row.document_json,
        sort_order: row.sort_order,
      }
    case 'environment_variable': {
      const secret = row.is_secret === 1
      return {
        environment_id: row.environment_id,
        key: row.key,
        value: secret ? null : (row.value ?? ''),
        is_secret: secret,
      }
    }
    case 'collection_version':
      return {
        collection_id: row.collection_id,
        semver: row.version,
        notes: row.notes ?? null,
        snapshot_json: row.snapshot_json,
        folder_count: row.folder_count,
        request_count: row.request_count,
        created_at: iso(row.created_at as number),
      }
  }
}

/** Deterministic JSON: object keys sorted recursively, `null` preserved. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as object).sort()) out[k] = sortKeys((value as Record<string, unknown>)[k])
    return out
  }
  return value
}

export const parsePayload = (json: string | null): Payload | null => (json == null ? null : (JSON.parse(json) as Payload))

export function samePayload(a: Payload | null, b: Payload | null): boolean {
  if (a === null || b === null) return a === b
  return canonicalJson(a) === canonicalJson(b)
}

/** Best display label for an entity payload. */
export function payloadLabel(type: SyncEntityType, payload: Payload | null): string {
  if (!payload) return ''
  if (type === 'environment_variable') return String(payload.key ?? '')
  if (type === 'collection_version') return String(payload.semver ?? '')
  return String(payload.name ?? '')
}

/** null when the payload can be sent; otherwise a human-readable reason it never can (quarantine). */
export function checkLimits(type: SyncEntityType, payload: Payload): string | null {
  const bytes = (s: unknown) => (typeof s === 'string' ? Buffer.byteLength(s, 'utf8') : 0)
  const nameMax = type === 'request' ? LIMITS.requestNameChars : LIMITS.nameChars
  if ('name' in payload && typeof payload.name === 'string' && payload.name.trim().length > nameMax) {
    return `The name is ${payload.name.length} characters; the cloud accepts at most ${nameMax}. Shorten it to sync this item.`
  }
  if (type === 'request' && typeof payload.url === 'string' && payload.url.length > LIMITS.urlChars) {
    return `The URL is ${payload.url.length} characters; the cloud accepts at most ${LIMITS.urlChars}. Shorten it to sync this request.`
  }
  if (type === 'request' && bytes(payload.document_json) > LIMITS.documentJsonBytes) {
    return `The request is ${Math.round(bytes(payload.document_json) / 1000)} KB; the cloud accepts at most ${LIMITS.documentJsonBytes / 1000} KB per request. Reduce its body or headers to sync it.`
  }
  if (type === 'environment_variable') {
    const key = String(payload.key ?? '')
    if (key.length > LIMITS.variableKeyChars || !VARIABLE_KEY_RE.test(key)) {
      return `The variable name "${key.slice(0, 40)}" is not accepted by the cloud (letters, digits, "_", "." and "-", starting with a letter or "_", at most ${LIMITS.variableKeyChars} characters).`
    }
    if (typeof payload.value === 'string' && payload.value.length > LIMITS.variableValueChars) {
      return `The variable value is longer than ${LIMITS.variableValueChars} characters, which the cloud does not accept.`
    }
  }
  if (type === 'collection_version' && bytes(payload.snapshot_json) > LIMITS.snapshotJsonBytes) {
    return `The version snapshot is larger than ${LIMITS.snapshotJsonBytes / 1_000_000} MB, which the cloud does not accept.`
  }
  return null
}

/** Pick a subset of fields (missing -> null) for group comparison. */
export function pick(payload: Payload, fields: string[]): Payload {
  const out: Payload = {}
  for (const f of fields) out[f] = payload[f] === undefined ? null : payload[f]
  return out
}

/** Entity type of the container a payload references (for parent checks). */
export function parentRefs(type: SyncEntityType, payload: Payload): Array<{ type: SyncEntityType; id: string }> {
  const refs: Array<{ type: SyncEntityType; id: string }> = []
  const add = (t: SyncEntityType, id: unknown) => {
    if (typeof id === 'string' && id) refs.push({ type: t, id })
  }
  switch (type) {
    case 'folder':
      add('collection', payload.collection_id)
      add('folder', payload.parent_folder_id)
      break
    case 'request':
      add('collection', payload.collection_id)
      add('folder', payload.folder_id)
      break
    case 'environment_variable':
      add('environment', payload.environment_id)
      break
    case 'collection_version':
      add('collection', payload.collection_id)
      break
  }
  return refs
}
