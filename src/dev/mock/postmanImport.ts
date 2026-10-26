import type { ApiFolder, ApiRequest, Collection, PostmanImportOptions, PostmanImportResult, PostmanReplaceResult } from '../../../shared/types'
import { stripOAuth2Tokens, stripOAuth2TokensFromItem } from '../../../shared/oauth2'
import { addCollection, addFolder, addRequest, must, removeCollectionContents, touch, type MockState } from './store'
import { fail } from './util'
import { addAutomaticVersion } from './versions'
import { countScripts } from '../../lib/scripts'
import { MCP_METHOD } from '../../lib/mcpRequest'
import { columnsFromPostman } from '../../lib/description'
import { postmanUrlToString } from '../../../shared/postmanUrl'
import { restoreVersionHistoryMock } from './versionHistory'
import { variablesFromPostman, type CollectionVariableData } from '../../../shared/postmanVariables'
import { setCollectionVariables } from './variables'

const eventJson = (event: unknown): string | null => (Array.isArray(event) && event.length > 0 ? JSON.stringify(event) : null)

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

function trimmedOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

/** Same URL rules as the main-process importer. */
export { postmanUrlToString }

/** A Slinger MCP request's configuration (item key `_slinger_mcp`, see lib/postman.ts), or null. */
const mcpOf = (item: Json): Json | null => (isObj(item._slinger_mcp) ? item._slinger_mcp : null)

function requestDocument(item: Json, request: Json, name: string, method: string, url: string, inheritedAuth: unknown = null): Json {
  const { _slinger_mcp: _mcp, _slinger_openapi: _openapi, ...sourceItem } = item
  const mcp = mcpOf(item)
  const doc: Json = {
    name,
    method,
    url,
    description: request.description ?? null,
    headers: request.header ?? [],
    body: mcp ? null : (request.body ?? null),
    // Requests without their own auth inherit the nearest folder/collection auth, as in main and Postman.
    auth: stripOAuth2Tokens(request.auth ?? inheritedAuth ?? null),
    scripts: item.event ?? [],
    responses: item.response ?? [],
    source: stripOAuth2TokensFromItem(sourceItem),
  }
  if (mcp) Object.assign(doc, { params: [], mcp })
  // Imported from an OpenAPI document (as electron/services/postmanImport.ts).
  if (isObj(item._slinger_openapi) && typeof item._slinger_openapi.key === 'string') doc.openapi = item._slinger_openapi
  return doc
}

/** The request one Postman item becomes, as the mock importer writes it (OpenAPI updates reuse it); null without `request`. */
export function requestFromItem(item: Json, inheritedAuth: unknown = null): { name: string; method: string; url: string; document: Json } | null {
  if (!isObj(item.request)) return null
  const name = trimmedOr(item.name, 'Untitled Request')
  const method = mcpOf(item) ? MCP_METHOD : trimmedOr(item.request.method, 'GET').toUpperCase()
  const url = postmanUrlToString(item.request.url)
  return { name, method, url, document: requestDocument(item, item.request, name, method, url, inheritedAuth) }
}

interface Parsed {
  name: string
  postmanId: string | null
  info: Json
  event: unknown
  items: unknown[]
  variables: CollectionVariableData[]
  /** The collection's `auth`, inherited by requests without their own. */
  auth: unknown
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
  return { name: trimmedOr(info.name, 'Imported Collection'), postmanId: id, info, event: parsed.event, items: parsed.item, variables: variablesFromPostman(parsed.variable), auth: parsed.auth ?? null }
}

/** Builds the file's tree under `collection` in a scratch state (nothing is kept when it has no requests). */
function build(s: MockState, collection: Collection, file: Parsed) {
  const scratch: MockState = { ...s, collections: [], folders: [], requests: [] }
  const counter = { scripts: countScripts(file.event) }
  walk(scratch, collection.workspaceId, collection.id, file.items, null, counter, file.auth)
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
  // Imported: its scripts run only after the user allowed them (as main's collection_trust).
  s.untrustedCollections[collection.id] = true
  s.folders.push(...tree.folders)
  s.requests.push(...tree.requests)
  setCollectionVariables(s, collection.id, collection.workspaceId, file.variables)
  const versionHistory = restoreVersionHistoryMock(s, collection.id, file.info._slinger)
  return { collection, ...tree, variableCount: file.variables.length, ...(versionHistory ? { versionHistory } : {}) }
}

