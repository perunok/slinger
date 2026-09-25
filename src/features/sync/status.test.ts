import { describe, expect, it } from 'vitest'
import type { CloudSession, SyncStatus } from '../../../shared/types'
import { blockMessage, blockReason, deriveChip, formatAgo } from './status'

const NOW = 1_000_000
const base: SyncStatus = {
  workspaceId: 'w', linked: true, state: 'idle', apiBaseUrl: 'https://x', remoteWorkspaceId: 'r', remoteName: 'Team', role: 'editor',
  readOnly: false, autoSync: true, pendingChanges: 0, openConflicts: 0, initialSyncPending: false, lastSyncedAt: NOW - 120,
  lastError: null, nextRetryAt: null, progress: null,
}
const signedIn: CloudSession = { apiBaseUrl: 'https://x', status: 'signedIn', user: null, offline: false }
const chip = (s: Partial<SyncStatus>, session: CloudSession | null = signedIn) => deriveChip({ ...base, ...s }, session, NOW)

describe('formatAgo', () => {
  it('formats ranges', () => {
    expect(formatAgo(null, NOW)).toBe('never')
    expect(formatAgo(NOW - 3, NOW)).toBe('just now')
    expect(formatAgo(NOW - 45, NOW)).toBe('45 s ago')
    expect(formatAgo(NOW - 300, NOW)).toBe('5 min ago')
    expect(formatAgo(NOW - 3 * 3600, NOW)).toBe('3 h ago')
    expect(formatAgo(NOW - 3 * 86400, NOW)).toBe('3 d ago')
    expect(formatAgo(NOW + 50, NOW)).toBe('just now')
  })
})

describe('deriveChip', () => {
  it('unlinked / missing status', () => {
    expect(deriveChip(null, null, NOW).kind).toBe('unlinked')
    expect(chip({ linked: false, state: 'unlinked' }).kind).toBe('unlinked')
  })
  it('idle shows synced, pending and initial-setup labels with the last synced time', () => {
    const c = chip({})
    expect(c).toMatchObject({ kind: 'idle', tone: 'success', label: 'Synced', busy: false })
    expect(c.detail).toContain('2 min ago')
    expect(chip({ pendingChanges: 3 }).label).toBe('3 pending')
    expect(chip({ initialSyncPending: true, lastSyncedAt: null }).label).toBe('Setting up')
    expect(chip({ autoSync: false }).detail).toContain('Auto sync is off')
  })
  it('syncing reports progress and busy', () => {
    const c = chip({ state: 'syncing', progress: { phase: 'push', done: 5, total: 20 } })
    expect(c).toMatchObject({ kind: 'syncing', busy: true })
    expect(c.detail).toBe('Uploading 5/20…')
    expect(chip({ state: 'syncing', progress: { phase: 'pull', done: 0, total: null } }).detail).toBe('Checking for changes…')
  })
  it('offline includes the pending count and the retry countdown', () => {
    const c = chip({ state: 'offline', pendingChanges: 2, nextRetryAt: NOW + 12 })
    expect(c).toMatchObject({ kind: 'offline', tone: 'warning', label: 'Offline, 2 pending' })
    expect(c.detail).toContain('Retrying in 12 s')
    expect(chip({ state: 'offline' }).label).toBe('Offline')
  })
  it('error carries the message', () => {
    const c = chip({ state: 'error', lastError: { code: 'internal_error', message: 'Server exploded' } })
    expect(c).toMatchObject({ kind: 'error', tone: 'danger' })
    expect(c.detail).toContain('Server exploded')
  })
  it('conflicts outrank offline/error/syncing but not signed-out / revoked', () => {
    expect(chip({ openConflicts: 2, state: 'offline' })).toMatchObject({ kind: 'conflicts', label: '2 conflicts', conflicts: 2 })
    expect(chip({ openConflicts: 1, state: 'error' }).label).toBe('1 conflict')
    expect(chip({ openConflicts: 1, state: 'syncing' }).busy).toBe(true)
    expect(chip({ openConflicts: 1, state: 'signedOut' }).kind).toBe('signedOut')
    expect(chip({ openConflicts: 1, state: 'accessRevoked' }).kind).toBe('accessRevoked')
  })
  it('read-only', () => {
    expect(chip({ readOnly: true, role: 'viewer' })).toMatchObject({ kind: 'readOnly', readOnly: true, label: 'Read-only' })
    // the lock is still reported next to a higher-priority state
    expect(chip({ readOnly: true, state: 'offline' })).toMatchObject({ kind: 'offline', readOnly: true })
  })
  it('signed out, revoked and unsupported server', () => {
    expect(chip({ state: 'signedOut', pendingChanges: 4 }).detail).toContain('4 changes waiting')
    expect(chip({}, { ...signedIn, status: 'signedOut' }).kind).toBe('signedOut')
    expect(chip({ state: 'accessRevoked' })).toMatchObject({ kind: 'accessRevoked', tone: 'danger' })
    expect(chip({ state: 'serverUnsupported' })).toMatchObject({ kind: 'serverUnsupported' })
  })
})

describe('blockReason', () => {
  it('blocks edits for read-only and revoked, never for others', () => {
    expect(blockReason(null)).toBeNull()
    expect(blockReason({ ...base, linked: false, readOnly: true })).toBeNull()
    expect(blockReason(base)).toBeNull()
    expect(blockReason({ ...base, state: 'offline' })).toBeNull()
    expect(blockReason({ ...base, readOnly: true })).toBe('readOnly')
    expect(blockReason({ ...base, state: 'accessRevoked' })).toBe('accessRevoked')
    expect(blockReason({ ...base, state: 'accessRevoked', readOnly: true })).toBe('accessRevoked')
  })
  it('messages name the cloud workspace', () => {
    expect(blockMessage('readOnly', base)).toContain('Team')
    expect(blockMessage('accessRevoked', null)).toContain('this cloud workspace')
  })
})
