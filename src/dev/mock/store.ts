import type {
  ApiFolder,
  ApiRequest,
  Collection,
  CollectionVersion,
  CollectionSnapshot,
  Environment,
  HistoryEntry,
  Workspace,
} from '../../../shared/types'
import { fail, nowSec, uuid } from './util'

/** Environment variable as stored; secrets keep their plaintext here only. */
export interface VariableRow {
  id: string
  environmentId: string
  key: string
  value: string
  isSecret: boolean
  createdAt: number
  updatedAt: number
  version: number
}

export interface VersionRow extends CollectionVersion {
  snapshot: CollectionSnapshot
}

export interface MockState {
  workspaces: Workspace[]
  environments: Environment[]
  variables: VariableRow[]
  collections: Collection[]
  folders: ApiFolder[]
  requests: ApiRequest[]
  history: HistoryEntry[]
  versions: VersionRow[]
}

export function emptyState(): MockState {
  return {
    workspaces: [],
    environments: [],
    variables: [],
    collections: [],
    folders: [],
    requests: [],
    history: [],
    versions: [],
  }
}

export function must<T extends { id: string }>(rows: T[], id: string, what: string): T {
  const row = rows.find((r) => r.id === id)
  if (!row) fail('not_found', `${what} not found: ${id}`)
  return row
}

export function touch<T extends { updatedAt: number; version: number }>(row: T): T {
  row.updatedAt = nowSec()
  row.version += 1
  return row
}

const nextSort = (rows: Array<{ sortOrder: number }>): number =>
  rows.length === 0 ? 0 : Math.max(...rows.map((r) => r.sortOrder)) + 1

export function folderSiblings(s: MockState, collectionId: string, parentId: string | null): ApiFolder[] {
  return s.folders.filter((f) => f.collectionId === collectionId && f.parentFolderId === parentId)
}

export function requestSiblings(s: MockState, collectionId: string, folderId: string | null): ApiRequest[] {
  return s.requests.filter((r) => r.collectionId === collectionId && r.folderId === folderId)
}

export function addCollection(s: MockState, workspaceId: string, name: string): Collection {
  const now = nowSec()
  const row: Collection = { id: uuid(), workspaceId, name, createdAt: now, updatedAt: now, version: 1 }
  s.collections.push(row)
  return row
}

export interface NewFolder {
  workspaceId: string
  collectionId: string
  parentFolderId: string | null
  name: string
  id?: string
  sortOrder?: number
}

/** Appends at the end of its container unless an explicit sortOrder is given. */
export function addFolder(s: MockState, input: NewFolder): ApiFolder {
  const now = nowSec()
  const row: ApiFolder = {
    id: input.id ?? uuid(),
    workspaceId: input.workspaceId,
    collectionId: input.collectionId,
    parentFolderId: input.parentFolderId,
    name: input.name,
    sortOrder: input.sortOrder ?? nextSort(folderSiblings(s, input.collectionId, input.parentFolderId)),
    createdAt: now,
    updatedAt: now,
    version: 1,
  }
  s.folders.push(row)
  return row
}

export interface NewRequest {
  workspaceId: string
  collectionId: string
  folderId: string | null
  name: string
  method: string
  url: string
  documentJson: string
  id?: string
  sortOrder?: number
}

export function addRequest(s: MockState, input: NewRequest): ApiRequest {
  const now = nowSec()
  const row: ApiRequest = {
    id: input.id ?? uuid(),
    workspaceId: input.workspaceId,
    collectionId: input.collectionId,
    folderId: input.folderId,
    name: input.name,
    method: input.method,
    url: input.url,
    documentJson: input.documentJson,
    sortOrder: input.sortOrder ?? nextSort(requestSiblings(s, input.collectionId, input.folderId)),
    createdAt: now,
    updatedAt: now,
    version: 1,
  }
  s.requests.push(row)
  return row
}

export function addEnvironment(s: MockState, workspaceId: string, name: string): Environment {
  const now = nowSec()
  const row: Environment = { id: uuid(), workspaceId, name, createdAt: now, updatedAt: now, version: 1 }
  s.environments.push(row)
  return row
}

export function addVariable(
  s: MockState,
  environmentId: string,
  key: string,
  value: string,
  isSecret = false,
): VariableRow {
  const now = nowSec()
  const row: VariableRow = { id: uuid(), environmentId, key, value, isSecret, createdAt: now, updatedAt: now, version: 1 }
  s.variables.push(row)
  return row
}

export function removeCollectionContents(s: MockState, collectionId: string): void {
  s.folders = s.folders.filter((f) => f.collectionId !== collectionId)
  s.requests = s.requests.filter((r) => r.collectionId !== collectionId)
}

export function removeCollection(s: MockState, collectionId: string): void {
  removeCollectionContents(s, collectionId)
  s.versions = s.versions.filter((v) => v.collectionId !== collectionId)
  s.collections = s.collections.filter((c) => c.id !== collectionId)
}

export function removeEnvironment(s: MockState, environmentId: string): void {
  s.variables = s.variables.filter((v) => v.environmentId !== environmentId)
  s.environments = s.environments.filter((e) => e.id !== environmentId)
}

export function removeWorkspace(s: MockState, workspaceId: string): void {
  for (const c of s.collections.filter((c) => c.workspaceId === workspaceId)) removeCollection(s, c.id)
  for (const e of s.environments.filter((e) => e.workspaceId === workspaceId)) removeEnvironment(s, e.id)
  s.history = s.history.filter((h) => h.workspaceId !== workspaceId)
  s.workspaces = s.workspaces.filter((w) => w.id !== workspaceId)
}
