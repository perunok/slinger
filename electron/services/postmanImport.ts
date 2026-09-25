import type { ApiFolder, ApiRequest, Collection, DescriptionType, PostmanImportResult } from '../../shared/types'
import type { Db } from '../db/database'
import { invalidInput } from '../lib/errors'
import { newId } from '../lib/ids'
import { nowSeconds } from '../lib/text'
import { descriptionFromPostman, requireWorkspace, toCollection, toFolder, toRequest } from '../repositories/common'
import type { CollectionRow, FolderRow, RequestRow } from '../repositories/common'

export const MAX_IMPORT_BYTES = 50 * 1024 * 1024
const MAX_DEPTH = 100

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

interface FolderDraft {
  tempId: number
  parentTempId: number | null
  name: string
  sortOrder: number
  /** The folder's Postman `event` array (verbatim JSON), or null. */
  scriptsJson: string | null
  description: { text: string | null; type: DescriptionType | null }
}
interface RequestDraft {
  folderTempId: number | null
  name: string
  method: string
  url: string
  sortOrder: number
  document: Json
}

function joinParts(parts: unknown, separator: string): string {
  return Array.isArray(parts) ? parts.filter((p): p is string => typeof p === 'string').join(separator) : ''
}

/** Postman v2.0/v2.1 `url` (string or object) to a plain URL string. */
export function postmanUrlToString(url: unknown): string {
  if (typeof url === 'string') return url
  if (!isObject(url)) return ''
  if (typeof url.raw === 'string') return url.raw
  const host = joinParts(url.host, '.')
  const path = joinParts(url.path, '/')
  if (host && path) return `${host.replace(/\/+$/, '')}/${path}`
  return host || path
}

interface Collected {
  folders: FolderDraft[]
  requests: RequestDraft[]
  nextTempId: number
  /** Non-empty pre-request/test scripts seen (collection + folders + requests). */
  scriptCount: number
}

/** Stored verbatim when it is a non-empty array; Postman `event` entries are not otherwise interpreted here. */
function eventJson(event: unknown): string | null {
  return Array.isArray(event) && event.length > 0 ? JSON.stringify(event) : null
}

/** Number of pre-request/test entries with code in a Postman `event` array. */
export function countScripts(event: unknown): number {
  if (!Array.isArray(event)) return 0
  let n = 0
  for (const e of event) {
    if (!isObject(e) || e.disabled === true || (e.listen !== 'prerequest' && e.listen !== 'test') || !isObject(e.script)) continue
    const exec = e.script.exec
    const code = Array.isArray(exec) ? exec.filter((l) => typeof l === 'string').join('\n') : typeof exec === 'string' ? exec : ''
    if (code.trim()) n++
  }
  return n
}

function collect(
  items: unknown[],
  parentTempId: number | null,
  inheritedAuth: unknown,
  depth: number,
  out: Collected,
): void {
  if (depth > MAX_DEPTH) throw invalidInput(`Postman collection is nested deeper than ${MAX_DEPTH} folders`)
  let folderOrder = 0
  let requestOrder = 0
  for (const item of items) {
    if (!isObject(item)) continue
    if (Array.isArray(item.item)) {
      const tempId = out.nextTempId++
      out.folders.push({ tempId, parentTempId, name: str(item.name) ?? 'Untitled Folder', sortOrder: folderOrder++, scriptsJson: eventJson(item.event),
        description: descriptionFromPostman(item.description) })
      out.scriptCount += countScripts(item.event)
      collect(item.item, tempId, item.auth ?? inheritedAuth, depth + 1, out)
      continue
    }
    if (!isObject(item.request)) continue
    const request = item.request
    const name = str(item.name) ?? 'Untitled Request'
    const method = (str(request.method) ?? 'GET').toUpperCase()
    const url = postmanUrlToString(request.url)
    out.scriptCount += countScripts(item.event)
    out.requests.push({
      folderTempId: parentTempId,
      name,
      method,
      url,
      sortOrder: requestOrder++,
      document: {
        name,
        method,
        url,
        description: request.description ?? null,
        headers: Array.isArray(request.header) ? request.header : [],
        body: request.body ?? null,
        // Requests without their own auth inherit the nearest folder/collection auth, as in Postman.
        auth: request.auth ?? inheritedAuth ?? null,
        scripts: Array.isArray(item.event) ? item.event : [],
        responses: Array.isArray(item.response) ? item.response : [],
        source: item,
      },
    })
  }
}

