/**
 * Local row <-> wire payload mapping, field groups, canonical JSON and pre-send limits
 * (docs/SYNC_DESIGN.md sections 3 and 6). Pure apart from `loadRow`.
 */
import { SYNC_DOCUMENT_JSON_BYTE_LIMIT } from '../../shared/syncLimits'
import type { SyncConflictGroup, SyncEntityType } from '../../shared/types'
import type { Db } from '../db/database'
import type { Payload } from './types'

export type GroupName = SyncConflictGroup['group']
export type AnyRow = Record<string, string | number | null>

/**
 * Additive protocol extensions (design section 21). The server advertises them; the client declares them on every
 * sync call. A link's effective set (`cloud_links.sync_features`) gates the wire mapping: fields and types of a
 * feature that is off are not part of the payload at all, so they stay local-only with an older server.
 */
export type SyncFeature = 'folder_scripts' | 'docs' | 'collection_variables' | 'globals'
export const CLIENT_FEATURES: readonly SyncFeature[] = ['folder_scripts', 'docs', 'collection_variables', 'globals']
export type Features = ReadonlySet<string>
export const NO_FEATURES: Features = new Set()
export const ALL_FEATURES: Features = new Set(CLIENT_FEATURES)
/** Resource types that only exist with a feature. */
export const TYPE_FEATURE: Partial<Record<SyncEntityType, SyncFeature>> = { collection_variable: 'collection_variables', global_variable: 'globals' }
/** Collection/folder payload fields that only exist with a feature. */
export const FIELD_FEATURE: Readonly<Record<string, SyncFeature>> = { scripts_json: 'folder_scripts', description: 'docs', description_type: 'docs' }
/** Field groups that only exist with a feature. */
const GROUP_FEATURE: Partial<Record<GroupName, SyncFeature>> = { scripts: 'folder_scripts', docs: 'docs' }

/** Whether entities of `type` sync at all with `features`. */
export function typeSynced(type: SyncEntityType, features: Features): boolean {
  const f = TYPE_FEATURE[type]
  return !f || features.has(f)
}

export const TABLE: Record<SyncEntityType, string> = {
  collection: 'collections',
  folder: 'folders',
  request: 'requests',
  environment: 'environments',
  environment_variable: 'environment_variables',
  collection_version: 'collection_versions',
  collection_variable: 'collection_variables',
  global_variable: 'global_variables',
}

/** Field groups per entity type: the unit of 3-way merging (design section 6). */
export const GROUPS: Record<SyncEntityType, Partial<Record<GroupName, string[]>>> = {
  collection: { name: ['name'], scripts: ['scripts_json'], docs: ['description', 'description_type'] },
  folder: {
    name: ['name'],
    location: ['collection_id', 'parent_folder_id'],
    order: ['sort_order'],
    scripts: ['scripts_json'],
    docs: ['description', 'description_type'],
  },
  request: {
    content: ['name', 'method', 'url', 'document_json'],
    location: ['collection_id', 'folder_id'],
    order: ['sort_order'],
  },
  environment: { name: ['name'] },
  environment_variable: { key: ['key'], value: ['value', 'is_secret'] },
  collection_version: {},
  collection_variable: { key: ['key'], value: ['value'], details: ['enabled', 'description'], order: ['sort_order'] },
  global_variable: { key: ['key'], value: ['value', 'is_secret'], details: ['enabled', 'description'], order: ['sort_order'] },
}

/** The groups of `type` that exist with `features` (display, merge choices). */
export function groupsOf(type: SyncEntityType, features: Features): Array<[GroupName, string[]]> {
  return (Object.entries(GROUPS[type]) as Array<[GroupName, string[]]>).filter(([g]) => {
    const f = GROUP_FEATURE[g]
    return !f || features.has(f)
  })
}

export const GROUP_LABELS: Record<GroupName, string> = {
  name: 'Name',
  content: 'Request',
  location: 'Location',
  order: 'Order',
  key: 'Key',
  value: 'Value',
  scripts: 'Scripts',
  docs: 'Documentation',
  details: 'Enabled & description',
}

