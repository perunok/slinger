/**
 * Pure helpers for the mock sync engine: entity <-> wire payload mapping, field groups and the
 * 3-way merge described in docs/SYNC_DESIGN.md sections 3 and 6. The real engine lives in the
 * main process; this mirror exists so every UI state is reachable in a plain browser.
 */
import type { SyncConflictGroup, SyncEntityType } from '../../../shared/types'
import type { MockState } from './store'

export type Wire = Record<string, string | number | boolean | null>
export type GroupName = SyncConflictGroup['group']

export const SYNC_TYPES: SyncEntityType[] = ['collection', 'environment', 'folder', 'request', 'environment_variable']

export const GROUP_FIELDS: Partial<Record<SyncEntityType, Partial<Record<GroupName, string[]>>>> = {
  collection: { name: ['name'] },
  folder: { name: ['name'], location: ['parent_folder_id'], order: ['sort_order'] },
  request: { content: ['name', 'method', 'url', 'document_json'], location: ['folder_id', 'collection_id'], order: ['sort_order'] },
  environment: { name: ['name'] },
  environment_variable: { key: ['key'], value: ['value', 'is_secret'] },
}

export const GROUP_LABEL: Record<GroupName, string> = {
  name: 'Name',
  content: 'Request content',
  location: 'Location',
  order: 'Order',
  key: 'Variable name',
  value: 'Value',
}

export const keyOf = (type: SyncEntityType, id: string) => `${type}:${id}`

export function canonical(p: Wire | null | undefined): string {
  if (!p) return ''
  return JSON.stringify(Object.fromEntries(Object.keys(p).sort().map((k) => [k, p[k]])))
}

/** Wire payload of the current local row, or null when it does not exist locally. */
export function toWire(s: MockState, type: SyncEntityType, id: string): Wire | null {
  switch (type) {
    case 'collection': {
      const c = s.collections.find((x) => x.id === id)
      return c ? { name: c.name } : null
    }
    case 'folder': {
      const f = s.folders.find((x) => x.id === id)
      return f ? { collection_id: f.collectionId, parent_folder_id: f.parentFolderId, name: f.name, sort_order: f.sortOrder } : null
    }
    case 'request': {
      const r = s.requests.find((x) => x.id === id)
      return r
        ? { collection_id: r.collectionId, folder_id: r.folderId, name: r.name, method: r.method, url: r.url, document_json: r.documentJson, sort_order: r.sortOrder }
        : null
    }
    case 'environment': {
      const e = s.environments.find((x) => x.id === id)
      return e ? { name: e.name } : null
    }
    case 'environment_variable': {
      const v = s.variables.find((x) => x.id === id)
      return v ? { environment_id: v.environmentId, key: v.key, value: v.isSecret ? null : v.value, is_secret: v.isSecret } : null
    }
    default:
      return null
  }
}

/** Every synced entity of a workspace as `type:id`. */
export function localKeys(s: MockState, workspaceId: string): string[] {
  const envIds = new Set(s.environments.filter((e) => e.workspaceId === workspaceId).map((e) => e.id))
  return [
    ...s.collections.filter((c) => c.workspaceId === workspaceId).map((c) => keyOf('collection', c.id)),
    ...s.environments.filter((e) => e.workspaceId === workspaceId).map((e) => keyOf('environment', e.id)),
    ...s.folders.filter((f) => f.workspaceId === workspaceId).map((f) => keyOf('folder', f.id)),
    ...s.requests.filter((r) => r.workspaceId === workspaceId).map((r) => keyOf('request', r.id)),
    ...s.variables.filter((v) => envIds.has(v.environmentId)).map((v) => keyOf('environment_variable', v.id)),
  ]
}

export const splitKey = (key: string): { type: SyncEntityType; id: string } => {
  const i = key.indexOf(':')
  return { type: key.slice(0, i) as SyncEntityType, id: key.slice(i + 1) }
}

export interface MergeResult {
  merged: Wire
  conflicting: GroupName[]
}

/** 3-way merge per field group (design section 6). Group `order` silently takes remote. */
export function merge(type: SyncEntityType, base: Wire | null, local: Wire, remote: Wire): MergeResult {
  const groups = GROUP_FIELDS[type] ?? {}
  const merged: Wire = { ...remote }
  const conflicting: GroupName[] = []
  const eq = (fields: string[], a: Wire | null, b: Wire | null) => fields.every((f) => (a?.[f] ?? null) === (b?.[f] ?? null))
  const covered = new Set<string>()
  for (const [g, fields] of Object.entries(groups) as [GroupName, string[]][]) {
    fields.forEach((f) => covered.add(f))
    const localChanged = !eq(fields, base, local)
    const remoteChanged = !eq(fields, base, remote)
    let take: Wire
    if (!remoteChanged) take = local
    else if (!localChanged) take = remote
    else if (eq(fields, local, remote)) take = remote
    else if (g === 'order') take = remote
    else {
      conflicting.push(g)
      take = local // local values are kept while the conflict is open
    }
    for (const f of fields) merged[f] = take[f] ?? null
  }
  // Immutable ids (collection_id of a folder, environment_id of a variable) always follow remote.
  for (const k of Object.keys(remote)) if (!covered.has(k)) merged[k] = remote[k]
  return { merged, conflicting }
}

/** Display string of a group for the conflict UI. `content` is JSON text of the request fields. */
export function groupValue(type: SyncEntityType, group: GroupName, p: Wire | null): string | null {
  if (!p) return null
  const fields = GROUP_FIELDS[type]?.[group] ?? []
  if (group === 'content') return JSON.stringify(Object.fromEntries(fields.map((f) => [f, p[f] ?? null])))
  if (group === 'value') return p.is_secret ? '(secret: not synced)' : String(p.value ?? '')
  if (group === 'location') return fields.map((f) => String(p[f] ?? '(root)')).join(' / ')
  if (group === 'order') return `position ${String(p.sort_order ?? 0)}`
  return String(p[fields[0]] ?? '')
}

export function labelOf(type: SyncEntityType, p: Wire | null, fallback = ''): string {
  if (!p) return fallback
  return String(p.name ?? p.key ?? fallback)
}
