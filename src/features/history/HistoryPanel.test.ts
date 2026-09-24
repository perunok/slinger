import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistoryEntry } from '../../../shared/types'
import { app } from '../../app/state.svelte'
import { toast } from '../../app/toast.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import { tabsStore } from '../requests/tabs.svelte'
import HistoryPanel from './HistoryPanel.svelte'
import { dayKey, dayLabel, groupByDay } from './group'

const sec = (d: Date) => Math.floor(d.getTime() / 1000)
const at = (daysAgo: number, hour = 12) => {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  d.setHours(hour, 0, 0, 0)
  return sec(d)
}
const entry = (id: string, over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id, workspaceId: 'x', requestId: null, requestName: null, method: 'GET', url: `https://api.test/${id}`, statusCode: 200, ok: true, errorMessage: null, durationMs: 42, createdAt: at(0, 9), ...over,
})

let rows: HistoryEntry[]
let backend: ReturnType<typeof createMockBackend>

async function setup(initial: HistoryEntry[]) {
  rows = initial
  backend = createMockBackend({ latencyMs: 0, seed: false })
  window.slinger = Object.assign(backend, {
    listHistory: async () => rows.map((r) => ({ ...r })),
    deleteHistoryEntry: vi.fn(async (id: string) => {
      rows = rows.filter((r) => r.id !== id)
    }),
    clearHistory: vi.fn(async () => {
      rows = []
    }),
  })
  await app.init()
  tabsStore.tabs = []
  tabsStore.activeId = null
  toast.clear()
  return render(HistoryPanel)
}

beforeEach(() => vi.restoreAllMocks())

describe('groupByDay', () => {
  it('groups by local day and labels Today/Yesterday', () => {
    const now = new Date()
    const g = groupByDay([entry('a'), entry('b'), entry('c', { createdAt: at(1) }), entry('d', { createdAt: at(5) })], now)
    expect(g.map((x) => x.entries.length)).toEqual([2, 1, 1])
    expect(dayLabel(g[0].key, now)).toBe('Today')
    expect(dayLabel(g[1].key, now)).toBe('Yesterday')
    expect(dayLabel(g[2].key, now)).not.toMatch(/Today|Yesterday/)
    expect(g[0].key).toBe(dayKey(now))
  })
})

