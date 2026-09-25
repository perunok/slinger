import type { Collection, PostmanImportOptions, PostmanImportResult, PostmanReplaceResult } from '../../../shared/types'
import { suggestBumps } from '../../lib/semver'
import { addCollection, addFolder, addRequest, must, removeCollectionContents, touch, type MockState } from './store'
import { fail } from './util'
import { addVersion } from './versions'
import { countScripts } from '../../lib/scripts'
import { columnsFromPostman } from '../../lib/description'
import { postmanUrlToString } from '../../../shared/postmanUrl'
import { restoreVersionHistoryMock } from './versionHistory'

const eventJson = (event: unknown): string | null => (Array.isArray(event) && event.length > 0 ? JSON.stringify(event) : null)

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

function trimmedOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

/** Same URL rules as the main-process importer. */
export { postmanUrlToString }

function requestDocument(item: Json, request: Json, name: string, method: string, url: string): Json {
  return {
    name,
    method,
    url,
    description: request.description ?? null,
    headers: request.header ?? [],
    body: request.body ?? null,
    auth: request.auth ?? null,
    scripts: item.event ?? [],
    responses: item.response ?? [],
    source: item,
  }
}

interface Parsed {
  name: string
  postmanId: string | null
  info: Json
  event: unknown
  items: unknown[]
}

function parseFile(fileContents: string): Parsed {
  let parsed: unknown
  try {
    parsed = JSON.parse(fileContents)
  } catch (e) {
    fail('invalid_input', `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!isObj(parsed) || !Array.isArray(parsed.item)) {
    fail('invalid_input', 'Postman collection must contain an item array')
  }
  const info = isObj(parsed.info) ? parsed.info : {}
  const id = typeof info._postman_id === 'string' && info._postman_id.trim() ? info._postman_id.trim().toLowerCase() : null
  return { name: trimmedOr(info.name, 'Imported Collection'), postmanId: id, info, event: parsed.event, items: parsed.item }
}

/** Builds the file's tree under `collection` in a scratch state (nothing is kept when it has no requests). */
function build(s: MockState, collection: Collection, file: Parsed) {
  const scratch: MockState = { ...s, collections: [], folders: [], requests: [] }
  const counter = { scripts: countScripts(file.event) }
  walk(scratch, collection.workspaceId, collection.id, file.items, null, counter)
  if (scratch.requests.length === 0) fail('invalid_input', 'No requests found in Postman collection')
  return { folders: scratch.folders, requests: scratch.requests, scriptCount: counter.scripts }
}

/** Port of `import_postman_collection` + `collect_postman_entries`; sortOrder follows item order. */
export function importPostman(s: MockState, workspaceId: string, fileContents: string, options?: PostmanImportOptions | null): PostmanImportResult {
  const workspace = must(s.workspaces, workspaceId, 'Workspace')
  const file = parseFile(fileContents)
  const name = options?.name?.trim()
  if (options?.name != null && !name) fail('invalid_input', 'collection name is required')
  const collection = addCollection({ ...s, collections: [] }, workspace.id, name || file.name)
  collection.scriptsJson = eventJson(file.event)
  Object.assign(collection, columnsFromPostman(file.info.description))
  collection.sourcePostmanId = name ? null : file.postmanId
  const tree = build(s, collection, file)
  s.collections.push(collection)
  s.folders.push(...tree.folders)
  s.requests.push(...tree.requests)
  const versionHistory = restoreVersionHistoryMock(s, collection.id, file.info._slinger)
  return { collection, ...tree, ...(versionHistory ? { versionHistory } : {}) }
}

/** Mirror of the main-process replace: safety version, then the collection's content is swapped (id kept). */
export function replaceFromPostman(s: MockState, collectionId: string, fileContents: string, sourceName?: string | null): PostmanReplaceResult {
  const collection = must(s.collections, collectionId, 'Collection')
  const file = parseFile(fileContents)
  const tree = build(s, collection, file) // validates before anything changes
  const versions = s.versions.filter((v) => v.collectionId === collection.id).map((v) => v.version)
  const label = sourceName?.trim() || 'a Postman file'
  const row = addVersion(s, collection.id, suggestBumps(versions).patch, `Automatic snapshot before re-import from ${label}`)
  removeCollectionContents(s, collection.id)
  s.folders.push(...tree.folders)
  s.requests.push(...tree.requests)
  collection.scriptsJson = eventJson(file.event)
  Object.assign(collection, columnsFromPostman(file.info.description))
  if (file.postmanId) collection.sourcePostmanId = file.postmanId
  touch(collection)
  const { snapshot: _snapshot, ...safetyVersion } = row
  const versionHistory = restoreVersionHistoryMock(s, collection.id, file.info._slinger)
  return { collection, ...tree, safetyVersion, ...(versionHistory ? { versionHistory } : {}) }
}

function walk(s: MockState, workspaceId: string, collectionId: string, items: unknown[], parentId: string | null, counter: { scripts: number }): void {
  for (const raw of items) {
    if (!isObj(raw)) continue
    counter.scripts += countScripts(raw.event)
    if (Array.isArray(raw.item)) {
      const folder = addFolder(s, {
        workspaceId,
        collectionId,
        parentFolderId: parentId,
        name: trimmedOr(raw.name, 'Untitled Folder'),
      })
      folder.scriptsJson = eventJson(raw.event)
      Object.assign(folder, columnsFromPostman(raw.description))
      walk(s, workspaceId, collectionId, raw.item, folder.id, counter)
      continue
    }
    if (!isObj(raw.request)) continue
    const request = raw.request
    const name = trimmedOr(raw.name, 'Untitled Request')
    const method = trimmedOr(request.method, 'GET').toUpperCase()
    const url = postmanUrlToString(request.url)
    addRequest(s, {
      workspaceId,
      collectionId,
      folderId: parentId,
      name,
      method,
      url,
      documentJson: JSON.stringify(requestDocument(raw, request, name, method, url)),
    })
  }
}
