import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SlingerIpcApi } from '../../../shared/ipc-contract'
import { ui } from '../../app/ui.svelte'
import { createMockBackend, type MockControls } from '../../dev/mockBackend'
import { releasedEntries, WHATS_NEW_STORAGE_KEY } from '../../lib/releaseNotes'
import { CHANGELOG } from './changelog'
import ReleaseNotesDialog from './ReleaseNotesDialog.svelte'
import { checkWhatsNew } from './whatsNew'

let backend: SlingerIpcApi & MockControls
const released = releasedEntries(CHANGELOG)
const newest = released[0]!
const previous = released[1]!

beforeEach(() => {
  localStorage.clear()
  backend = createMockBackend({ latencyMs: 0, seed: false })
  window.slinger = backend
  ui.releaseNotes = null
})
afterEach(() => {
  cleanup()
  ui.releaseNotes = null
})

describe('bundled CHANGELOG.md', () => {
  it('is parsed at build time, with released versions back to 0.1.0', () => {
    expect(released.length).toBeGreaterThan(20)
    expect(released.at(-1)!.version).toBe('0.1.0')
  })
})

describe('Release notes dialog', () => {
  it('lists every released version as rendered Markdown; Close closes', async () => {
    const onclose = vi.fn()
    render(ReleaseNotesDialog, { view: { mode: 'all' }, onclose, onshowall: vi.fn() })
    expect(screen.getByRole('dialog', { name: 'Release notes' })).toBeInTheDocument()
    const headings = [...screen.getByTestId('release-notes').querySelectorAll('h2')].map((h) => h.textContent?.replace(/#$/, ''))
    expect(headings).toEqual(released.map((e) => `${e.version} · ${e.date}`))
    expect(screen.queryByRole('button', { name: 'All release notes' })).toBeNull()
    await fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onclose).toHaveBeenCalled()
  })

  it('What’s new shows only the versions since the last seen one, with All release notes', async () => {
    const onshowall = vi.fn()
    render(ReleaseNotesDialog, { view: { mode: 'new', after: previous.version, current: newest.version }, onclose: vi.fn(), onshowall })
    expect(screen.getByRole('dialog', { name: `What’s new in Slinger ${newest.version}` })).toBeInTheDocument()
    const headings = [...screen.getByTestId('release-notes').querySelectorAll('h2')].map((h) => h.textContent?.replace(/#$/, ''))
    expect(headings).toEqual([`${newest.version} · ${newest.date}`])
    await fireEvent.click(screen.getByRole('button', { name: 'All release notes' }))
    expect(onshowall).toHaveBeenCalled()
  })
})

describe('checkWhatsNew', () => {
  const seen = () => JSON.parse(localStorage.getItem(WHATS_NEW_STORAGE_KEY) ?? 'null') as { seen: string } | null

  it('opens What’s new on the first start of a new version, once', async () => {
    vi.spyOn(backend, 'getAppVersion').mockResolvedValue(newest.version)
    localStorage.setItem(WHATS_NEW_STORAGE_KEY, JSON.stringify({ seen: previous.version }))
    await checkWhatsNew()
    expect(ui.releaseNotes).toEqual({ mode: 'new', after: previous.version, current: newest.version })
    expect(seen()).toEqual({ seen: newest.version })
    ui.releaseNotes = null
    await checkWhatsNew()
    expect(ui.releaseNotes).toBeNull()
  })

  it('a fresh install only remembers the version', async () => {
    vi.spyOn(backend, 'getAppVersion').mockResolvedValue(newest.version)
    await checkWhatsNew()
    expect(ui.releaseNotes).toBeNull()
    expect(seen()).toEqual({ seen: newest.version })
  })

  it('an installation from before What’s new gets the running version’s notes', async () => {
    vi.spyOn(backend, 'getAppVersion').mockResolvedValue(newest.version)
    localStorage.setItem('slinger.workspace', 'w1')
    await checkWhatsNew()
    expect(ui.releaseNotes).toEqual({ mode: 'new', after: null, current: newest.version })
  })

  it('stays quiet without notes for the version, in development builds and when the version is unknown', async () => {
    localStorage.setItem(WHATS_NEW_STORAGE_KEY, JSON.stringify({ seen: '98.0.0' }))
    const version = vi.spyOn(backend, 'getAppVersion').mockResolvedValue('99.0.0')
    await checkWhatsNew()
    expect(ui.releaseNotes).toBeNull()
    version.mockResolvedValue('0.0.0-dev') // the browser mock's own version
    await checkWhatsNew()
    expect(ui.releaseNotes).toBeNull()
    version.mockRejectedValue(new Error('no'))
    await expect(checkWhatsNew()).resolves.toBeUndefined()
    expect(ui.releaseNotes).toBeNull()
  })
})