/**
 * Mirror of electron/services/collectionContent.ts (mode `path`): folders that match a live folder by name under the
 * matched parent, and requests that match by name and method (then name alone) in the matched folder, take over the
 * existing id (version bumped when the content changes).
 */
function keepMatchingIds(s: MockState, collectionId: string, tree: { folders: ApiFolder[]; requests: ApiRequest[] }): void {
  const liveFolders = s.folders.filter((f) => f.collectionId === collectionId).sort((a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : 1))
  const liveRequests = s.requests.filter((r) => r.collectionId === collectionId).sort((a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : 1))
  const folderMap = new Map<string, string>()
  const used = new Set<string>()
  for (const f of tree.folders) {
    // build() emits parents before children
    const parent = f.parentFolderId === null ? null : (folderMap.get(f.parentFolderId) ?? f.parentFolderId)
    f.parentFolderId = parent
    const old = liveFolders.find((e) => !used.has(e.id) && e.parentFolderId === parent && e.name === f.name)
    if (!old) continue
    used.add(old.id)
    folderMap.set(f.id, old.id)
    const same = old.sortOrder === f.sortOrder && old.scriptsJson === f.scriptsJson && old.description === f.description && old.descriptionType === f.descriptionType
    Object.assign(f, { id: old.id, createdAt: old.createdAt, version: same ? old.version : old.version + 1, updatedAt: same ? old.updatedAt : f.updatedAt })
  }
  for (const r of tree.requests) if (r.folderId !== null) r.folderId = folderMap.get(r.folderId) ?? r.folderId
  for (const strict of [true, false]) {
    for (const r of tree.requests) {
      if (liveRequests.some((e) => e.id === r.id)) continue
      const old = liveRequests.find((e) => !used.has(e.id) && e.folderId === r.folderId && e.name === r.name && (!strict || e.method === r.method))
      if (!old) continue
      used.add(old.id)
      const same = old.method === r.method && old.url === r.url && old.documentJson === r.documentJson && old.sortOrder === r.sortOrder
      Object.assign(r, { id: old.id, createdAt: old.createdAt, version: same ? old.version : old.version + 1, updatedAt: same ? old.updatedAt : r.updatedAt })
    }
  }
}

/** Mirror of the main-process replace: safety version, then the collection's content is swapped (id kept). */
export function replaceFromPostman(s: MockState, collectionId: string, fileContents: string, sourceName?: string | null): PostmanReplaceResult {
  const collection = must(s.collections, collectionId, 'Collection')
  const file = parseFile(fileContents)
  const tree = build(s, collection, file) // validates before anything changes
  const label = sourceName?.trim() || 'a Postman file'
  const row = addAutomaticVersion(s, collection.id, `re-import from ${label}`)
  keepMatchingIds(s, collection.id, tree)
  removeCollectionContents(s, collection.id)
  s.folders.push(...tree.folders)
  s.requests.push(...tree.requests)
  collection.scriptsJson = eventJson(file.event)
  Object.assign(collection, columnsFromPostman(file.info.description))
  if (file.postmanId) collection.sourcePostmanId = file.postmanId
  setCollectionVariables(s, collection.id, collection.workspaceId, file.variables)
  touch(collection)
  const { snapshot: _snapshot, ...safetyVersion } = row
  const versionHistory = restoreVersionHistoryMock(s, collection.id, file.info._slinger)
  return { collection, ...tree, variableCount: file.variables.length, safetyVersion, ...(versionHistory ? { versionHistory } : {}) }
}

function walk(s: MockState, workspaceId: string, collectionId: string, items: unknown[], parentId: string | null, counter: { scripts: number }, inheritedAuth: unknown = null): void {
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
      walk(s, workspaceId, collectionId, raw.item, folder.id, counter, raw.auth ?? inheritedAuth)
      continue
    }
    if (!isObj(raw.request)) continue
    const request = raw.request
    const name = trimmedOr(raw.name, 'Untitled Request')
    const method = mcpOf(raw) ? MCP_METHOD : trimmedOr(request.method, 'GET').toUpperCase()
    const url = postmanUrlToString(request.url)
    addRequest(s, {
      workspaceId,
      collectionId,
      folderId: parentId,
      name,
      method,
      url,
      documentJson: JSON.stringify(requestDocument(raw, request, name, method, url, inheritedAuth)),
    })
  }
}
