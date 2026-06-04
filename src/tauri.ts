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

export type ApiFolder = {
  id: string
  workspace_id: string
  collection_id: string
  parent_folder_id: string | null
  name: string
  created_at: number
}

export type ApiRequest = {
  id: string
  workspace_id: string
  collection_id: string
  folder_id: string | null
  name: string
  method: string
  url: string
  document_json: string
  created_at: number
}

export type Environment = {
  id: string
  workspace_id: string
  name: string
  created_at: number
}

export type EnvironmentVariable = {
  id: string
  environment_id: string
  key: string
  value: string
  created_at: number
}

export type PostmanImportResult = {
  collection: Collection
  folders: ApiFolder[]
  requests: ApiRequest[]
}

export type RequestHeader = {
  key: string
  value: string
}

export type HttpRequestInput = {
  method: string
  url: string
  headers: RequestHeader[]
  body?: string | null
}

export type HttpResponseData = {
  status: number
  status_text: string
  duration_ms: number
  headers: RequestHeader[]
  body: string
}

export type UpdateRequestInput = {
  requestId: string
  method: string
  url: string
  documentJson: string
}

export type CreateRequestInput = {
  workspaceId: string
  collectionId: string
  name: string
  method: string
  url: string
  documentJson: string
}

type StoredData = {
  workspaces: Workspace[]
  collections: Collection[]
  folders: ApiFolder[]
  requests: ApiRequest[]
  environments: Environment[]
  environmentVariables: EnvironmentVariable[]
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
  event?: unknown
  response?: unknown
}

type PostmanCollection = {
  info?: {
    name?: string
  }
  item?: PostmanItem[]
}

type RequestDraft = {
  folderPath: string[]
  name: string
  method: string
  url: string
  document_json: string
}

const STORAGE_KEY = 'slinger.browser-preview.v1'
const PATH_SEPARATOR = '\u001f'

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
    folders: [],
    requests: [],
    environments: [],
    environmentVariables: [],
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return ensurePersonalWorkspace(fallback)

    const parsed = JSON.parse(raw) as Partial<StoredData>
    return ensurePersonalWorkspace({
      workspaces: parsed.workspaces ?? [],
      collections: parsed.collections ?? [],
      folders: parsed.folders ?? [],
      requests: (parsed.requests ?? []).map((request) => ({
        ...request,
        folder_id: request.folder_id ?? null,
      })),
      environments: parsed.environments ?? [],
      environmentVariables: parsed.environmentVariables ?? [],
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
    environments: [
      ...data.environments,
      {
        id: createId(),
        workspace_id: personal.id,
        name: 'Local',
        created_at: nowUnixSeconds(),
      },
    ],
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

function collectPostmanRequests(items: PostmanItem[] | undefined): RequestDraft[] {
  const requests: RequestDraft[] = []

  function walk(currentItems: PostmanItem[] | undefined, folderPath: string[]) {
    for (const item of currentItems ?? []) {
      if (item.item) {
        const folderName = item.name?.trim() || 'Untitled Folder'
        walk(item.item, [...folderPath, folderName])
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
        scripts: item.event ?? [],
        responses: item.response ?? [],
        source: item,
      }

      requests.push({
        folderPath,
        name,
        method,
        url,
        document_json: JSON.stringify(document),
      })
    }
  }

  walk(items, [])
  return requests
}

function createFoldersFromPaths(
  workspaceId: string,
  collectionId: string,
  paths: string[][],
): { folders: ApiFolder[]; pathToFolderId: Map<string, string> } {
  const folders: ApiFolder[] = []
  const pathToFolderId = new Map<string, string>()

  for (const path of paths) {
    let parentFolderId: string | null = null
    let currentPath: string[] = []

    for (const name of path) {
      currentPath = [...currentPath, name]
      const key = currentPath.join(PATH_SEPARATOR)

      if (pathToFolderId.has(key)) {
        parentFolderId = pathToFolderId.get(key) ?? null
        continue
      }

      const folder = {
        id: createId(),
        workspace_id: workspaceId,
        collection_id: collectionId,
        parent_folder_id: parentFolderId,
        name,
        created_at: nowUnixSeconds(),
      }

      folders.push(folder)
      pathToFolderId.set(key, folder.id)
      parentFolderId = folder.id
    }
  }

  return { folders, pathToFolderId }
}

function normalizeRequestUrl(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) return trimmed
  if (trimmed.startsWith('//')) return trimmed
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return trimmed
  return `http://${trimmed}`
}

const FETCH_FORBIDDEN_HEADERS = new Set([
  'accept-encoding',
  'connection',
  'content-length',
  'host',
  'user-agent',
])

async function executeWithFetch(input: HttpRequestInput): Promise<HttpResponseData> {
  if (input.url.includes('{{') || input.url.includes('}}')) {
    throw new Error('request URL contains unresolved variables')
  }

  const headers = input.headers.reduce<Record<string, string>>((current, header) => {
    const key = header.key.trim()
    if (key && !FETCH_FORBIDDEN_HEADERS.has(key.toLowerCase())) current[key] = header.value
    return current
  }, {})
  const startedAt = performance.now()
  const response = await fetch(normalizeRequestUrl(input.url), {
    method: input.method,
    headers,
    body: input.body || undefined,
  })
  const body = await response.text()
  const durationMs = Math.round(performance.now() - startedAt)

  return {
    status: response.status,
    status_text: response.statusText,
    duration_ms: durationMs,
    headers: Array.from(response.headers.entries()).map(([key, value]) => ({ key, value })),
    body,
  }
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
    environments: [
      ...data.environments,
      {
        id: createId(),
        workspace_id: workspace.id,
        name: 'Local',
        created_at: nowUnixSeconds(),
      },
    ],
  })

  return workspace
}

