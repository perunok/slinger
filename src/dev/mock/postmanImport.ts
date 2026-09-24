import type { PostmanImportResult } from '../../../shared/types'
import { addCollection, addFolder, addRequest, must, type MockState } from './store'
import { fail } from './util'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

function trimmedOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

const joinParts = (parts: unknown, sep: string): string =>
  Array.isArray(parts) ? parts.filter((p): p is string => typeof p === 'string').join(sep) : ''

/** Port of `postman_url_to_string` (src-tauri/src/db.rs). */
export function postmanUrlToString(url: unknown): string {
  if (typeof url === 'string') return url
  if (!isObj(url)) return ''
  if (typeof url.raw === 'string') return url.raw
  const host = joinParts(url.host, '.')
  const path = joinParts(url.path, '/')
  if (host && path) return `${host.replace(/\/+$/, '')}/${path}`
  return host || path
}

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

/** Port of `import_postman_collection` + `collect_postman_entries`; sortOrder follows item order. */
export function importPostman(s: MockState, workspaceId: string, fileContents: string): PostmanImportResult {
  const workspace = must(s.workspaces, workspaceId, 'Workspace')
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
  const items: unknown[] = parsed.item
  const collectionName = trimmedOr(info.name, 'Imported Collection')

  // Build into a scratch state so a failed import (no requests) leaves nothing behind.
  const scratch: MockState = { ...s, collections: [], folders: [], requests: [] }
  const collection = addCollection(scratch, workspace.id, collectionName)
  walk(scratch, workspace.id, collection.id, items, null)
  if (scratch.requests.length === 0) fail('invalid_input', 'No requests found in Postman collection')

  s.collections.push(collection)
  s.folders.push(...scratch.folders)
  s.requests.push(...scratch.requests)
  return { collection, folders: scratch.folders, requests: scratch.requests }
}

function walk(s: MockState, workspaceId: string, collectionId: string, items: unknown[], parentId: string | null): void {
  for (const raw of items) {
    if (!isObj(raw)) continue
    if (Array.isArray(raw.item)) {
      const folder = addFolder(s, {
        workspaceId,
        collectionId,
        parentFolderId: parentId,
        name: trimmedOr(raw.name, 'Untitled Folder'),
      })
      walk(s, workspaceId, collectionId, raw.item, folder.id)
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
