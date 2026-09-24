/**
 * Decides what an open editor tab should tell the user after a pull changed or deleted its request.
 * Pure: the sync store feeds it the tabs' facts and the freshly loaded requests, then applies the result.
 *
 * Rules (never clobber the user's work):
 *  - tab not affected by the change            -> nothing
 *  - tab clean                                 -> nothing to say (the tab reloads by itself, see tabs.syncWithServer)
 *  - tab dirty, request content changed        -> 'changed' banner: Reload from cloud / Keep my edits
 *  - tab dirty, request gone (deleted remotely)-> 'deleted' banner: Save as new / Close
 */
import type { ApiRequest } from '../../../shared/types'

export interface TabFacts {
  tabId: string
  /** null once the tab lost its request (deleted meanwhile) */
  requestId: string | null
  dirty: boolean
  /** name|method|url|document the tab was loaded from */
  serverKey: string
}

export type TabNotice = { kind: 'changed'; server: ApiRequest } | { kind: 'deleted' }

export const serverKey = (r: Pick<ApiRequest, 'name' | 'method' | 'url' | 'documentJson'>) =>
  `${r.name}\u0000${r.method}\u0000${r.url}\u0000${r.documentJson}`

/** Which dirty tabs are affected by `changedRequestIds` (call BEFORE reloading: reload detaches deleted ones). */
export function affectedDirtyTabs(tabs: Array<Pick<TabFacts, 'tabId' | 'requestId' | 'dirty'>>, changedRequestIds: ReadonlySet<string>, truncated: boolean): string[] {
  return tabs.filter((t) => t.dirty && t.requestId !== null && (truncated || changedRequestIds.has(t.requestId))).map((t) => t.tabId)
}

/**
 * After the reload: `requestById` finds the fresh server row. `originalIds` maps tab id -> the request id
 * captured before the reload. Returns the notice per affected tab (tabs needing none are omitted).
 */
export function planNotices(
  tabs: TabFacts[],
  affected: readonly string[],
  originalIds: ReadonlyMap<string, string>,
  requestById: (id: string) => ApiRequest | undefined,
): Map<string, TabNotice> {
  const out = new Map<string, TabNotice>()
  for (const t of tabs) {
    if (!affected.includes(t.tabId) || !t.dirty) continue
    const id = originalIds.get(t.tabId)
    if (!id) continue
    const server = requestById(id)
    if (!server) {
      out.set(t.tabId, { kind: 'deleted' })
      continue
    }
    if (serverKey(server) !== t.serverKey) out.set(t.tabId, { kind: 'changed', server })
  }
  return out
}
