import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SlingerIpcApi } from '../../../shared/ipc-contract'
import { toast } from '../../app/toast.svelte'
import { ui } from '../../app/ui.svelte'
import { createMockBackend, type MockControls } from '../../dev/mockBackend'
import { methodNote, percent, timeLeft } from './progress'
import UpdateDialog from './UpdateDialog.svelte'
import { updates } from './updates.svelte'

let backend: SlingerIpcApi & MockControls
let stop: () => void

beforeEach(async () => {
  localStorage.clear()
  backend = createMockBackend({ latencyMs: 0, seed: false })
  window.slinger = backend
  updates.resetForTests()
  toast.items = []
  ui.updateOpen = false
})
afterEach(() => {
  stop?.()
  cleanup()
  ui.updateOpen = false
})

async function startWith(release: string | null, install?: Awaited<ReturnType<SlingerIpcApi['getUpdateInstallState']>>, notes?: string | null) {
  backend.setLatestRelease(release, notes)
  if (install) vi.spyOn(backend, 'getUpdateInstallState').mockResolvedValue(install)
  stop = updates.start()
  await waitFor(() => expect(updates.install).not.toBeNull())
  await updates.check('auto')
}

describe('Update Slinger', () => {
  it('the notification updates with one click: progress, then Restart to update installs', async () => {
    await startWith('1.0.0')
    expect(toast.items[0]).toMatchObject({ title: 'Slinger 1.0.0 is available', action: { label: 'Update now' } })
    toast.items[0]!.action!.run()
    expect(ui.updateOpen).toBe(true)
    render(UpdateDialog)
    expect(screen.getByTestId('update-dialog')).toHaveTextContent('Slinger 1.0.0 · you have 0.0.0-dev')
    const bar = await screen.findByRole('progressbar', { name: 'Download progress' })
    await waitFor(() => expect(Number(bar.getAttribute('aria-valuenow'))).toBeGreaterThan(0))
    expect(screen.getByTestId('update-progress-text')).toHaveTextContent(/MB of 85.00 MB \(\d+%\)/)
    expect(screen.getByTestId('update-progress-text')).toHaveTextContent(/\/s · \d+ s left/)

    expect(await screen.findByTestId('update-ready', {}, { timeout: 3000 })).toHaveTextContent('your system asks for your password')
    const install = vi.spyOn(backend, 'installUpdate')
    await fireEvent.click(screen.getByRole('button', { name: 'Restart to update' }))
    expect(install).toHaveBeenCalledOnce()
    expect(await screen.findByTestId('update-installing')).toHaveTextContent('enter your password in the system dialog')
  })

  it('Cancel stops the download; Update now starts it again', async () => {
    await startWith('1.0.0')
    void updates.updateNow()
    render(UpdateDialog)
    await screen.findByRole('progressbar')
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(updates.install?.phase).toBe('idle'))
    expect(screen.getByRole('button', { name: 'Update now' })).toBeInTheDocument()
  })

  it('a failed download says why and offers Try again and the release page', async () => {
    await startWith('1.0.0')
    backend.failNext('downloadUpdate', { code: 'io_error', message: 'The downloaded installer does not match GitHub\'s checksum' })
    await updates.updateNow()
    render(UpdateDialog)
    expect(screen.getByText(/does not match GitHub's checksum/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    const open = vi.spyOn(backend, 'openExternalUrl').mockResolvedValue(undefined)
    await fireEvent.click(screen.getByRole('button', { name: 'View release' }))
    expect(open).toHaveBeenCalledWith('https://github.com/perunok/slinger/releases/tag/v1.0.0')
  })

  it('an installation that cannot update itself keeps the release page', async () => {
    await startWith('1.0.0', {
      method: null, unsupportedReason: 'This is a development build: update it from the source, or install a release.',
      phase: 'idle', version: null, received: 0, total: null, bytesPerSec: null, error: null,
    })
    expect(toast.items[0]!.action!.label).toBe('View release')
    ui.updateOpen = true
    render(UpdateDialog)
    expect(screen.getByTestId('update-unsupported')).toHaveTextContent('development build')
    expect(screen.getByRole('button', { name: 'View release' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Update now' })).toBeNull()
  })
})

describe('release notes before installing', () => {
  it('shows the new version’s notes as rendered Markdown before Update now', async () => {
    await startWith('1.0.0', undefined, '### New\n- **Bold** feature\n\n[Docs](https://example.com/docs)')
    ui.updateOpen = true
    render(UpdateDialog)
    const notes = screen.getByTestId('update-notes')
    expect(notes).toHaveAccessibleName('What’s new in Slinger 1.0.0')
    expect(notes.querySelector('h3')).toHaveTextContent('New')
    expect(notes.querySelector('strong')).toHaveTextContent('Bold')
    expect(screen.queryByTestId('update-notes-link')).toBeNull()
    expect(screen.getByRole('button', { name: 'Update now' })).toBeInTheDocument()
    // Links leave through the system browser, never the app window.
    const open = vi.spyOn(backend, 'openExternalUrl').mockResolvedValue(undefined)
    await fireEvent.click(screen.getByRole('link', { name: 'Docs' }))
    expect(open).toHaveBeenCalledWith('https://example.com/docs')
  })

  it('sanitises the notes: no scripts, handlers or remote images', async () => {
    await startWith('1.0.0', undefined, '<script>window.pwned = 1</script><img src="https://evil.example/x.png" onerror="window.pwned = 2" alt="x"><a href="javascript:alert(1)">bad</a>')
    ui.updateOpen = true
    render(UpdateDialog)
    const notes = screen.getByTestId('update-notes')
    expect(notes.querySelector('script')).toBeNull()
    expect(notes.querySelector('img[src^="https:"]')).toBeNull()
    expect(notes.innerHTML).not.toMatch(/onerror|javascript:/)
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined()
  })

  it('a release without notes links to its GitHub page instead', async () => {
    await startWith('1.0.0', undefined, null)
    ui.updateOpen = true
    render(UpdateDialog)
    expect(screen.queryByTestId('update-notes')).toBeNull()
    const open = vi.spyOn(backend, 'openExternalUrl').mockResolvedValue(undefined)
    await fireEvent.click(screen.getByRole('button', { name: 'See release notes on GitHub' }))
    expect(open).toHaveBeenCalledWith('https://github.com/perunok/slinger/releases/tag/v1.0.0')
  })
})

describe('progress wording', () => {
  it('percent and time left', () => {
    expect(percent({ received: 50, total: 200 })).toBe(25)
    expect(percent({ received: 50, total: null })).toBe(0)
    expect(timeLeft({ received: 0, total: 6_000_000, bytesPerSec: 1_000_000 })).toBe('6 s')
    expect(timeLeft({ received: 0, total: 600_000_000, bytesPerSec: 1_000_000 })).toBe('10 min')
    expect(timeLeft({ received: 0, total: 100, bytesPerSec: null })).toBeNull()
  })
  it('explains every install method', () => {
    for (const m of ['deb', 'appimage', 'nsis', 'dmg'] as const) expect(methodNote(m)).toContain('checksum')
  })
})
