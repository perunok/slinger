/**
 * Collection-tree mutations. Each function throws on failure so dialogs can show the error
 * inline; callers that have no dialog wrap them with `runAction` (toast on failure).
 */
import type { ApiRequest } from '../../../shared/types'
import { app } from '../../app/state.svelte'
import { toast } from '../../app/toast.svelte'
import { api, errorInfo } from '../../lib/ipc'
import { newDraft, serializeDraft } from '../../lib/request'
import type { DropPlan } from '../../lib/tree'
import { tabsStore } from '../requests/tabs.svelte'

function ws(): string {
  if (!app.workspaceId) throw new Error('No workspace is selected.')
  return app.workspaceId
}

async function refresh(collectionIds: string[]) {
  await app.reloadCollectionsById(collectionIds) // also reconciles open tabs, once
}

export async function runAction(what: string, fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn()
    return true
  } catch (e) {
    toast.error(`${what} failed`, errorInfo(e).message)
    return false
  }
}

export async function createCollection(name: string) {
  const c = await api().createCollection(ws(), name)
  await app.reloadCollections()
  return c
}
export async function renameCollection(id: string, name: string) {
  await api().renameCollection(id, name)
  await app.reloadCollections()
}
export async function deleteCollection(id: string) {
  await api().deleteCollection(id)
  await app.reloadCollections()
  tabsStore.syncWithServer()
}

export async function createFolder(collectionId: string, parentFolderId: string | null, name: string) {
  const f = await api().createFolder({ workspaceId: ws(), collectionId, parentFolderId, name })
  await refresh([collectionId])
  return f
}
export async function renameFolder(folderId: string, collectionId: string, name: string) {
  await api().renameFolder(folderId, name)
  await refresh([collectionId])
}
export async function deleteFolder(folderId: string, collectionId: string) {
  await api().deleteFolder(folderId)
  await refresh([collectionId])
}

export async function createRequest(collectionId: string, folderId: string | null, name: string): Promise<ApiRequest> {
  const s = serializeDraft(newDraft({ name }))
  const r = await api().createRequest({ workspaceId: ws(), collectionId, folderId, name: s.name, method: s.method, url: s.url, documentJson: s.documentJson })
  app.upsertRequest(r)
  return r
}
export async function renameRequest(request: ApiRequest, name: string) {
  await api().renameRequest(request.id, name)
  await refresh([request.collectionId])
  tabsStore.adoptRename(request.id)
}
export async function deleteRequest(request: ApiRequest) {
  await api().deleteRequest(request.id)
  await refresh([request.collectionId])
}

/** Copies a request next to the original ("<name> copy"). */
export async function duplicateRequest(request: ApiRequest): Promise<ApiRequest> {
  const copy = await api().createRequest({
    workspaceId: ws(),
    collectionId: request.collectionId,
    folderId: request.folderId,
    name: `${request.name} copy`,
    method: request.method,
    url: request.url,
    documentJson: request.documentJson,
  })
  const siblings = app
    .requestsOf(request.collectionId)
    .filter((r) => r.folderId === request.folderId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  const at = siblings.findIndex((r) => r.id === request.id)
  if (at >= 0) {
    // Best effort: place the copy directly after the original. The copy already exists, so a
    // failure here must not fail the duplicate.
    try {
      await api().moveRequest({ requestId: copy.id, targetCollectionId: request.collectionId, targetFolderId: request.folderId, targetIndex: at + 1 })
    } catch {
      /* stays at the end */
    }
  }
  await refresh([request.collectionId])
  return app.requestById(copy.id) ?? copy
}

/** Executes a plan produced by `planDrop`. */
export async function applyDrop(plan: DropPlan, affectedCollections: string[]) {
  if (plan.kind === 'request') await api().moveRequest(plan.input)
  else await api().moveFolder(plan.input)
  await refresh(affectedCollections)
}