export async function ensureDefaultEnvironment(workspaceId: string): Promise<Environment> {
  if (isTauriRuntime) return invokeTauri('ensure_default_environment', { workspaceId })

  const data = readStore()
  const existing = data.environments.find((environment) => environment.workspace_id === workspaceId)

  if (existing) return existing

  const environment = {
    id: createId(),
    workspace_id: workspaceId,
    name: 'Local',
    created_at: nowUnixSeconds(),
  }

  writeStore({
    ...data,
    environments: [...data.environments, environment],
  })

  return environment
}

export async function getEnvironments(workspaceId: string): Promise<Environment[]> {
  if (isTauriRuntime) return invokeTauri('list_environments', { workspaceId })
  return readStore().environments.filter((environment) => environment.workspace_id === workspaceId)
}

export async function createEnvironment(workspaceId: string, name: string): Promise<Environment> {
  if (isTauriRuntime) return invokeTauri('create_environment', { workspaceId, name })

  const data = readStore()
  const environment = {
    id: createId(),
    workspace_id: workspaceId,
    name: requireName(name, 'environment'),
    created_at: nowUnixSeconds(),
  }

  writeStore({
    ...data,
    environments: [...data.environments, environment],
  })

  return environment
}

export async function getEnvironmentVariables(
  environmentId: string,
): Promise<EnvironmentVariable[]> {
  if (isTauriRuntime) return invokeTauri('list_environment_variables', { environmentId })
  return readStore().environmentVariables.filter(
    (variable) => variable.environment_id === environmentId,
  )
}

export async function upsertEnvironmentVariable(
  environmentId: string,
  key: string,
  value: string,
): Promise<EnvironmentVariable> {
  if (isTauriRuntime) {
    return invokeTauri('upsert_environment_variable', { environmentId, key, value })
  }

  const data = readStore()
  const trimmedKey = requireName(key, 'variable')
  const existing = data.environmentVariables.find(
    (variable) => variable.environment_id === environmentId && variable.key === trimmedKey,
  )
  const variable = {
    id: existing?.id ?? createId(),
    environment_id: environmentId,
    key: trimmedKey,
    value,
    created_at: existing?.created_at ?? nowUnixSeconds(),
  }

  writeStore({
    ...data,
    environmentVariables: existing
      ? data.environmentVariables.map((item) => (item.id === existing.id ? variable : item))
      : [...data.environmentVariables, variable],
  })

  return variable
}