/**
 * Imports a Postman collection (v2.0/v2.1 JSON) as a new collection in one transaction.
 * Nothing is created if the payload is invalid or contains no requests.
 */
export function importPostmanCollection(db: Db, workspaceId: string, fileContents: string): PostmanImportResult {
  const workspace = requireWorkspace(db, workspaceId)
  if (typeof fileContents !== 'string' || fileContents.length > MAX_IMPORT_BYTES) {
    throw invalidInput('Postman file is missing or too large')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(fileContents)
  } catch {
    throw invalidInput('File is not valid JSON')
  }
  if (!isObject(parsed) || !Array.isArray(parsed.item)) {
    throw invalidInput('Postman collection must contain an "item" array')
  }
  const info = isObject(parsed.info) ? parsed.info : {}
  const collectionName = (str(info.name) ?? 'Imported Collection').slice(0, 200)

  const out: Collected = { folders: [], requests: [], nextTempId: 1, scriptCount: countScripts(parsed.event) }
  collect(parsed.item, null, parsed.auth ?? null, 0, out)
  const collectionScripts = eventJson(parsed.event)
  const collectionDescription = descriptionFromPostman(info.description)
  if (out.requests.length === 0) throw invalidInput('No requests found in Postman collection')

  return db.transaction((): PostmanImportResult => {
    const now = nowSeconds()
    const collectionId = newId()
    db.prepare(
      `INSERT INTO collections (id, workspace_id, name, scripts_json, description, description_type, version, deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
    ).run(collectionId, workspace.id, collectionName, collectionScripts, collectionDescription.text, collectionDescription.type, now, now)

    const folderIds = new Map<number, string>()
    const insertFolder = db.prepare(
      `INSERT INTO folders (id, workspace_id, collection_id, parent_folder_id, name, sort_order, scripts_json, description, description_type,
         version, deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
    )
    // Drafts are produced parent-before-child, so parents are always inserted first.
    for (const f of out.folders) {
      const id = newId()
      insertFolder.run(id, workspace.id, collectionId,
        f.parentTempId === null ? null : folderIds.get(f.parentTempId)!, f.name.slice(0, 200), f.sortOrder, f.scriptsJson,
        f.description.text, f.description.type, now, now)
      folderIds.set(f.tempId, id)
    }
    const insertRequest = db.prepare(
      `INSERT INTO requests (id, workspace_id, collection_id, folder_id, name, method, url, document_json,
         sort_order, version, deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
    )
    const requestIds: string[] = []
    for (const r of out.requests) {
      const id = newId()
      insertRequest.run(id, workspace.id, collectionId,
        r.folderTempId === null ? null : folderIds.get(r.folderTempId)!, r.name.slice(0, 500), r.method.slice(0, 32),
        r.url, JSON.stringify(r.document), r.sortOrder, now, now)
      requestIds.push(id)
    }

    const collection: Collection = toCollection(db.prepare('SELECT * FROM collections WHERE id = ?').get(collectionId) as CollectionRow)
    const folders: ApiFolder[] = [...folderIds.values()].map((id) =>
      toFolder(db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as FolderRow))
    const requests: ApiRequest[] = requestIds.map((id) =>
      toRequest(db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as RequestRow))
    return { collection, folders, requests, scriptCount: out.scriptCount }
  })()
}
