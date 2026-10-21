/** Pure helpers for the "Team" view of a shared cloud workspace (no state, no IPC). */
import type { CloudRole, SyncStatus, Workspace, WorkspaceMember } from '../../../shared/types'

/**
 * A workspace counts as a team when it came down from the cloud (`workspaceType` 'team') or when the cloud workspace
 * it is linked to has more than one active member (a personal workspace that was published and then shared).
 */
export function isTeamWorkspace(ws: Pick<Workspace, 'workspaceType'>, status: Pick<SyncStatus, 'members'> | null | undefined): boolean {
  return ws.workspaceType === 'team' || (status?.members ?? 0) > 1
}

/** "1 member", "5 members". */
export function membersLabel(count: number): string {
  return `${count} member${count === 1 ? '' : 's'}`
}

const ROLE_RANK: Record<CloudRole, number> = { owner: 0, admin: 1, editor: 2, viewer: 3 }

export const ROLE_LABEL: Record<CloudRole, string> = { owner: 'Owner', admin: 'Admin', editor: 'Editor', viewer: 'Viewer' }

/** What a member may do, for the role badge tooltip. */
export const ROLE_HINT: Record<CloudRole, string> = {
  owner: 'Owner: full control, including members and deleting the workspace',
  admin: 'Admin: can manage members and edit',
  editor: 'Editor: can edit collections, requests and environments',
  viewer: 'Viewer: read-only',
}

/** Owners first, then admins, editors, viewers; by name (then email) inside a role. A new array. */
export function sortMembers(members: readonly WorkspaceMember[]): WorkspaceMember[] {
  const name = (m: WorkspaceMember) => (m.displayName || m.email).toLowerCase()
  return [...members].sort(
    (a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role] || name(a).localeCompare(name(b)) || a.email.toLowerCase().localeCompare(b.email.toLowerCase()),
  )
}

/** The name to show for a member: the display name, else the email. */
export function memberName(m: Pick<WorkspaceMember, 'displayName' | 'email'>): string {
  return m.displayName.trim() || m.email
}

/** "Joined 3 Mar 2026" from Unix seconds; empty when unknown (0). */
export function formatJoined(joinedAt: number): string {
  if (!joinedAt) return ''
  return `Joined ${new Date(joinedAt * 1000).toLocaleDateString([], { dateStyle: 'medium' })}`
}