export async function deleteEnvironmentVariable(variableId: string): Promise<void> {
  if (isTauriRuntime) return invokeTauri('delete_environment_variable', { variableId })

  const data = readStore()
  writeStore({
    ...data,
    environmentVariables: data.environmentVariables.filter((variable) => variable.id !== variableId),
  })
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
    folders: data.folders.filter((folder) => folder.collection_id !== collectionId),
    requests: data.requests.filter((request) => request.collection_id !== collectionId),
  })
}

export async function getFolders(collectionId: string): Promise<ApiFolder[]> {
  if (isTauriRuntime) return invokeTauri('list_folders', { collectionId })
  return readStore().folders.filter((folder) => folder.collection_id === collectionId)
}

export async function getRequests(collectionId: string): Promise<ApiRequest[]> {
  if (isTauriRuntime) return invokeTauri('list_requests', { collectionId })
  return readStore().requests.filter((request) => request.collection_id === collectionId)
}

export async function createRequest(input: CreateRequestInput): Promise<ApiRequest> {
  if (isTauriRuntime) return invokeTauri('create_request', { input })

  const data = readStore()
  const workspace = data.workspaces.find((item) => item.id === input.workspaceId)
  if (!workspace) throw new Error('workspace not found')

  const collection = data.collections.find(
    (item) => item.id === input.collectionId && item.workspace_id === input.workspaceId,
  )
  if (!collection) throw new Error('collection not found')

  JSON.parse(input.documentJson)

  const request = {
    id: createId(),
    workspace_id: input.workspaceId,
    collection_id: input.collectionId,
    folder_id: null,
    name: requireName(input.name, 'request'),
    method: input.method.trim().toUpperCase() || 'GET',
    url: input.url,
    document_json: input.documentJson,
    created_at: nowUnixSeconds(),
  }

  writeStore({
    ...data,
    requests: [...data.requests, request],
  })

  return request
}

export async function updateRequest(input: UpdateRequestInput): Promise<ApiRequest> {
  if (isTauriRuntime) return invokeTauri('update_request', { input })

  const data = readStore()
  const existing = data.requests.find((request) => request.id === input.requestId)
  if (!existing) throw new Error('request not found')

  JSON.parse(input.documentJson)

  const updated = {
    ...existing,
    method: input.method.trim().toUpperCase() || 'GET',
    url: input.url,
    document_json: input.documentJson,
  }

  writeStore({
    ...data,
    requests: data.requests.map((request) =>
      request.id === input.requestId ? updated : request,
    ),
  })

  return updated
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
  const { folders, pathToFolderId } = createFoldersFromPaths(
    workspaceId,
    collection.id,
    requestDrafts.map((request) => request.folderPath),
  )
  const requests = requestDrafts.map((request) => ({
    id: createId(),
    workspace_id: workspaceId,
    collection_id: collection.id,
    folder_id: pathToFolderId.get(request.folderPath.join(PATH_SEPARATOR)) ?? null,
    name: request.name,
    method: request.method,
    url: request.url,
    document_json: request.document_json,
    created_at: nowUnixSeconds(),
  }))

  writeStore({
    ...data,
    collections: [...data.collections, collection],
    folders: [...data.folders, ...folders],
    requests: [...data.requests, ...requests],
  })

  return {
    collection,
    folders,
    requests,
  }
}

export async function getDefaultExportPath(fileName: string): Promise<string> {
  if (isTauriRuntime) return invokeTauri('default_export_path', { fileName })
  return fileName
}

export async function writeExportFile(path: string, contents: string): Promise<void> {
  if (!isTauriRuntime) throw new Error('file writing is only available in the desktop app')
  return invokeTauri('write_export_file', { path, contents })
}

export async function executeHttpRequest(input: HttpRequestInput): Promise<HttpResponseData> {
  if (isTauriRuntime) return invokeTauri('execute_http_request', { input })
  return executeWithFetch(input)
}
