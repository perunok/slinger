/**
 * Pure derivation of what the sync chip / banners show from a SyncStatus (+ session). No state, no IPC.
 * Priority when several conditions hold: accessRevoked > serverUnsupported > signedOut > conflicts >
 * error > offline > syncing > readOnly > idle. `busy` and `readOnly` are reported separately so the UI can
 * still show a spinner or a lock next to a higher-priority state.
 */
import type { CloudSession, SyncStatus } from '../../../shared/types'

export type ChipKind =
  | 'unlinked'
  | 'accessRevoked'
  | 'serverUnsupported'
  | 'signedOut'
  | 'conflicts'
  | 'error'
  | 'offline'
  | 'syncing'
  | 'readOnly'
  | 'idle'

export type ChipTone = 'neutral' | 'success' | 'warning' | 'danger' | 'accent'

export interface Chip {
  kind: ChipKind
  tone: ChipTone
  icon: string
  label: string
  /** One-line explanation for the tooltip and the popover header. */
  detail: string
  busy: boolean
  readOnly: boolean
  pending: number
  conflicts: number
}

/** "just now", "5 min ago", "3 h ago", "2 d ago". `at` and `now` are epoch seconds. */
export function formatAgo(at: number | null, now: number): string {
  if (at === null) return 'never'
  const s = Math.max(0, now - at)
  if (s < 10) return 'just now'
  if (s < 60) return `${s} s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.floor(h / 24)} d ago`
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function deriveChip(status: SyncStatus | null | undefined, session: CloudSession | null, now: number): Chip {
  const base: Chip = {
    kind: 'unlinked', tone: 'neutral', icon: 'cloud', label: 'Local only', detail: 'This workspace is not synced to the cloud.',
    busy: false, readOnly: false, pending: 0, conflicts: 0,
  }
  if (!status || !status.linked || status.state === 'unlinked') return base
  const pending = status.pendingChanges
  const conflicts = status.openConflicts
  const synced = `Last synced ${formatAgo(status.lastSyncedAt, now)}`
  const pendingText = pending > 0 ? ` ${plural(pending, 'change')} waiting to upload.` : ''
  const common = { busy: status.state === 'syncing', readOnly: status.readOnly, pending, conflicts }
  const err = status.lastError?.message ? ` ${status.lastError.message}` : ''

  if (status.state === 'accessRevoked') {
    return { ...common, kind: 'accessRevoked', tone: 'danger', icon: 'lock', label: 'Access revoked', detail: `You no longer have access to ${status.remoteName ?? 'this cloud workspace'}. Local content is kept; unlink to keep working on it.${pendingText}` }
  }
  if (status.state === 'serverUnsupported') {
    return { ...common, kind: 'serverUnsupported', tone: 'danger', icon: 'alert', label: 'Server too old', detail: 'This server does not support collection sync (protocol version 2 is required).' }
  }
  if (status.state === 'signedOut' || session?.status === 'signedOut') {
    return { ...common, kind: 'signedOut', tone: 'warning', icon: 'user', label: 'Signed out', detail: `Sign in to keep syncing.${pendingText} ${synced}.`.replace('  ', ' ') }
  }
  if (conflicts > 0) {
    return { ...common, kind: 'conflicts', tone: 'warning', icon: 'alert', label: `${plural(conflicts, 'conflict')}`, detail: `${plural(conflicts, 'change')} could not be merged automatically and need a decision.${pendingText}` }
  }
  if (status.state === 'error') {
    return { ...common, kind: 'error', tone: 'danger', icon: 'alert', label: 'Sync error', detail: `Sync failed.${err}${pendingText}`.trim() }
  }
  if (status.state === 'offline') {
    const retry = status.nextRetryAt ? ` Retrying ${status.nextRetryAt > now ? `in ${status.nextRetryAt - now} s` : 'now'}.` : ''
    return { ...common, kind: 'offline', tone: 'warning', icon: 'globe', label: pending > 0 ? `Offline, ${pending} pending` : 'Offline', detail: `Cannot reach the cloud.${retry}${pendingText} ${synced}.` }
  }
  if (status.state === 'syncing') {
    const p = status.progress
    const what = p ? `${p.phase === 'push' ? 'Uploading' : p.phase === 'snapshot' ? 'Downloading' : 'Checking for changes'}${p.total !== null ? ` ${p.done}/${p.total}` : ''}` : 'Syncing'
    return { ...common, kind: 'syncing', tone: 'accent', icon: 'refresh', label: status.initialSyncPending && p?.total ? `${what}` : 'Syncing', detail: `${what}…` }
  }
  if (status.readOnly) {
    return { ...common, kind: 'readOnly', tone: 'neutral', icon: 'lock', label: 'Read-only', detail: `You have viewer access to ${status.remoteName ?? 'this workspace'}: edits are disabled. ${synced}.` }
  }
  const label = pending > 0 ? `${pending} pending` : status.initialSyncPending ? 'Setting up' : 'Synced'
  return { ...common, kind: 'idle', tone: 'success', icon: 'check', label, detail: `${status.autoSync ? 'Auto sync is on.' : 'Auto sync is off.'} ${synced}.${pendingText}` }
}

/** Why edits are blocked in a workspace, or null when they are allowed. */
export type BlockReason = 'readOnly' | 'accessRevoked'

export function blockReason(status: SyncStatus | null | undefined): BlockReason | null {
  if (!status || !status.linked) return null
  if (status.state === 'accessRevoked') return 'accessRevoked'
  if (status.readOnly) return 'readOnly'
  return null
}

export function blockMessage(reason: BlockReason, status: SyncStatus | null | undefined): string {
  const name = status?.remoteName ?? 'this cloud workspace'
  return reason === 'readOnly'
    ? `You have viewer access to ${name}, so this workspace is read-only.`
    : `You no longer have access to ${name}, so editing is disabled.`
}
