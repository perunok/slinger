import { invoke } from '@tauri-apps/api/core'

export type Workspace = {
  id: string
  name: string
  created_at: number
}

export type Collection = {
  id: string
  workspace_id: string
  name: string
  created_at: number
}

export type ApiRequest = {
  id: string
  workspace_id: string
  collection_id: string
  name: string
  method: string
  url: string
  document_json: string
  created_at: number
}

export type PostmanImportResult = {
  collection: Collection
  requests: ApiRequest[]
}

type StoredData = {
  workspaces: Workspace[]
  collections: Collection[]
  requests: ApiRequest[]
}

type PostmanItem = {
  name?: string
  item?: PostmanItem[]
  request?: {
    method?: string
    url?: string | { raw?: string; host?: string[]; path?: string[] }
    description?: unknown
    header?: unknown
    body?: unknown
    auth?: unknown
  }
  response?: unknown
}

type PostmanCollection = {
  info?: {
    name?: string
  }
  item?: PostmanItem[]
}

const STORAGE_KEY = 'slinger.browser-preview.v1'

export const isTauriRuntime = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

function nowUnixSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function createId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function readStore(): StoredData {
  const fallback: StoredData = {
    workspaces: [],
    collections: [],
    requests: [],
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return ensurePersonalWorkspace(fallback)

    const parsed = JSON.parse(raw) as Partial<StoredData>
    return ensurePersonalWorkspace({
      workspaces: parsed.workspaces ?? [],
      collections: parsed.collections ?? [],
      requests: parsed.requests ?? [],
    })
  } catch {
    return ensurePersonalWorkspace(fallback)
  }
}

function writeStore(data: StoredData): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
}

function ensurePersonalWorkspace(data: StoredData): StoredData {
  if (data.workspaces.length > 0) return data

  const personal = {
    id: createId(),
    name: 'Personal',
    created_at: nowUnixSeconds(),
  }

  const next = {
    ...data,
    workspaces: [personal],
  }

  writeStore(next)
  return next
}

function requireName(name: string, label: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new Error(`${label} name is required`)
  return trimmed
}

function postmanUrlToString(
  url: string | { raw?: string; host?: string[]; path?: string[] } | undefined,
): string {
  if (!url) return ''
  if (typeof url === 'string') return url

  if (typeof url.raw === 'string' && url.raw.trim()) return url.raw

  const host = Array.isArray(url.host) ? url.host.join('.') : ''
  const path = Array.isArray(url.path) ? url.path.join('/') : ''

  if (!host) return path
  if (!path) return host
  return `${host.replace(/\/$/, '')}/${path}`
}

function collectPostmanRequests(items: PostmanItem[] | undefined): Array<{
  name: string
  method: string
  url: string
  document_json: string
}> {
  const requests: Array<{
    name: string
    method: string
    url: string
    document_json: string
  }> = []

  for (const item of items ?? []) {
    if (item.item) {
      requests.push(...collectPostmanRequests(item.item))
      continue
    }

    if (!item.request) continue

    const name = item.name?.trim() || 'Untitled Request'
    const method = item.request.method?.trim().toUpperCase() || 'GET'
    const url = postmanUrlToString(item.request.url)
    const document = {
      name,
      method,
      url,
      description: item.request.description ?? null,
      headers: item.request.header ?? [],
      body: item.request.body ?? null,
      auth: item.request.auth ?? null,
      responses: item.response ?? [],
      source: item,
    }

    requests.push({
      name,
      method,
      url,
      document_json: JSON.stringify(document),
    })
  }

  return requests
}

async function invokeTauri<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args)
}

export async function getWorkspaces(): Promise<Workspace[]> {
  if (isTauriRuntime) return invokeTauri('list_workspaces')
  return readStore().workspaces
}

export async function createWorkspace(name: string): Promise<Workspace> {
  if (isTauriRuntime) return invokeTauri('create_workspace', { name })

  const data = readStore()
  const workspace = {
    id: createId(),
    name: requireName(name, 'workspace'),
    created_at: nowUnixSeconds(),
  }

  writeStore({
    ...data,
    workspaces: [...data.workspaces, workspace],
  })

  return workspace
}

export async function getCollections(workspaceId: string): Promise<Collection[]> {
  if (isTauriRuntime) return invokeTauri('list_collections', { workspaceId })
  return readStore().collections.filter((collection) => collection.workspace_id === workspaceId)
}

export async function createCollection(workspaceId: string, name: string): Promise<Collection> {
  if (isTauriRuntime) return invokeTauri('create_collection', { workspaceId, name })

  const data = readStore()
  const collection = {
    id: createId(),
    workspace_id: workspaceId,
    name: requireName(name, 'collection'),
    created_at: nowUnixSeconds(),
  }

  writeStore({
    ...data,
    collections: [...data.collections, collection],
  })

  return collection
}

export async function renameCollection(collectionId: string, name: string): Promise<Collection> {
  if (isTauriRuntime) return invokeTauri('rename_collection', { collectionId, name })

  const data = readStore()
  const existing = data.collections.find((collection) => collection.id === collectionId)
  if (!existing) throw new Error('collection not found')

  const renamed = {
    ...existing,
    name: requireName(name, 'collection'),
  }

  writeStore({
    ...data,
    collections: data.collections.map((collection) =>
      collection.id === collectionId ? renamed : collection,
    ),
  })

  return renamed
}

export async function deleteCollection(collectionId: string): Promise<void> {
  if (isTauriRuntime) return invokeTauri('delete_collection', { collectionId })

  const data = readStore()
  writeStore({
    ...data,
    collections: data.collections.filter((collection) => collection.id !== collectionId),
    requests: data.requests.filter((request) => request.collection_id !== collectionId),
  })
}

export async function getRequests(collectionId: string): Promise<ApiRequest[]> {
  if (isTauriRuntime) return invokeTauri('list_requests', { collectionId })
  return readStore().requests.filter((request) => request.collection_id === collectionId)
}

export async function importPostmanCollection(
  workspaceId: string,
  payload: string,
): Promise<PostmanImportResult> {
  if (isTauriRuntime) return invokeTauri('import_postman_collection', { workspaceId, payload })

  const parsed = JSON.parse(payload) as PostmanCollection
  const collectionName = parsed.info?.name?.trim() || 'Imported Collection'
  const requestDrafts = collectPostmanRequests(parsed.item)

  if (requestDrafts.length === 0) {
    throw new Error('no requests found in Postman collection')
  }

  const data = readStore()
  const collection = {
    id: createId(),
    workspace_id: workspaceId,
    name: collectionName,
    created_at: nowUnixSeconds(),
  }
  const requests = requestDrafts.map((request) => ({
    ...request,
    id: createId(),
    workspace_id: workspaceId,
    collection_id: collection.id,
    created_at: nowUnixSeconds(),
  }))

  writeStore({
    ...data,
    collections: [...data.collections, collection],
    requests: [...data.requests, ...requests],
  })

  return {
    collection,
    requests,
  }
}
