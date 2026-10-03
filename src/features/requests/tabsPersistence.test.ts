import { beforeEach, describe, expect, it } from 'vitest'
import { newDraft } from '../../lib/request'
import {
  MAX_DRAFT_BYTES,
  MAX_PERSISTED_TABS,
  TABS_STORAGE_VERSION,
  clearAllPersisted,
  clearPersisted,
  flushSave,
  readPersisted,
  restoreTabs,
  scheduleSave,
  serializeTabs,
  storageKey,
  type PersistedTabsState,
  type TabLike,
} from './tabsPersistence'

function tab(partial: Partial<TabLike> = {}): TabLike {
  return {
    id: partial.id ?? 't1',
    requestId: null,
    collectionId: null,
    folderId: null,
    baseVersion: 0,
    serverKey: '',
    section: 'params',
    draft: newDraft(),
    savedFingerprint: '',
    example: null,
    exampleDraft: null,
    exampleSavedFingerprint: '',
    exampleSection: 'response',
    overview: null,
    overviewDraft: null,
    dirty: false,
    title: 'Untitled Request',
    ...partial,
  }
}

beforeEach(() => {
  localStorage.clear()
})

describe('serializeTabs', () => {
  it('keeps a clean saved-request tab as identity only (no draft)', () => {
    const t = tab({ requestId: 'r1', dirty: false })
    const state = serializeTabs([t], t.id)
    expect(state.tabs[0]).toEqual({ kind: 'request', requestId: 'r1', section: 'params' })
  })

  it('persists a dirty request draft', () => {
    const draft = { ...newDraft(), name: 'Edited' }
    const t = tab({ requestId: 'r1', dirty: true, draft, savedFingerprint: 'sf', baseVersion: 3, serverKey: 'sk' })
    const state = serializeTabs([t], null)
    expect(state.tabs[0]).toMatchObject({ kind: 'request', requestId: 'r1', dirty: { draft, savedFingerprint: 'sf', baseVersion: 3, serverKey: 'sk' } })
  })

  it('always keeps a scratch (unsaved, no requestId) tab, dirty or not', () => {
    const draft = { ...newDraft(), url: 'https://example.com' }
    const t = tab({ requestId: null, dirty: false, draft, collectionId: 'c1', folderId: null })
    const state = serializeTabs([t], null)
    expect(state.tabs[0]).toMatchObject({ kind: 'scratch', draft, collectionId: 'c1' })
  })

  it('drops an oversized dirty draft but keeps the tab, flagged with its title', () => {
    const big = { ...newDraft(), name: 'Big One', description: 'x'.repeat(MAX_DRAFT_BYTES + 10) }
    const t = tab({ requestId: 'r1', dirty: true, draft: big, title: 'Big One' })
    const state = serializeTabs([t], null)
    expect(state.tabs[0]).toEqual({ kind: 'request', requestId: 'r1', section: 'params', draftTooLarge: true, title: 'Big One' })
  })

  it('drops an oversized scratch draft down to a blank one, flagged', () => {
    const big = { ...newDraft(), description: 'y'.repeat(MAX_DRAFT_BYTES + 10) }
    const t = tab({ requestId: null, draft: big, title: 'Huge scratch' })
    const state = serializeTabs([t], null)
    expect(state.tabs[0]).toMatchObject({ kind: 'scratch', draftTooLarge: true, title: 'Huge scratch' })
    expect((state.tabs[0] as { draft: { description: string } }).draft.description).toBe('')
  })

  it('caps the number of persisted tabs, keeping the active one even beyond the cap', () => {
    const tabs = Array.from({ length: MAX_PERSISTED_TABS + 10 }, (_, i) => tab({ id: `t${i}`, requestId: `r${i}` }))
    const active = tabs[MAX_PERSISTED_TABS + 5]!
    const state = serializeTabs(tabs, active.id)
    expect(state.tabs).toHaveLength(MAX_PERSISTED_TABS)
    expect(state.activeIndex).toBe(MAX_PERSISTED_TABS - 1)
    expect((state.tabs[MAX_PERSISTED_TABS - 1] as { requestId: string }).requestId).toBe(active.requestId)
  })

  it('persists an overview tab only with its draft description', () => {
    const t = tab({ overview: { kind: 'collection', id: 'c1' }, overviewDraft: 'Some docs' })
    const state = serializeTabs([t], null)
    expect(state.tabs[0]).toEqual({ kind: 'overview', target: { kind: 'collection', id: 'c1' }, overviewDraft: 'Some docs' })
  })
})

