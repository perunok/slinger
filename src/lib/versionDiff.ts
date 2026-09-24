/** Compares two collection snapshots (versions, or a version against the live collection). */
import type { ApiFolder, ApiRequest, Collection, CollectionSnapshot } from '../../shared/types'
import { dataRows, type KvRow } from './kv'
import { parseDocument, type RequestDraft } from './request'

export type SnapshotFolder = CollectionSnapshot['folders'][number]
export type SnapshotRequest = CollectionSnapshot['requests'][number]

export type FieldChange = {
  field: 'name' | 'method' | 'url' | 'body' | 'headers' | 'auth' | 'params' | 'description' | 'folder' | 'other'
  before: string
  after: string
}

export interface RequestDiff {
  key: string
  name: string
  /** "Folder/Sub/Request" (target side for changed/added, base side for removed). */
  path: string
  status: 'added' | 'removed' | 'changed'
  /** Empty for added/removed. */
  changes: FieldChange[]
  before?: SnapshotRequest
  after?: SnapshotRequest
}

export interface SnapshotDiff {
  requests: RequestDiff[]
  foldersAdded: string[]
  foldersRemoved: string[]
  foldersRenamed: { before: string; after: string }[]
  summary: { added: number; removed: number; changed: number; unchanged: number }
  identical: boolean
}

export function snapshotFromCollection(collection: Collection, folders: ApiFolder[], requests: ApiRequest[]): CollectionSnapshot {
  return {
    collectionName: collection.name,
    folders: folders.map((f) => ({ id: f.id, parentFolderId: f.parentFolderId, name: f.name, sortOrder: f.sortOrder })),
    requests: requests.map((r) => ({
      id: r.id, folderId: r.folderId, name: r.name, method: r.method, url: r.url, documentJson: r.documentJson, sortOrder: r.sortOrder,
    })),
  }
}

/** "A/B/C" for a folder id; '' for null or an unknown folder. Cycle safe. */
export function folderPath(folders: SnapshotFolder[], folderId: string | null): string {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const names: string[] = []
  const seen = new Set<string>()
  let current = folderId
  while (current !== null && !seen.has(current)) {
    seen.add(current)
    const f = byId.get(current)
    if (!f) break
    names.unshift(f.name)
    current = f.parentFolderId
  }
  return names.join('/')
}

// ---------------------------------------------------------------------------
// Semantic renderings of a request document
// ---------------------------------------------------------------------------

function rowLine(r: KvRow, withValue = true): string {
  const off = r.enabled ? '' : '[off] '
  if (r.kind === 'file') return `${off}${r.key}: @file ${r.filePath}`
  return withValue ? `${off}${r.key}: ${r.value}` : `${off}${r.key}`
}

/** Order-insensitive rendering of a row table. */
function renderRows(rows: KvRow[]): string {
  return dataRows(rows).map((r) => rowLine(r)).sort().join('\n')
}

function renderBody(d: RequestDraft): string {
  const b = d.body
  switch (b.kind) {
    case 'none':
      return 'none'
    case 'raw':
      return b.raw === '' ? `raw (${b.rawLanguage}): empty` : `raw (${b.rawLanguage})\n${b.raw}`
    case 'formData':
      return `form-data\n${renderRows(b.formData)}`
    case 'urlEncoded':
      return `x-www-form-urlencoded\n${renderRows(b.urlEncoded)}`
    case 'binary':
      return `binary: ${b.binaryPath}`
    case 'unsupported':
      return `unsupported\n${JSON.stringify(b.preserved) ?? ''}`
  }
}

function renderAuth(d: RequestDraft): string {
  const a = d.auth
  switch (a.kind) {
    case 'none':
      return 'none'
    case 'basic':
      return `basic\nusername: ${a.basic.username}\npassword: ${a.basic.password}`
    case 'bearer':
      return `bearer\ntoken: ${a.bearer.token}`
    case 'apiKey':
      return `api key\nkey: ${a.apiKey.key}\nvalue: ${a.apiKey.value}\nadd to: ${a.apiKey.addTo}`
    case 'unsupported':
      return `${a.unsupportedType ?? 'unsupported'}\n${JSON.stringify(a.preserved) ?? ''}`
  }
}

/** Stable stringify (sorted keys) so key order never produces a difference. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

function renderOther(d: RequestDraft): string {
  const lines: string[] = []
  const scripts = d.extras.scripts
  if (Array.isArray(scripts) && scripts.length > 0) lines.push(`scripts: ${stable(scripts)}`)
  if (d.timeoutMs != null) lines.push(`timeout: ${d.timeoutMs}ms`)
  return lines.join('\n')
}

interface Rendered {
  name: string
  method: string
  url: string
  body: string
  headers: string
  auth: string
  /** Only disabled rows: enabled params are already part of the URL. */
  params: string
  description: string
  other: string
}

function render(r: SnapshotRequest): Rendered {
  const d = parseDocument(r)
  return {
    name: r.name,
    method: d.method,
    url: d.url,
    body: renderBody(d),
    headers: renderRows(d.headers),
    auth: renderAuth(d),
    params: renderRows(d.params.filter((p) => !p.enabled)),
    description: d.description,
    other: renderOther(d),
  }
}

