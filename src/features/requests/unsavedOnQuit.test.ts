import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../app/state.svelte'
import { settings } from '../../app/settings.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import { MAX_DRAFT_BYTES, flushSave, scheduleSave, serializeTabs } from './tabsPersistence'
import { tabsStore } from './tabs.svelte'
import { reportUnsaved, unsavedAtRisk } from './unsavedOnQuit.svelte'

let backend: ReturnType<typeof createMockBackend>

beforeEach(async () => {
  localStorage.clear()
  backend = createMockBackend({ latencyMs: 0 })
  window.slinger = backend
  window.__slingerMock = backend
  tabsStore.tabs = []
  tabsStore.activeId = null
  await app.init()
})
afterEach(() => settings.setRestoreTabsOnStartup(true))

const find = (name: string) => app.requests.find((r) => r.name === name)!

describe('unsaved edits that quitting would lose', () => {
  it('with tab restore on: only drafts the autosave could not keep', () => {
    const ws = app.workspaceId!
    const small = tabsStore.openRequest(find('Get user'))
    small.draft.url = 'https://x.test/small'
    const huge = tabsStore.openRequest(find('Create user'))
    huge.draft.url = 'https://x.test/' + 'y'.repeat(MAX_DRAFT_BYTES)
    scheduleSave(ws, () => serializeTabs(tabsStore.tabs, tabsStore.activeId))
    flushSave(ws)
    expect(unsavedAtRisk(ws)).toEqual(['Create user'])
  })

  it('with tab restore off: every unsaved edit, also in other open workspaces', async () => {
    settings.setRestoreTabsOnStartup(false)
    const firstWs = app.workspaceId!
    tabsStore.openRequest(find('Get user')).draft.url = 'https://x.test/a'
    tabsStore.openRequest(find('Create user')) // clean
    const other = await backend.createWorkspace('Other')
    await app.selectWorkspace(other.id)
    tabsStore.newTab().draft.url = 'https://scratch.test'
    expect(unsavedAtRisk(app.workspaceId).sort()).toEqual(['Get user', 'New Request'])
    expect(firstWs).not.toBe(other.id)
  })

  it('reports the list to main only when it changed', () => {
    const send = vi.spyOn(backend, 'setUnsavedChanges')
    reportUnsaved(['A'])
    reportUnsaved(['A'])
    reportUnsaved([])
    expect(send.mock.calls).toEqual([[['A']], [[]]])
  })
})
