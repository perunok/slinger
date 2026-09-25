import type { ApiFolder, ApiRequest, Collection, DescriptionType, PostmanImportOptions, PostmanImportResult, PostmanReplaceResult } from '../../shared/types'
import type { Db } from '../db/database'
import { invalidInput } from '../lib/errors'
import { newId } from '../lib/ids'
import { cleanName, nowSeconds } from '../lib/text'
import { descriptionFromPostman, requireCollection, requireWorkspace, toCollection, toFolder, toRequest } from '../repositories/common'
import type { CollectionRow, FolderRow, RequestRow } from '../repositories/common'
import { createCollectionVersion, listCollectionVersions } from './collectionVersions'
import { compare as compareSemver, parse as parseSemver, type SemVer } from './semver'
import { postmanUrlToString } from '../../shared/postmanUrl'
import { restoreVersionHistory } from './versionHistory'

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

/** Postman v2.0/v2.1 `url` (string or object) to a plain URL string (also rebuilds URLs that have no `raw`). */
export { postmanUrlToString }

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

/** A validated Postman collection file, ready to be written by `insertContent`. */
export interface ParsedPostmanCollection {
  name: string
  /** `info._postman_id` (lower-cased), or null when absent. */
  postmanId: string | null
  scriptsJson: string | null
  description: { text: string | null; type: DescriptionType | null }
  folders: FolderDraft[]
  requests: RequestDraft[]
  scriptCount: number
  /** The raw `info._slinger` version-history block (validated later by restoreVersionHistory); undefined when absent. */
  slinger: unknown
}

const MAX_POSTMAN_ID = 200

/**
 * Parses and validates a Postman collection (v2.0/v2.1 JSON) without touching the database. Shared by the
 * import and the replace path so both treat a file identically. Throws invalid_input for anything unusable.
 */
export function parsePostmanCollection(fileContents: string): ParsedPostmanCollection {
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
  const out: Collected = { folders: [], requests: [], nextTempId: 1, scriptCount: countScripts(parsed.event) }
  collect(parsed.item, null, parsed.auth ?? null, 0, out)
  if (out.requests.length === 0) throw invalidInput('No requests found in Postman collection')
  const postmanId = str(info._postman_id)
  return {
    name: (str(info.name) ?? 'Imported Collection').slice(0, 200),
    postmanId: postmanId && postmanId.length <= MAX_POSTMAN_ID ? postmanId.toLowerCase() : null,
    scriptsJson: eventJson(parsed.event),
    description: descriptionFromPostman(info.description),
    folders: out.folders,
    requests: out.requests,
    scriptCount: out.scriptCount,
    slinger: info._slinger,
  }
}

/** Inserts the parsed folders and requests into `collection` with new ids (call inside a transaction). */
function insertContent(db: Db, collection: CollectionRow, content: ParsedPostmanCollection, now: number): { folders: ApiFolder[]; requests: ApiRequest[] } {
  const folderIds = new Map<number, string>()
  const insertFolder = db.prepare(
    `INSERT INTO folders (id, workspace_id, collection_id, parent_folder_id, name, sort_order, scripts_json, description, description_type,
       version, deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
  )
  // Drafts are produced parent-before-child, so parents are always inserted first.
  for (const f of content.folders) {
    const id = newId()
    insertFolder.run(id, collection.workspace_id, collection.id,
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
  for (const r of content.requests) {
    const id = newId()
    insertRequest.run(id, collection.workspace_id, collection.id,
      r.folderTempId === null ? null : folderIds.get(r.folderTempId)!, r.name.slice(0, 500), r.method.slice(0, 32),
      r.url, JSON.stringify(r.document), r.sortOrder, now, now)
    requestIds.push(id)
  }
  return {
    folders: [...folderIds.values()].map((id) => toFolder(db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as FolderRow)),
    requests: requestIds.map((id) => toRequest(db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as RequestRow)),
  }
}

const readCollection = (db: Db, id: string): CollectionRow => db.prepare('SELECT * FROM collections WHERE id = ?').get(id) as CollectionRow

/**
 * Imports a Postman collection (v2.0/v2.1 JSON) as a new collection in one transaction.
 * Nothing is created if the payload is invalid or contains no requests. `options.name` overrides the file's
 * name (import as a copy); such a copy does not record the file's `_postman_id`.
 */
export function importPostmanCollection(db: Db, workspaceId: string, fileContents: string, options: PostmanImportOptions = {}): PostmanImportResult {
  const workspace = requireWorkspace(db, workspaceId)
  const content = parsePostmanCollection(fileContents)
  const nameOverride = options.name === undefined ? null : cleanName(options.name, 'collection name')

  return db.transaction((): PostmanImportResult => {
    const now = nowSeconds()
    const collectionId = newId()
    db.prepare(
      `INSERT INTO collections (id, workspace_id, name, scripts_json, description, description_type, source_postman_id, version, deleted,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
    ).run(collectionId, workspace.id, nameOverride ?? content.name, content.scriptsJson, content.description.text, content.description.type,
      nameOverride ? null : content.postmanId, now, now)
    const row = readCollection(db, collectionId)
    const { folders, requests } = insertContent(db, row, content, now)
    // Slinger exports carry the version history in `info._slinger`; a bad block is reported, never fatal.
    const versionHistory = restoreVersionHistory(db, collectionId, content.slinger)
    return { collection: toCollection(row), folders, requests, scriptCount: content.scriptCount, ...(versionHistory ? { versionHistory } : {}) }
  })()
}

