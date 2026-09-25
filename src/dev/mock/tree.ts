import type {
  ApiFolder,
  ApiRequest,
  CreateFolderInput,
  CreateRequestInput,
  MoveFolderInput,
  MoveRequestInput,
  UpdateRequestInput,
} from '../../../shared/types'
import type { SlingerIpcApi } from '../../../shared/ipc-contract'
import {
  addFolder,
  addRequest,
  folderSiblings,
  must,
  requestSiblings,
  touch,
  type MockState,
} from './store'
import { bySortOrder, cleanName, cleanScriptsJson, fail, setDescription } from './util'

type Ordered = { id: string; sortOrder: number; updatedAt: number; version: number }

/** Re-number a list 0..n, bumping only rows whose position changed. */
function renumber(rows: Ordered[]): void {
  rows.forEach((row, i) => {
    if (row.sortOrder !== i) {
      row.sortOrder = i
      touch(row)
    }
  })
}

/** Insert `moved` at `index` (clamped) among `siblings` (already without `moved`), renumbering 0..n. */
function place(siblings: Ordered[], moved: Ordered, index: number): void {
  if (!Number.isInteger(index)) fail('invalid_input', 'targetIndex must be an integer')
  const list = [...siblings].sort(bySortOrderLoose)
  list.splice(Math.min(Math.max(index, 0), list.length), 0, moved)
  moved.sortOrder = -1 // force a version bump for the moved row
  renumber(list)
}

const bySortOrderLoose = (a: Ordered, b: Ordered): number => a.sortOrder - b.sortOrder

function assertFolderInCollection(s: MockState, folderId: string | null, collectionId: string): void {
  if (folderId === null) return
  const folder = must(s.folders, folderId, 'Folder')
  if (folder.collectionId !== collectionId) fail('invalid_input', 'Folder belongs to a different collection')
}

function descendantFolderIds(s: MockState, folderId: string): Set<string> {
  const ids = new Set<string>([folderId])
  let grew = true
  while (grew) {
    grew = false
    for (const f of s.folders) {
      if (f.parentFolderId && ids.has(f.parentFolderId) && !ids.has(f.id)) {
        ids.add(f.id)
        grew = true
      }
    }
  }
  return ids
}

type TreeApi = Pick<
  SlingerIpcApi,
  | 'listFolders'
  | 'createFolder'
  | 'renameFolder'
  | 'moveFolder'
  | 'deleteFolder'
  | 'setFolderScripts'
  | 'setFolderDescription'
  | 'listRequests'
  | 'createRequest'
  | 'updateRequest'
  | 'renameRequest'
  | 'moveRequest'
  | 'deleteRequest'
>

export function createTreeApi(s: MockState): TreeApi {
  return {
    async listFolders(collectionId) {
      must(s.collections, collectionId, 'Collection')
      return s.folders.filter((f) => f.collectionId === collectionId).sort(bySortOrder)
    },

    async createFolder(input: CreateFolderInput): Promise<ApiFolder> {
      const collection = must(s.collections, input.collectionId, 'Collection')
      const parent = input.parentFolderId ?? null
      assertFolderInCollection(s, parent, collection.id)
      return addFolder(s, {
        workspaceId: collection.workspaceId,
        collectionId: collection.id,
        parentFolderId: parent,
        name: cleanName(input.name, 'Folder'),
      })
    },

    async renameFolder(folderId, name) {
      const folder = must(s.folders, folderId, 'Folder')
      folder.name = cleanName(name, 'Folder')
      return touch(folder)
    },

    async moveFolder(input: MoveFolderInput) {
      const folder = must(s.folders, input.folderId, 'Folder')
      const target = input.targetParentFolderId
      assertFolderInCollection(s, target, folder.collectionId)
      if (target !== null && descendantFolderIds(s, folder.id).has(target)) {
        fail('invalid_input', 'Cannot move a folder into itself or one of its descendants')
      }
      const oldSiblings = folderSiblings(s, folder.collectionId, folder.parentFolderId).filter((f) => f.id !== folder.id)
      const newSiblings = folderSiblings(s, folder.collectionId, target).filter((f) => f.id !== folder.id)
      if (folder.parentFolderId !== target) renumber(oldSiblings.sort(bySortOrderLoose))
      folder.parentFolderId = target
      place(newSiblings, folder, input.targetIndex)
      return folder
    },

    async setFolderScripts(folderId, scriptsJson) {
      const folder = must(s.folders, folderId, 'Folder')
      folder.scriptsJson = cleanScriptsJson(scriptsJson)
      return touch(folder)
    },

    async setFolderDescription(folderId, description) {
      const folder = must(s.folders, folderId, 'Folder')
      setDescription(folder, description)
      return touch(folder)
    },

    async deleteFolder(folderId) {
      const folder = must(s.folders, folderId, 'Folder')
      const doomed = descendantFolderIds(s, folder.id)
      s.folders = s.folders.filter((f) => !doomed.has(f.id))
      s.requests = s.requests.filter((r) => !(r.folderId && doomed.has(r.folderId)))
    },

    async listRequests(collectionId) {
      must(s.collections, collectionId, 'Collection')
      return s.requests.filter((r) => r.collectionId === collectionId).sort(bySortOrder)
    },

    async createRequest(input: CreateRequestInput): Promise<ApiRequest> {
      const collection = must(s.collections, input.collectionId, 'Collection')
      const folderId = input.folderId ?? null
      assertFolderInCollection(s, folderId, collection.id)
      return addRequest(s, {
        workspaceId: collection.workspaceId,
        collectionId: collection.id,
        folderId,
        name: cleanName(input.name, 'Request'),
        method: (input.method || 'GET').toUpperCase(),
        url: input.url ?? '',
        documentJson: input.documentJson ?? '{}',
      })
    },

    async updateRequest(input: UpdateRequestInput) {
      const request = must(s.requests, input.requestId, 'Request')
      if (request.version !== input.expectedVersion) {
        fail('version_conflict', 'Request was modified elsewhere', { currentVersion: request.version })
      }
      request.name = cleanName(input.name, 'Request')
      request.method = (input.method || 'GET').toUpperCase()
      request.url = input.url ?? ''
      request.documentJson = input.documentJson ?? '{}'
      return touch(request)
    },

    async renameRequest(requestId, name) {
      const request = must(s.requests, requestId, 'Request')
      request.name = cleanName(name, 'Request')
      return touch(request)
    },

    async moveRequest(input: MoveRequestInput) {
      const request = must(s.requests, input.requestId, 'Request')
      const collection = must(s.collections, input.targetCollectionId, 'Collection')
      assertFolderInCollection(s, input.targetFolderId, collection.id)
      const oldSiblings = requestSiblings(s, request.collectionId, request.folderId).filter((r) => r.id !== request.id)
      const newSiblings = requestSiblings(s, collection.id, input.targetFolderId).filter((r) => r.id !== request.id)
      const sameContainer = request.collectionId === collection.id && request.folderId === input.targetFolderId
      if (!sameContainer) renumber(oldSiblings.sort(bySortOrderLoose))
      request.collectionId = collection.id
      request.folderId = input.targetFolderId
      place(newSiblings, request, input.targetIndex)
      return request
    },

    async deleteRequest(requestId) {
      must(s.requests, requestId, 'Request')
      s.requests = s.requests.filter((r) => r.id !== requestId)
    },
  }
}
