/** Wording and grouping for the conflict center. Pure so it can be unit tested. */
import type { SyncConflict, SyncConflictKind, SyncResolution } from '../../../shared/types'

export const KIND_ORDER: SyncConflictKind[] = ['edit_edit', 'remote_deleted', 'local_deleted', 'immutable_clash', 'rejected', 'duplicate_key']

export const KIND_TITLE: Record<SyncConflictKind, string> = {
  edit_edit: 'Changed in both places',
  remote_deleted: 'Deleted in the cloud',
  local_deleted: 'Deleted here',
  immutable_clash: 'Version number clash',
  rejected: 'Rejected by the cloud',
  duplicate_key: 'Renamed automatically',
}

export const KIND_HELP: Record<SyncConflictKind, string> = {
  edit_edit: 'The same part of an item was edited here and in the cloud. Until you choose, your local values are kept and not uploaded.',
  remote_deleted: 'Someone deleted this in the cloud, but you have changes to it that were never uploaded. It is kept here until you decide.',
  local_deleted: 'You deleted this here, but it was edited in the cloud. The deletion is not uploaded until you decide.',
  immutable_clash: 'Another device created a version with the same number but different content. Versions cannot be changed, so one has to give way.',
  rejected: 'The cloud refused this change (for example an id that is already used or a value that is too long). It stays on this device only.',
  duplicate_key: 'Both sides added a variable with the same name; the local one was renamed. Nothing to do.',
}

export interface ResolutionUi {
  label: string
  description: string
  variant: 'default' | 'primary' | 'danger'
}

export function resolutionUi(kind: SyncConflictKind, r: SyncResolution): ResolutionUi {
  switch (kind) {
    case 'remote_deleted':
      if (r === 'keep_local') return { label: 'Restore in the cloud', description: 'Upload my version again so it exists in the cloud.', variant: 'primary' }
      return { label: 'Delete here too', description: 'Accept the cloud deletion and remove it (and my unsent changes) from this device.', variant: 'danger' }
    case 'local_deleted':
      if (r === 'keep_local') return { label: 'Delete in the cloud too', description: 'Upload my deletion; the cloud edits are lost.', variant: 'danger' }
      return { label: 'Restore it here', description: 'Bring the cloud version back to this device.', variant: 'primary' }
    case 'immutable_clash':
      if (r === 'duplicate') return { label: 'Keep mine as a new version', description: 'Recreate my snapshot under a new version number.', variant: 'primary' }
      return { label: 'Use the cloud version', description: 'Drop my version and keep the one from the cloud.', variant: 'default' }
    case 'rejected':
      return { label: 'Discard my change', description: 'Throw away the change the cloud refused (a never-uploaded item is deleted here).', variant: 'danger' }
    default:
      break
  }
  switch (r) {
    case 'keep_local':
      return { label: 'Keep mine', description: 'Use my values and upload them, replacing the cloud values.', variant: 'primary' }
    case 'keep_remote':
      return { label: 'Use cloud version', description: 'Replace my values with the cloud values.', variant: 'default' }
    case 'merge':
      return { label: 'Merge choices', description: 'Take mine or the cloud value separately for each part below.', variant: 'primary' }
    case 'duplicate':
      return { label: 'Keep both', description: 'Keep my version as a copy named "(conflict copy)" and take the cloud version for the original.', variant: 'default' }
  }
}

export interface KindSection {
  kind: SyncConflictKind
  title: string
  items: SyncConflict[]
}

/** Groups conflicts by kind in a stable, meaningful order; empty sections are dropped. */
export function groupByKind(conflicts: SyncConflict[]): KindSection[] {
  return KIND_ORDER.map((kind) => ({ kind, title: KIND_TITLE[kind], items: conflicts.filter((c) => c.kind === kind) })).filter((s) => s.items.length > 0)
}

/** Flat order in which the list is navigated with the keyboard (same as the visual order). */
export function flatOrder(conflicts: SyncConflict[]): SyncConflict[] {
  return groupByKind(conflicts).flatMap((s) => s.items)
}

export function pathText(path: string[], label: string): string {
  return path.length > 0 ? path.join(' / ') : label
}

/** Conflicts that a bulk resolution can be applied to (open, and the resolution is allowed for them). */
export function bulkTargets(conflicts: SyncConflict[], selected: ReadonlySet<string>, resolution: SyncResolution): { apply: SyncConflict[]; skipped: SyncConflict[] } {
  const chosen = conflicts.filter((c) => selected.has(c.id) && c.status === 'open')
  return { apply: chosen.filter((c) => c.allowedResolutions.includes(resolution)), skipped: chosen.filter((c) => !c.allowedResolutions.includes(resolution)) }
}

/** Next item to focus after `removedId` disappears from `order`. */
export function nextAfterRemoval(order: SyncConflict[], removedId: string): string | null {
  const i = order.findIndex((c) => c.id === removedId)
  if (i < 0) return order[0]?.id ?? null
  return order[i + 1]?.id ?? order[i - 1]?.id ?? null
}

/** A `merge` needs a choice for every conflicting group. */
export function mergeReady(c: Pick<SyncConflict, 'groups'>, choices: Partial<Record<string, 'local' | 'remote'>>): boolean {
  return c.groups.filter((g) => g.conflicting).every((g) => choices[g.group] === 'local' || choices[g.group] === 'remote')
}
