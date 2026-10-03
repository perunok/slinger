import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SlingerIpcApi } from '../../../shared/ipc-contract'
import { toast } from '../../app/toast.svelte'
import { createMockBackend, type MockControls } from '../../dev/mockBackend'
import { UPDATES_STORAGE_KEY } from '../../lib/updates'
import { updates } from './updates.svelte'

let backend: SlingerIpcApi & MockControls
const stored = () => JSON.parse(localStorage.getItem(UPDATES_STORAGE_KEY) ?? '{}')
const checks = () => backend.calls.filter((c) => c.method === 'checkForUpdates').length

beforeEach(() => {
  localStorage.clear()
  backend = createMockBackend({ latencyMs: 0, seed: false })
  window.slinger = backend
  updates.resetForTests()
  toast.items = []
})
afterEach(() => vi.useRealTimers())

describe('update notice', () => {
  it('automatic check: one notification per new version, linking to its release page', async () => {
    backend.setLatestRelease('1.0.0')
    await updates.check('auto')
    expect(toast.items).toHaveLength(1)
    expect(toast.items[0]).toMatchObject({ kind: 'info', title: 'Slinger 1.0.0 is available', detail: 'You have 0.0.0-dev.' })
    expect(updates.available?.version).toBe('1.0.0')
    expect(stored()).toMatchObject({ notified: '1.0.0', latest: { version: '1.0.0' } })

    const open = vi.spyOn(backend, 'openExternalUrl').mockResolvedValue(undefined)
    toast.items[0]!.action!.run()
    expect(open).toHaveBeenCalledWith('https://github.com/perunok/slinger/releases/tag/v1.0.0')

    // Next launch, same release: no second notification.
    toast.items = []
    updates.resetForTests()
    await updates.check('auto')
    expect(toast.items).toHaveLength(0)
    // A later release is announced again.
    backend.setLatestRelease('1.1.0')
    await updates.check('auto')
    expect(toast.items.map((t) => t.title)).toEqual(['Slinger 1.1.0 is available'])
  })

  it('automatic check stays silent when up to date or offline', async () => {
    await updates.check('auto')
    expect(updates.lastCheckedAt).not.toBeNull()
    backend.failNext('checkForUpdates', { code: 'network_error', message: 'Could not reach GitHub to check for updates' })
    await updates.check('auto')
    expect(updates.error).toBe('Could not reach GitHub to check for updates')
    expect(toast.items).toHaveLength(0)
  })

  it('Help > Check for Updates… always answers', async () => {
    await updates.check('menu')
    expect(toast.items.map((t) => [t.kind, t.title])).toEqual([['success', 'Slinger is up to date']])
    backend.setLatestRelease('2.0.0')
    await updates.check('menu')
    await updates.check('menu') // even when already notified about it
    expect(toast.items.filter((t) => t.title === 'Slinger 2.0.0 is available')).toHaveLength(2)
    backend.failNext('checkForUpdates', { code: 'network_error', message: 'offline' })
    await updates.check('menu')
    expect(toast.items.at(-1)).toMatchObject({ kind: 'error', title: 'Could not check for updates', detail: 'offline' })
  })

  it('Settings > Check now answers inline only, and counts as notified', async () => {
    backend.setLatestRelease('1.0.0')
    await updates.check('settings')
    expect(toast.items).toHaveLength(0)
    expect(updates.available?.version).toBe('1.0.0')
    await updates.check('auto')
    expect(toast.items).toHaveLength(0)
  })

  it('schedules the first check after startup, then at most once a day, and only while on', async () => {
    vi.useFakeTimers()
    const stop = updates.start()
    await vi.advanceTimersByTimeAsync(7000)
    expect(checks()).toBe(0)
    await vi.advanceTimersByTimeAsync(2000)
    expect(checks()).toBe(1)
    // Hourly ticks within the day do not ask again.
    await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000)
    expect(checks()).toBe(1)
    await vi.advanceTimersByTimeAsync(20 * 60 * 60 * 1000)
    expect(checks()).toBe(2)
    updates.setAuto(false)
    expect(stored().auto).toBe(false)
    await vi.advanceTimersByTimeAsync(48 * 60 * 60 * 1000)
    expect(checks()).toBe(2)
    stop()
  })
})
