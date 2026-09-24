/** Which destinations are offered when linking a cloud workspace, and which one is recommended (design 9.2). */
import type { RemoteWorkspaceCounts, RemoteWorkspacePreview } from '../../../shared/types'

export interface LinkPlan {
  /** Merging into the current local workspace is possible. */
  canMerge: boolean
  /** Recommended destination. */
  mode: 'merge' | 'new'
  /** Why merging is not offered. */
  reason: string
}

export function linkPlan(input: {
  preview: RemoteWorkspacePreview | null
  localHasContent: boolean
  localLinked: boolean
  hasLocalWorkspace: boolean
}): LinkPlan {
  const { preview, localHasContent, localLinked, hasLocalWorkspace } = input
  if (!hasLocalWorkspace) return { canMerge: false, mode: 'new', reason: 'It will be downloaded into a new workspace.' }
  if (localLinked) return { canMerge: false, mode: 'new', reason: 'The current workspace is already synced with another cloud workspace, so this one will be downloaded into a new workspace.' }
  if (preview?.role === 'viewer' && localHasContent) {
    return { canMerge: false, mode: 'new', reason: 'You have read-only access to this cloud workspace, so what is in the current workspace cannot be uploaded. It will be downloaded into a new, read-only workspace.' }
  }
  // Recommended: a new workspace when there is local content and the remote is not empty (a merge could duplicate things).
  const mode = localHasContent && preview?.remoteEmpty !== true ? 'new' : 'merge'
  return { canMerge: true, mode, reason: '' }
}

/** "1 collection, 3 requests, 2 environments" for a cloud workspace preview; null when the server gave no counts. */
export function remoteContentSummary(counts: RemoteWorkspaceCounts | null | undefined): string | null {
  if (!counts) return null
  const n = (x: number, one: string) => `${counts.truncated ? 'at least ' : ''}${x} ${one}${x === 1 ? '' : 's'}`
  return [n(counts.collections, 'collection'), n(counts.requests, 'request'), n(counts.environments, 'environment')].join(', ')
}