describe('HistoryPanel', () => {
  it('shows entries grouped by day with status, error and duration', async () => {
    await setup([
      entry('a', { method: 'POST', statusCode: 201 }),
      entry('b', { statusCode: null, ok: false, errorMessage: 'ECONNREFUSED' }),
      entry('c', { createdAt: at(1), statusCode: 500 }),
    ])
    expect(await screen.findByRole('group', { name: 'Today' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Yesterday' })).toBeInTheDocument()
    expect(screen.getByText('201')).toBeInTheDocument()
    expect(screen.getByText('500')).toBeInTheDocument()
    expect(screen.getByText('ECONNREFUSED')).toBeInTheDocument()
    expect(screen.getAllByText('42 ms')).toHaveLength(3)
  })

  it('shows the empty state', async () => {
    await setup([])
    expect(await screen.findByText(/No history yet/)).toBeInTheDocument()
  })

  it('shows an error with retry', async () => {
    rows = []
    const spy = vi.fn().mockRejectedValueOnce(new Error('db locked')).mockResolvedValue([entry('a')])
    backend = createMockBackend({ latencyMs: 0, seed: false })
    window.slinger = Object.assign(backend, { listHistory: spy })
    await app.init()
    render(HistoryPanel)
    expect(await screen.findByRole('alert')).toHaveTextContent('db locked')
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('https://api.test/a')).toBeInTheDocument()
  })

  it('filters entries', async () => {
    await setup([entry('alpha'), entry('beta')])
    await screen.findByText('https://api.test/alpha')
    await fireEvent.input(screen.getByLabelText('Filter history'), { target: { value: 'beta' } })
    expect(screen.queryByText('https://api.test/alpha')).toBeNull()
    expect(screen.getByText('https://api.test/beta')).toBeInTheDocument()
    await fireEvent.input(screen.getByLabelText('Filter history'), { target: { value: 'zzz' } })
    expect(screen.getByText(/No history matches/)).toBeInTheDocument()
  })

  it('reopens a saved request in a tab, or a fresh draft otherwise', async () => {
    await setup([])
    const ws = app.workspaceId!
    const col = await backend.createCollection(ws, 'C')
    const saved = await backend.createRequest({ workspaceId: ws, collectionId: col.id, name: 'Saved', method: 'GET', url: 'https://api.test/saved', documentJson: '{}' })
    await app.reloadCollections()
    rows = [entry('h1', { requestId: saved.id, url: saved.url }), entry('h2', { requestId: 'gone', method: 'PUT', url: 'https://api.test/adhoc', requestName: null })]
    app.historyTick++
    const first = await screen.findByText('https://api.test/saved')
    await fireEvent.click(first)
    expect(tabsStore.active?.requestId).toBe(saved.id)
    await fireEvent.click(screen.getByText('https://api.test/adhoc'))
    expect(tabsStore.tabs).toHaveLength(2)
    expect(tabsStore.active?.requestId).toBeNull()
    expect(tabsStore.active?.draft.method).toBe('PUT')
    expect(tabsStore.active?.draft.url).toBe('https://api.test/adhoc')
  })

  it('keyboard: arrows move focus, Enter opens, Delete removes', async () => {
    await setup([entry('a'), entry('b')])
    const a = (await screen.findByText('https://api.test/a')).closest('[data-entry-id]') as HTMLElement
    a.focus()
    await fireEvent.keyDown(a, { key: 'ArrowDown' })
    const b = screen.getByText('https://api.test/b').closest('[data-entry-id]') as HTMLElement
    expect(document.activeElement).toBe(b)
    await fireEvent.keyDown(b, { key: 'Enter' })
    expect(tabsStore.tabs).toHaveLength(1)
    await fireEvent.keyDown(b, { key: 'Delete' })
    await waitFor(() => expect(screen.queryByText('https://api.test/b')).toBeNull())
    expect(window.slinger.deleteHistoryEntry).toHaveBeenCalledWith('b')
  })

  it('deletes an entry optimistically and rolls back on failure', async () => {
    await setup([entry('a'), entry('b')])
    await screen.findByText('https://api.test/a')
    const del = vi.mocked(window.slinger.deleteHistoryEntry)
    del.mockRejectedValueOnce(new Error('disk full'))
    const li = screen.getByText('https://api.test/a').closest('li')!
    await fireEvent.click(within(li).getByRole('button', { name: 'Delete history entry' }))
    expect(await screen.findByText('https://api.test/a')).toBeInTheDocument()
    expect(toast.items.some((t) => t.kind === 'error' && t.detail?.includes('disk full'))).toBe(true)
    await fireEvent.click(within(screen.getByText('https://api.test/a').closest('li')!).getByRole('button', { name: 'Delete history entry' }))
    await waitFor(() => expect(screen.queryByText('https://api.test/a')).toBeNull())
  })

  it('clears history after confirmation and reports failures inline', async () => {
    await setup([entry('a')])
    await screen.findByText('https://api.test/a')
    const clear = vi.mocked(window.slinger.clearHistory)
    clear.mockRejectedValueOnce(new Error('locked'))
    await fireEvent.click(screen.getByRole('button', { name: 'Clear history' }))
    await fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Clear history' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('locked')
    expect(screen.getByText('https://api.test/a')).toBeInTheDocument()
    await fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Clear history' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(await screen.findByText(/No history yet/)).toBeInTheDocument()
  })

  it('reloads when historyTick changes', async () => {
    await setup([entry('a')])
    await screen.findByText('https://api.test/a')
    rows = [entry('n'), ...rows]
    app.historyTick++
    expect(await screen.findByText('https://api.test/n')).toBeInTheDocument()
  })
})