describe('readPersisted / writePersisted / clear', () => {
  it('round-trips through localStorage', () => {
    const state: PersistedTabsState = { v: TABS_STORAGE_VERSION, activeIndex: 0, tabs: [{ kind: 'request', requestId: 'r1', section: 'params' }] }
    localStorage.setItem(storageKey('w1'), JSON.stringify(state))
    expect(readPersisted('w1')).toEqual(state)
  })

  it('ignores corrupted JSON', () => {
    localStorage.setItem(storageKey('w1'), '{not json')
    expect(readPersisted('w1')).toBeNull()
  })

  it('ignores an old/unknown version', () => {
    localStorage.setItem(storageKey('w1'), JSON.stringify({ v: 999, activeIndex: null, tabs: [] }))
    expect(readPersisted('w1')).toBeNull()
  })

  it('ignores a missing tabs array', () => {
    localStorage.setItem(storageKey('w1'), JSON.stringify({ v: TABS_STORAGE_VERSION }))
    expect(readPersisted('w1')).toBeNull()
  })

  it('clearPersisted removes just that workspace, clearAllPersisted removes every workspace', () => {
    localStorage.setItem(storageKey('w1'), 'x')
    localStorage.setItem(storageKey('w2'), 'y')
    localStorage.setItem('slinger.other', 'z')
    clearPersisted('w1')
    expect(localStorage.getItem(storageKey('w1'))).toBeNull()
    expect(localStorage.getItem(storageKey('w2'))).toBe('y')
    clearAllPersisted()
    expect(localStorage.getItem(storageKey('w2'))).toBeNull()
    expect(localStorage.getItem('slinger.other')).toBe('z')
  })
})

describe('scheduleSave / flushSave', () => {
  it('debounces: only the last scheduled state within the delay is written on flush', () => {
    scheduleSave('w1', { v: TABS_STORAGE_VERSION, activeIndex: null, tabs: [] }, 500)
    scheduleSave('w1', { v: TABS_STORAGE_VERSION, activeIndex: 0, tabs: [{ kind: 'scratch', draft: newDraft(), collectionId: null, folderId: null, section: 'params' }] }, 500)
    flushSave('w1')
    const saved = readPersisted('w1')
    expect(saved?.activeIndex).toBe(0)
    expect(saved?.tabs).toHaveLength(1)
  })

  it('flushSave() with no id flushes every pending workspace', () => {
    scheduleSave('a', { v: TABS_STORAGE_VERSION, activeIndex: null, tabs: [] })
    scheduleSave('b', { v: TABS_STORAGE_VERSION, activeIndex: null, tabs: [] })
    flushSave()
    expect(readPersisted('a')).not.toBeNull()
    expect(readPersisted('b')).not.toBeNull()
  })
})

