import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../app/state.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import { newDraft } from '../../lib/request'
import RequestTabs from './RequestTabs.svelte'
import { tabsStore } from './tabs.svelte'

beforeEach(async () => {
  localStorage.clear()
  const backend = createMockBackend({ latencyMs: 0, seed: false })
  window.slinger = backend
  window.__slingerMock = backend
  tabsStore.tabs = []
  tabsStore.activeId = null
  await app.init()
})

const labels = (menu: HTMLElement) => within(menu).getAllByRole('menuitem').map((i) => i.textContent?.replace(/Ctrl\+W$/, '').trim())

describe('RequestTabs right-click menu', () => {
  it('closes the tabs to the right (asking first for unsaved ones)', async () => {
    for (const n of ['A', 'B', 'C']) tabsStore.newTab({ draft: newDraft({ name: n, url: `https://x.test/${n}` }) })
    render(RequestTabs)
    await fireEvent.contextMenu(screen.getByRole('tab', { name: /A/ }))
    const menu = await screen.findByRole('menu')
    expect(labels(menu)).toEqual(['Close', 'Close others', 'Close to the right', 'Close all', 'Save', 'Copy URL', 'Copy as cURL'])
    await fireEvent.click(within(menu).getByRole('menuitem', { name: 'Close to the right' }))
    // Unsaved new tabs: the usual "discard changes?" question, for B and C only.
    const names = tabsStore.pendingClose?.ids.map((id) => tabsStore.find(id)?.draft.name)
    expect(names).toEqual(['B', 'C'])
  })

  it('opens from the keyboard and copies what the tab shows, unsaved edits included', async () => {
    const user = userEvent.setup()
    const t = tabsStore.newTab({ draft: newDraft({ name: 'A', url: 'https://x.test/edited' }) })
    render(RequestTabs)
    const tab = screen.getByRole('tab', { name: /A/ })
    tab.focus()
    await user.keyboard('{Shift>}{F10}{/Shift}')
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: 'Close to the right' })).toBeDisabled()
    await user.click(within(menu).getByRole('menuitem', { name: 'Copy URL' }))
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(t.draft.url))
  })

  it('has no copy entries on a workflow tab', async () => {
    tabsStore.openWorkflow('w1')
    render(RequestTabs)
    await fireEvent.contextMenu(screen.getByRole('tab'))
    expect(labels(await screen.findByRole('menu'))).toEqual(['Close', 'Close others', 'Close to the right', 'Close all', 'Save'])
  })
})