const FIELDS = ['name', 'method', 'url', 'body', 'headers', 'auth', 'params', 'description', 'other'] as const

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

function joinPath(folder: string, name: string): string {
  return folder ? `${folder}/${name}` : name
}

const byPath = (a: RequestDiff, b: RequestDiff) => a.path.localeCompare(b.path)

export function diffSnapshots(base: CollectionSnapshot, target: CollectionSnapshot): SnapshotDiff {
  const basePaths = new Map(base.requests.map((r) => [r.id, joinPath(folderPath(base.folders, r.folderId), r.name)]))
  const targetPaths = new Map(target.requests.map((r) => [r.id, joinPath(folderPath(target.folders, r.folderId), r.name)]))

  // 1. Match by id, 2. fall back to path for the rest (restore-as-copy regenerates ids).
  const targetById = new Map(target.requests.map((r) => [r.id, r]))
  const pairs: { before: SnapshotRequest; after: SnapshotRequest }[] = []
  const matchedTarget = new Set<string>()
  const unmatchedBase: SnapshotRequest[] = []
  for (const b of base.requests) {
    const t = targetById.get(b.id)
    if (t && !matchedTarget.has(t.id)) {
      matchedTarget.add(t.id)
      pairs.push({ before: b, after: t })
    } else unmatchedBase.push(b)
  }
  const pendingByPath = new Map<string, SnapshotRequest[]>()
  for (const t of target.requests) {
    if (matchedTarget.has(t.id)) continue
    const p = targetPaths.get(t.id)!
    pendingByPath.set(p, [...(pendingByPath.get(p) ?? []), t])
  }
  const removedRaw: SnapshotRequest[] = []
  for (const b of unmatchedBase) {
    const queue = pendingByPath.get(basePaths.get(b.id)!)
    const t = queue?.shift()
    if (t) {
      matchedTarget.add(t.id)
      pairs.push({ before: b, after: t })
    } else removedRaw.push(b)
  }

  const added: RequestDiff[] = target.requests
    .filter((t) => !matchedTarget.has(t.id))
    .map((t) => ({ key: t.id, name: t.name, path: targetPaths.get(t.id)!, status: 'added', changes: [], after: t }))
  const removed: RequestDiff[] = removedRaw.map((b) => ({
    key: b.id, name: b.name, path: basePaths.get(b.id)!, status: 'removed', changes: [], before: b,
  }))

  const changed: RequestDiff[] = []
  let unchanged = 0
  for (const { before, after } of pairs) {
    const rb = render(before)
    const ra = render(after)
    const changes: FieldChange[] = []
    for (const field of FIELDS) {
      if (rb[field] !== ra[field]) changes.push({ field, before: rb[field], after: ra[field] })
    }
    const fb = folderPath(base.folders, before.folderId)
    const fa = folderPath(target.folders, after.folderId)
    if (fb !== fa) changes.push({ field: 'folder', before: fb || '(root)', after: fa || '(root)' })
    if (changes.length === 0) unchanged++
    else changed.push({ key: before.id, name: after.name, path: targetPaths.get(after.id)!, status: 'changed', changes, before, after })
  }

  // Folders: id first, then path.
  const bPath = new Map(base.folders.map((f) => [f.id, folderPath(base.folders, f.id)]))
  const tPath = new Map(target.folders.map((f) => [f.id, folderPath(target.folders, f.id)]))
  const tFolderById = new Map(target.folders.map((f) => [f.id, f]))
  const matchedTF = new Set<string>()
  const foldersRenamed: { before: string; after: string }[] = []
  const leftoverBase: SnapshotFolder[] = []
  for (const f of base.folders) {
    const t = tFolderById.get(f.id)
    if (t) {
      matchedTF.add(t.id)
      if (t.name !== f.name) foldersRenamed.push({ before: bPath.get(f.id)!, after: tPath.get(t.id)! })
    } else leftoverBase.push(f)
  }
  const foldersRemoved: string[] = []
  const freeTargetPaths = new Map<string, string[]>()
  for (const t of target.folders) {
    if (matchedTF.has(t.id)) continue
    const p = tPath.get(t.id)!
    freeTargetPaths.set(p, [...(freeTargetPaths.get(p) ?? []), t.id])
  }
  for (const f of leftoverBase) {
    const ids = freeTargetPaths.get(bPath.get(f.id)!)
    const id = ids?.shift()
    if (id) matchedTF.add(id)
    else foldersRemoved.push(bPath.get(f.id)!)
  }
  const foldersAdded = target.folders.filter((t) => !matchedTF.has(t.id)).map((t) => tPath.get(t.id)!)
  foldersAdded.sort()
  foldersRemoved.sort()
  foldersRenamed.sort((a, b) => a.before.localeCompare(b.before))

  const requests = [...added.sort(byPath), ...removed.sort(byPath), ...changed.sort(byPath)]
  return {
    requests,
    foldersAdded,
    foldersRemoved,
    foldersRenamed,
    summary: { added: added.length, removed: removed.length, changed: changed.length, unchanged },
    identical: requests.length === 0 && foldersAdded.length === 0 && foldersRemoved.length === 0 && foldersRenamed.length === 0,
  }
}