/** Server-side caps the engine enforces BEFORE sending (design section 3). */
export const LIMITS = {
  /** Shared with the renderer (shared/syncLimits.ts) so its "too big to sync" warning matches this cap. */
  documentJsonBytes: SYNC_DOCUMENT_JSON_BYTE_LIMIT,
  /** Server cap for collection/folder/environment names (request names: `requestNameChars`); longer ones are quarantined, never truncated. */
  nameChars: 200,
  requestNameChars: 500,
  urlChars: 8192,
  variableKeyChars: 128,
  variableValueChars: 65_536,
  snapshotJsonBytes: 8_000_000,
  /** Collection/folder scripts and docs (design section 21): the local input caps (repositories/common.ts), so never hit in practice. */
  scriptsJsonBytes: 2 * 1024 * 1024,
  descriptionBytes: 2 * 1024 * 1024,
  /** Collection variables and globals: the local input caps (repositories/variables.ts). */
  varKeyChars: 256,
  varValueChars: 1_000_000,
  varDescriptionChars: 100_000,
} as const
export const VARIABLE_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/

export function loadRow(db: Db, type: SyncEntityType, id: string): AnyRow | undefined {
  return db.prepare(`SELECT * FROM ${TABLE[type]} WHERE id = ?`).get(id) as AnyRow | undefined
}

const DESCRIPTION_TYPES = new Set(['text/markdown', 'text/plain'])

/** Feature-gated extras of a collection/folder payload. */
function containerExtras(row: AnyRow, features: Features): Payload {
  const out: Payload = {}
  if (features.has('folder_scripts')) out.scripts_json = row.scripts_json ?? null
  if (features.has('docs')) {
    out.description = row.description ?? null
    out.description_type = typeof row.description_type === 'string' && DESCRIPTION_TYPES.has(row.description_type) ? row.description_type : null
  }
  return out
}

/**
 * Incoming (pulled / snapshotted / rejection) payload in the shape `toWire` produces for these features: an enabled
 * field the payload lacks (log entries written before the server supported it) is `null`, a field of a disabled
 * feature is dropped. Other types are returned unchanged.
 */
export function normalizeIncoming(type: SyncEntityType, payload: Payload, features: Features): Payload {
  if (type !== 'collection' && type !== 'folder') return payload
  let out: Payload | null = null
  for (const [field, feature] of Object.entries(FIELD_FEATURE)) {
    const on = features.has(feature)
    if (on && payload[field] === undefined) (out ??= { ...payload })[field] = null
    else if (!on && field in payload) delete (out ??= { ...payload })[field]
  }
  return out ?? payload
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

/** Local row -> wire payload for a link with `features`. A secret variable never carries a value. */
export function toWire(type: SyncEntityType, row: AnyRow, features: Features): Payload {
  switch (type) {
    case 'collection':
      return { name: row.name, ...containerExtras(row, features) }
    case 'environment':
      return { name: row.name }
    case 'folder':
      return {
        collection_id: row.collection_id,
        parent_folder_id: row.parent_folder_id ?? null,
        name: row.name,
        sort_order: row.sort_order,
        ...containerExtras(row, features),
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
    case 'collection_variable':
      return {
        collection_id: row.collection_id,
        key: row.key,
        value: row.value ?? '',
        enabled: row.enabled === 1,
        description: row.description ?? null,
        sort_order: row.sort_order,
      }
    case 'global_variable': {
      const secret = row.is_secret === 1
      return {
        key: row.key,
        value: secret ? null : (row.value ?? ''),
        is_secret: secret,
        enabled: row.enabled === 1,
        description: row.description ?? null,
        sort_order: row.sort_order,
      }
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
  if (type === 'environment_variable' || type === 'collection_variable' || type === 'global_variable') return String(payload.key ?? '')
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
  if ((type === 'collection' || type === 'folder') && bytes(payload.scripts_json) > LIMITS.scriptsJsonBytes) {
    return `The ${type}'s scripts are larger than 2 MB, which the cloud does not accept.`
  }
  if ((type === 'collection' || type === 'folder') && bytes(payload.description) > LIMITS.descriptionBytes) {
    return `The ${type}'s documentation is larger than 2 MB, which the cloud does not accept.`
  }
  if (type === 'collection_variable' || type === 'global_variable') {
    const key = String(payload.key ?? '')
    if (key.length > LIMITS.varKeyChars || key.trim() !== key || key === '') {
      return `The variable name "${key.slice(0, 40)}" is not accepted by the cloud (1 to ${LIMITS.varKeyChars} characters, no leading or trailing spaces).`
    }
    if (typeof payload.value === 'string' && payload.value.length > LIMITS.varValueChars) {
      return `The variable value is longer than ${LIMITS.varValueChars} characters, which the cloud does not accept.`
    }
    if (typeof payload.description === 'string' && payload.description.length > LIMITS.varDescriptionChars) {
      return `The variable description is longer than ${LIMITS.varDescriptionChars} characters, which the cloud does not accept.`
    }
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
    case 'collection_variable':
      add('collection', payload.collection_id)
      break
  }
  return refs
}