describe('restoreTabs', () => {
  const req = (over: Partial<{ id: string; collectionId: string; folderId: string | null; version: number; documentJson: string }> = {}) => ({
    id: 'r1',
    collectionId: 'c1',
    folderId: null,
    method: 'GET',
    url: '',
    version: 1,
    documentJson: '{}',
    ...over,
  })

  it('drops a request tab whose request no longer exists, silently', () => {
    const state: PersistedTabsState = { v: TABS_STORAGE_VERSION, activeIndex: 0, tabs: [{ kind: 'request', requestId: 'gone', section: 'params' }] }
    const result = restoreTabs(state, { requests: [], collections: [], folders: [] })
    expect(result.inits).toHaveLength(0)
    expect(result.activeIndex).toBeNull()
    expect(result.lostDraftTitles).toHaveLength(0)
  })

  it('drops an overview tab whose collection/folder no longer exists', () => {
    const state: PersistedTabsState = { v: TABS_STORAGE_VERSION, activeIndex: null, tabs: [{ kind: 'overview', target: { kind: 'folder', id: 'f1' }, overviewDraft: null }] }
    const result = restoreTabs(state, { requests: [], collections: [], folders: [] })
    expect(result.inits).toHaveLength(0)
  })

  it('keeps a clean request tab that still exists and remaps the active index past drops', () => {
    const state: PersistedTabsState = {
      v: TABS_STORAGE_VERSION,
      activeIndex: 1,
      tabs: [
        { kind: 'request', requestId: 'gone', section: 'params' },
        { kind: 'request', requestId: 'r1', section: 'headers' },
      ],
    }
    const result = restoreTabs(state, { requests: [req()], collections: [], folders: [] })
    expect(result.inits).toEqual([{ kind: 'request', requestId: 'r1', section: 'headers', dirty: null }])
    expect(result.activeIndex).toBe(0) // the surviving tab is now first
  })

  it('a stale baseVersion on a dirty draft is kept as-is (not silently reconciled with the current version), so Save conflicts', () => {
    const state: PersistedTabsState = {
      v: TABS_STORAGE_VERSION,
      activeIndex: null,
      tabs: [{ kind: 'request', requestId: 'r1', section: 'params', dirty: { draft: newDraft(), savedFingerprint: 'sf', baseVersion: 1, serverKey: 'old-key' } }],
    }
    // The server has since moved to version 5 with different content.
    const result = restoreTabs(state, { requests: [req({ version: 5 })], collections: [], folders: [] })
    expect(result.inits).toHaveLength(1)
    const init = result.inits[0]!
    expect(init.kind).toBe('request')
    if (init.kind === 'request') {
      expect(init.dirty?.baseVersion).toBe(1) // untouched: the eventual Save uses this stale version and conflicts
      expect(init.dirty?.serverKey).toBe('old-key')
    }
  })

  it('surfaces titles of tabs whose unsaved changes were too large to keep', () => {
    const state: PersistedTabsState = {
      v: TABS_STORAGE_VERSION,
      activeIndex: null,
      tabs: [{ kind: 'request', requestId: 'r1', section: 'params', draftTooLarge: true, title: 'Huge one' }],
    }
    const result = restoreTabs(state, { requests: [req()], collections: [], folders: [] })
    expect(result.lostDraftTitles).toEqual(['Huge one'])
    expect(result.inits).toEqual([{ kind: 'request', requestId: 'r1', section: 'params', dirty: null }])
  })

  it('a null state (nothing persisted) restores nothing', () => {
    expect(restoreTabs(null, { requests: [], collections: [], folders: [] })).toEqual({ inits: [], activeIndex: null, lostDraftTitles: [] })
  })

  it('locates a clean example tab that moved position, and drops one whose example vanished', () => {
    const withExamples = req({ documentJson: JSON.stringify({ responses: [{ name: 'Ex A' }, { name: 'Ex B' }] }) })
    const state: PersistedTabsState = {
      v: TABS_STORAGE_VERSION,
      activeIndex: null,
      tabs: [
        { kind: 'example', requestId: 'r1', section: 'params', exampleSection: 'response', locator: { index: 0, id: null, snapshot: JSON.stringify({ name: 'Ex B' }), name: 'Ex B', count: 2 } },
      ],
    }
    const result = restoreTabs(state, { requests: [withExamples], collections: [], folders: [] })
    expect(result.inits).toEqual([{ kind: 'example', requestId: 'r1', section: 'params', exampleSection: 'response', exampleIndex: 1, dirty: null }])
  })

  it('a dirty example tab whose example was deleted keeps the tab, flagged gone (not dropped)', () => {
    const noExamples = req({ documentJson: JSON.stringify({ responses: [] }) })
    const state: PersistedTabsState = {
      v: TABS_STORAGE_VERSION,
      activeIndex: null,
      tabs: [
        {
          kind: 'example',
          requestId: 'r1',
          section: 'params',
          exampleSection: 'response',
          locator: { index: 0, id: null, snapshot: JSON.stringify({ name: 'Ex A' }), name: 'Ex A', count: 1 },
          dirty: {
            example: { index: 0, id: null, snapshot: JSON.stringify({ name: 'Ex A' }), name: 'Ex A', count: 1, original: { name: 'Ex A' }, baseline: {} as never, requestFromParent: true, responseTime: null, remote: 'same' },
            draft: newDraft(),
            exampleDraft: { name: 'Ex A (edited)', code: null, status: '', headers: [], body: '', language: '', bodyEncoding: null },
            savedFingerprint: 'sf',
            exampleSavedFingerprint: 'ef',
          },
        },
      ],
    }
    const result = restoreTabs(state, { requests: [noExamples], collections: [], folders: [] })
    expect(result.inits).toHaveLength(1)
    const init = result.inits[0]!
    expect(init.kind).toBe('example')
    if (init.kind === 'example') {
      expect(init.dirty?.example.remote).toBe('gone')
      expect(init.dirty?.exampleDraft.name).toBe('Ex A (edited)')
    }
  })
})

describe('workflow tabs', () => {
  it('are kept by workflow id and restored while the workflow exists (or the list is not known yet)', () => {
    const state = serializeTabs([tab({ id: 'a', workflowId: 'wf-1', title: 'Flow' }), tab({ id: 'b', workflowId: 'wf-gone' })], 'a')
    expect(state.tabs).toEqual([{ kind: 'workflow', workflowId: 'wf-1' }, { kind: 'workflow', workflowId: 'wf-gone' }])
    const known = restoreTabs(state, { requests: [], collections: [], folders: [], workflows: [{ id: 'wf-1' }] })
    expect(known).toEqual({ inits: [{ kind: 'workflow', workflowId: 'wf-1' }], activeIndex: 0, lostDraftTitles: [] })
    const unknown = restoreTabs(state, { requests: [], collections: [], folders: [], workflows: null })
    expect(unknown.inits).toHaveLength(2)
  })
})

