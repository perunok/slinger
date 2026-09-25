/**
 * Example mutations from the collection tree and the response pane. Examples live in the parent
 * request's document (`responses`), so every mutation is one `updateRequest` with the request's
 * expected version. Each function throws on failure so dialogs can show the error inline.
 */
import type { ApiRequest, HttpResponseData } from '../../../shared/types'
import { expandedStore } from '../../app/expanded.svelte'
import { app } from '../../app/state.svelte'
import {
  assertDocumentFits,
  blankExample,
  duplicateExample,
  exampleFromResponse,
  exampleName,
  locateExample,
  locatorFor,
  readExamples,
  statusReason,
  updateExamples,
  type ExampleLocator,
} from '../../lib/examples'
import { api, isVersionConflict } from '../../lib/ipc'
import { parseDocument, type RequestDraft } from '../../lib/request'
import { rowKey } from '../collections/rows'
import { tabsStore } from '../requests/tabs.svelte'

function requireRequest(requestId: string): ApiRequest {
  const r = app.requestById(requestId)
  if (!r) throw new Error('The request no longer exists.')
  return r
}

/**
 * Replaces the request's example list with `fn(list)` and saves it. When the cached request was
 * stale (version_conflict) the collection is reloaded and `fn` runs once more on the fresh list,
 * which is safe because every `fn` here re-finds its example by locator.
 */
export async function mutateExamples(requestId: string, fn: (list: unknown[]) => unknown[]): Promise<ApiRequest> {
  let request = requireRequest(requestId)
  for (let attempt = 0; ; attempt++) {
    const documentJson = updateExamples(request.documentJson, fn)
    assertDocumentFits(documentJson)
    try {
      const updated = await api().updateRequest({
        requestId: request.id,
        name: request.name,
        method: request.method,
        url: request.url,
        documentJson,
        expectedVersion: request.version,
      })
      tabsStore.afterExamplesWrite(updated)
      return updated
    } catch (e) {
      if (attempt > 0 || !isVersionConflict(e)) throw e
      await app.reloadCollection(request.collectionId)
      request = requireRequest(requestId)
    }
  }
}

/** The locator of example `index` as currently stored (what the tree row shows). */
export function currentLocator(requestId: string, index: number): ExampleLocator {
  const list = readExamples(requireRequest(requestId).documentJson)
  if (index >= list.length) throw new Error('The example no longer exists.')
  return locatorFor(list, index)
}

function find(list: unknown[], loc: ExampleLocator): number {
  const found = locateExample(list, loc)
  if (!found || found.changed) throw new Error('The example was changed elsewhere. Try again.')
  return found.index
}

export function openExample(requestId: string, index: number) {
  const r = app.requestById(requestId)
  if (r) tabsStore.openExample(r, index)
}

export function revealExamples(request: Pick<ApiRequest, 'id'>) {
  expandedStore.set(rowKey('request', request.id), true)
}

export async function renameExample(requestId: string, index: number, name: string): Promise<void> {
  const loc = currentLocator(requestId, index)
  const open = tabsStore.findExample(requestId, index)
  let at = -1
  const updated = await mutateExamples(requestId, (list) => {
    at = find(list, loc)
    const current = list[at]
    list[at] = current && typeof current === 'object' && !Array.isArray(current) ? { ...current, name } : { name }
    return list
  })
  // An open tab keeps its other unsaved edits and adopts the new name (like a renamed request tab).
  if (open && open.example && at >= 0) {
    open.rebaseExample(updated, at)
    if (open.exampleDraft) open.exampleDraft.name = name
  }
}

/** Copies an example directly after the original as "<name> copy" and opens the copy. */
export async function duplicateExampleAt(requestId: string, index: number): Promise<void> {
  const loc = currentLocator(requestId, index)
  let at = -1
  const updated = await mutateExamples(requestId, (list) => {
    const i = find(list, loc)
    at = i + 1
    list.splice(at, 0, duplicateExample(list[i], `${exampleName(list[i])} copy`))
    return list
  })
  tabsStore.openExample(updated, at)
}

export async function deleteExampleAt(requestId: string, index: number): Promise<void> {
  const loc = currentLocator(requestId, index)
  const open = tabsStore.findExample(requestId, index)
  await mutateExamples(requestId, (list) => {
    list.splice(find(list, loc), 1)
    return list
  })
  // The user confirmed the delete: its tab goes too, even with unsaved edits.
  if (open) tabsStore.closeNow([open.id])
}

/** "Add example": an empty 200 example using the request as stored. */
export async function addExample(requestId: string, name: string): Promise<void> {
  const request = requireRequest(requestId)
  let at = -1
  const updated = await mutateExamples(requestId, (list) => {
    at = list.length
    return [...list, blankExample(name, parseDocument(request))]
  })
  revealExamples(updated)
  tabsStore.openExample(updated, at)
}

/**
 * "Save as example" from a live response: the tab's current request (as sent, templates unresolved)
 * plus the response. Unsaved edits to the request itself are NOT saved; only the example is added.
 * Returns the new example's index and an optional note about how a binary body was stored.
 */
export async function saveResponseAsExample(
  requestId: string,
  name: string,
  request: RequestDraft,
  response: HttpResponseData,
): Promise<{ index: number; note: string | null; request: ApiRequest }> {
  const { example, note } = exampleFromResponse({ name, request, response })
  let index = -1
  const updated = await mutateExamples(requestId, (list) => {
    index = list.length
    return [...list, example]
  })
  revealExamples(updated)
  return { index, note, request: updated }
}

/** Default name offered by "Save as example": status code and reason, e.g. "201 Created". */
export function defaultExampleName(response: Pick<HttpResponseData, 'status' | 'statusText'>): string {
  return `${response.status} ${response.statusText || statusReason(response.status)}`.trim()
}
