import { cleanup, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CollectionVersion, CollectionVersionDetail } from '../../../shared/types'
import { app } from '../../app/state.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import { sync } from '../sync/syncStore.svelte'
import VersionCompare from './VersionCompare.svelte'
import VersionDetail from './VersionDetail.svelte'
import VersionList from './VersionList.svelte'

const ME = { id: 'user-1', email: 'ana@example.com', displayName: 'Ana Silva' }
const signIn = () => (sync.session = { apiBaseUrl: 'https://cloud.test', status: 'signedIn', user: ME, offline: false })
const NOW = Math.floor(Date.now() / 1000)

const version = (over: Partial<CollectionVersion>): CollectionVersion => ({
  id: crypto.randomUUID(), workspaceId: 'w', collectionId: 'c', version: '1.0.0', notes: null, folderCount: 1, requestCount: 2,
  createdAt: NOW - 3 * 3600, createdBy: null, ...over,
})

afterEach(() => {
  cleanup()
  sync.session = null
})
beforeEach(() => {
  sync.session = null
})

describe('VersionList', () => {
  it('shows the author and the relative date; an unknown author shows the date only', () => {
    const versions = [
      version({ id: 'a', version: '1.2.0', createdBy: { id: 'user-2', name: 'Bruno Costa' }, createdAt: NOW - 5 * 60 }),
      version({ id: 'b', version: '1.1.0', createdBy: null, createdAt: NOW - 3 * 3600 }),
    ]
    render(VersionList, { versions, selectedId: null, onselect: () => {} })
    const lines = screen.getAllByTestId('version-byline').map((e) => e.textContent)
    expect(lines).toEqual(['Bruno Costa · 5 min ago', '3 h ago'])
    expect(lines[1]).not.toMatch(/\bby\b/)
  })

  it('marks your own versions, and never matches an author without an id', () => {
    signIn()
    const versions = [
      version({ id: 'a', version: '1.2.0', createdBy: { id: 'user-1', name: 'Ana Silva' } }),
      version({ id: 'b', version: '1.1.0', createdBy: { id: null, name: 'Ana Silva' } }),
    ]
    render(VersionList, { versions, selectedId: null, onselect: () => {} })
    const lines = screen.getAllByTestId('version-byline').map((e) => e.textContent)
    expect(lines[0]).toMatch(/^Ana Silva \(you\) · /)
    expect(lines[1]).toMatch(/^Ana Silva · /)
  })

  it('the tooltip carries the full date and time', () => {
    const v = version({ createdBy: { id: 'user-2', name: 'Bruno Costa' }, createdAt: 1_700_000_000 })
    render(VersionList, { versions: [v], selectedId: null, onselect: () => {} })
    expect(screen.getByTestId('version-byline')).toHaveAttribute('title', `Created by Bruno Costa · ${new Date(1_700_000_000 * 1000).toLocaleString()}`)
  })
})

describe('VersionDetail', () => {
  const props = { detail: null, loading: false, error: null, onretry: () => {}, onrestore: () => {}, ondelete: () => {} }
  it('says who created the version and when, with (you) for the signed-in user', () => {
    signIn()
    const mine = version({ createdBy: { id: 'user-1', name: 'Ana Silva' }, createdAt: 1_700_000_000 })
    render(VersionDetail, { ...props, summary: mine, versions: [mine] })
    expect(screen.getByTestId('version-created')).toHaveTextContent(`Created by Ana Silva (you) · ${new Date(1_700_000_000 * 1000).toLocaleString()}`)
  })
  it("another person's version has no (you); an unknown author has no 'by'", () => {
    signIn()
    const theirs = version({ createdBy: { id: 'user-2', name: 'Bruno Costa' }, createdAt: 1_700_000_000 })
    const { unmount } = render(VersionDetail, { ...props, summary: theirs, versions: [theirs] })
    expect(screen.getByTestId('version-created').textContent).toBe(`Created by Bruno Costa · ${new Date(1_700_000_000 * 1000).toLocaleString()}`)
    unmount()
    const unknown = version({ createdBy: null, createdAt: 1_700_000_000 })
    render(VersionDetail, { ...props, summary: unknown, versions: [unknown] })
    expect(screen.getByTestId('version-created').textContent).toBe(`Created · ${new Date(1_700_000_000 * 1000).toLocaleString()}`)
  })
})

describe('VersionCompare headings', () => {
  beforeEach(async () => {
    window.slinger = createMockBackend({ latencyMs: 0 })
    await app.init()
  })

  it('names the author and date of both sides', async () => {
    signIn()
    const col = app.collections.find((c) => c.name === 'Demo API')!
    const first = (await window.slinger.listCollectionVersions(col.id))[0]!
    const second = await window.slinger.createCollectionVersion({ collectionId: col.id, version: '1.1.0', notes: null })
    const list = await window.slinger.listCollectionVersions(col.id)
    const detail: CollectionVersionDetail = await window.slinger.getCollectionVersion(first.id)
    expect(first.createdBy).toEqual({ id: 'user-1', name: 'Ana Silva' }) // the seeded mock version
    render(VersionCompare, { detail, versions: list })
    const headings = await screen.findByTestId('compare-headings')
    expect(within(headings).getByText(/v1\.0\.0 · Ana Silva \(you\), /)).toBeInTheDocument()
    expect(within(headings).getByText('Current collection')).toBeInTheDocument()

    const select = screen.getByLabelText(/Compare v1\.0\.0 against/) as HTMLSelectElement
    select.value = second.id
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await waitFor(() => expect(within(screen.getByTestId('compare-headings')).getByText(/v1\.1\.0 · /)).toBeInTheDocument())
  })
})
