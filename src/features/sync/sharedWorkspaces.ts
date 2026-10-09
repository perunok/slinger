/**
 * Cloud workspaces someone shared with you that are not on this device yet: the banner offers to open them
 * (link + download into a new local workspace) or to dismiss them. Dismissals are remembered per device, per
 * server and account, in localStorage; nothing about them goes to main or the server.
 */
import type { CloudRole, RemoteWorkspace } from '../../../shared/types'

const STORAGE_KEY = 'slinger.sharedWorkspaces.dismissed'
/** Old entries are dropped first once this many are remembered. */
const MAX_REMEMBERED = 500

export const shareKey = (apiBaseUrl: string, userId: string, remoteId: string) => `${apiBaseUrl}|${userId}|${remoteId}`

/** Unlinked workspaces you did not create (not owner) and did not dismiss on this device, in server order. */
export function newShares(remotes: readonly RemoteWorkspace[], dismissed: ReadonlySet<string>, apiBaseUrl: string, userId: string): RemoteWorkspace[] {
  return remotes.filter((r) => r.role !== 'owner' && !r.linkedLocalWorkspaceId && !dismissed.has(shareKey(apiBaseUrl, userId, r.id)))
}

const ROLE_LABEL: Record<CloudRole, string> = { owner: 'owner', admin: 'admin', editor: 'editor', viewer: 'viewer (read-only)' }

/** Banner text: one workspace by name (and who added you, when the server says), or a count. */
export function shareNoticeText(shares: readonly RemoteWorkspace[]): string {
  if (shares.length === 1) {
    const s = shares[0]!
    const who = s.addedBy ? `${s.addedBy.displayName} added you` : 'You were added'
    return `${who} to the cloud workspace “${s.name}” as ${ROLE_LABEL[s.role]}.`
  }
  return `You were added to ${shares.length} cloud workspaces.`
}

export function loadDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const list: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

export function saveDismissed(keys: ReadonlySet<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...keys].slice(-MAX_REMEMBERED)))
  } catch {
    /* storage unavailable: the banner just comes back next time */
  }
}