/**
 * The "next patch" version, as the Create version dialog suggests it: the latest release (pre-releases ignored)
 * with its patch bumped, bumped again while taken; "0.0.1" when there is no release yet.
 */
export function nextPatchVersion(existing: readonly string[]): string {
  let top: SemVer | null = null
  for (const v of existing) {
    const p = parseSemver(v)
    if (p && p.prerelease.length === 0 && (!top || compareSemver(p, top) > 0)) top = p
  }
  const taken = new Set(existing)
  let next = top ? { major: top.major, minor: top.minor, patch: top.patch + 1 } : { major: 0, minor: 0, patch: 1 }
  while (taken.has(`${next.major}.${next.minor}.${next.patch}`)) next = { ...next, patch: next.patch + 1 }
  return `${next.major}.${next.minor}.${next.patch}`
}

const MAX_SOURCE_LABEL = 500

/**
 * Replaces an existing collection's content with a Postman file, in ONE transaction:
 * 1. an automatic safety version (next patch) snapshots the current content, so the replace can be undone;
 * 2. every live folder and request is soft-deleted (the sync dirty-set triggers propagate the deletions);
 * 3. the file's folders and requests are inserted with new ids, in file order;
 * 4. collection scripts, description and `source_postman_id` are updated.
 * The collection keeps its id, name and versions. Any failure (bad file, read-only workspace) changes nothing.
 */
export function replaceCollectionFromPostman(db: Db, collectionId: string, fileContents: string, sourceName?: string | null): PostmanReplaceResult {
  const content = parsePostmanCollection(fileContents)
  const collection = requireCollection(db, collectionId)
  const label = (typeof sourceName === 'string' && sourceName.trim() ? sourceName.trim() : 'a Postman file').slice(0, MAX_SOURCE_LABEL)

  return db.transaction((): PostmanReplaceResult => {
    const version = nextPatchVersion(listCollectionVersions(db, collection.id).map((v) => v.version))
    const safetyVersion = createCollectionVersion(db, {
      collectionId: collection.id,
      version,
      notes: `Automatic snapshot before re-import from ${label}`,
    })
    const now = nowSeconds()
    for (const table of ['requests', 'folders']) {
      db.prepare(`UPDATE ${table} SET deleted = 1, updated_at = ?, version = version + 1 WHERE collection_id = ? AND deleted = 0`)
        .run(now, collection.id)
    }
    db.prepare(
      `UPDATE collections SET scripts_json = ?, description = ?, description_type = ?, source_postman_id = COALESCE(?, source_postman_id),
         updated_at = ?, version = version + 1 WHERE id = ?`,
    ).run(content.scriptsJson, content.description.text, content.description.type, content.postmanId, now, collection.id)
    const row = readCollection(db, collection.id)
    const { folders, requests } = insertContent(db, row, content, now)
    // The file's version history joins the existing versions (and the safety version); identical ones are skipped,
    // clashing ones kept as "<v>-imported". Runs in a savepoint: a bad history never undoes the replace.
    const versionHistory = restoreVersionHistory(db, collection.id, content.slinger)
    return { collection: toCollection(row), folders, requests, scriptCount: content.scriptCount, safetyVersion, ...(versionHistory ? { versionHistory } : {}) }
  })()
}
