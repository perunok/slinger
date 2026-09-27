/** Right side panel: toggling (button, shortcut, menu, palette), persistence, fitting, resizing and each view. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import App from '../../app/App.svelte'
import { runMenuCommand } from '../../app/menuCommands'
import { handleShortcut } from '../../app/shortcuts'
import { app } from '../../app/state.svelte'
import { toast } from '../../app/toast.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import { SECRET_MASK } from '../../lib/template'
import { tabsStore } from '../requests/tabs.svelte'
import { toggleRightPanel } from './layoutActions'
import { SIDE_PANELS } from './panels'
import RightPanel from './RightPanel.svelte'
import { clampPanelWidth, fitPanelWidth, minMainWidth, PANEL_DEFAULT_WIDTH, PANEL_MAX_WIDTH, PANEL_MIN_WIDTH, RIGHT_PANEL_KEY, rightPanel } from './rightPanelStore.svelte'

const stored = () => JSON.parse(localStorage.getItem(RIGHT_PANEL_KEY) ?? 'null')

beforeEach(async () => {
  localStorage.clear()
  rightPanel.reload()
  rightPanel.room = true
  const backend = createMockBackend({ latencyMs: 0 })
  window.slinger = backend
  window.__slingerMock = backend
  tabsStore.tabs = []
  tabsStore.activeId = null
  toast.clear()
  await app.init()
})
afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  localStorage.clear()
  rightPanel.reload()
})

const find = (name: string) => app.requests.find((r) => r.name === name)!
const ctrlAltB = () => new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', ctrlKey: true, altKey: true, cancelable: true })

describe('fitting and persistence', () => {
  it('fits the panel next to a main area that keeps its minimum width, or hides it', () => {
    expect(fitPanelWidth(0, 300, 500)).toBe(300) // not measured yet
    expect(fitPanelWidth(1200, 300, 500)).toBe(300)
    expect(fitPanelWidth(760, 300, 500)).toBe(260) // shrinks to the room left
    expect(fitPanelWidth(700, 300, 500)).toBeNull() // less than the minimum width left
    expect(minMainWidth('beside')).toBeGreaterThan(minMainWidth('below'))
    expect(clampPanelWidth(10)).toBe(PANEL_MIN_WIDTH)
    expect(clampPanelWidth(5000)).toBe(PANEL_MAX_WIDTH)
    expect(clampPanelWidth(Number.NaN)).toBe(PANEL_DEFAULT_WIDTH)
  })

  it('is closed by default and restores open state, view and width; junk falls back to defaults', () => {
    expect(rightPanel.open).toBe(false)
    localStorage.setItem(RIGHT_PANEL_KEY, JSON.stringify({ open: true, panel: 'code', width: 410 }))
    rightPanel.reload()
    expect([rightPanel.open, rightPanel.panel, rightPanel.width]).toEqual([true, 'code', 410])
    localStorage.setItem(RIGHT_PANEL_KEY, '{nope')
    rightPanel.reload()
    expect([rightPanel.open, rightPanel.panel, rightPanel.width]).toEqual([false, 'variables', PANEL_DEFAULT_WIDTH])
  })

  it('explains why nothing appears when opened without room', () => {
    rightPanel.room = false
    toggleRightPanel()
    expect(rightPanel.open).toBe(true)
    expect(toast.items.map((t) => t.title)).toEqual(['Not enough room for the right panel'])
    toggleRightPanel()
    expect(rightPanel.open).toBe(false)
    expect(toast.items).toHaveLength(1)
  })
})

describe('toggling in the app', () => {
  it('opens and closes from the status bar, the top bar, Ctrl+Alt+B and View > Toggle Right Panel; persisted', async () => {
    render(App)
    const barToggle = await screen.findByTestId('right-panel-toggle')
    expect(screen.queryByTestId('right-panel')).toBeNull()
    expect(barToggle).toHaveAttribute('aria-pressed', 'false')

    await fireEvent.click(barToggle)
    expect(await screen.findByRole('complementary', { name: 'Right panel' })).toBeInTheDocument()
    expect(barToggle).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('right-panel-toggle-top')).toHaveAttribute('aria-pressed', 'true')
    expect(stored()).toMatchObject({ open: true, panel: 'variables' })

    expect(runMenuCommand('toggleRightPanel')).toBe(true)
    await waitFor(() => expect(screen.queryByTestId('right-panel')).toBeNull())
    expect(stored()).toMatchObject({ open: false })

    expect(handleShortcut(ctrlAltB())).toBe(true)
    await screen.findByTestId('right-panel')
    // The macOS menu key equivalent of that same press is dropped.
    expect(runMenuCommand('toggleRightPanel')).toBe(false)
    await fireEvent.click(screen.getByTestId('right-panel-toggle-top'))
    await waitFor(() => expect(screen.queryByTestId('right-panel')).toBeNull())
  })

  it('does nothing behind a modal dialog', () => {
    document.body.innerHTML = '<div role="dialog" aria-modal="true"></div>'
    expect(handleShortcut(ctrlAltB())).toBe(false)
    expect(runMenuCommand('toggleRightPanel')).toBe(false)
    expect(rightPanel.open).toBe(false)
  })
})

describe('the panel', () => {
  function open(panel = 'variables') {
    rightPanel.show(panel)
    return render(RightPanel, { width: 320 })
  }

  it('lists the registered views as tabs (arrow keys switch) and remembers the chosen one', async () => {
    open()
    const list = screen.getByRole('tablist', { name: 'Right panel views' })
    expect(within(list).getAllByRole('tab').map((t) => t.textContent?.trim())).toEqual(SIDE_PANELS.map((p) => p.label))
    expect(within(list).getByRole('tab', { name: 'Variables' })).toHaveAttribute('aria-selected', 'true')
    await fireEvent.keyDown(list, { key: 'ArrowRight' })
    expect(within(list).getByRole('tab', { name: 'Docs' })).toHaveAttribute('aria-selected', 'true')
    expect(stored()).toMatchObject({ panel: 'docs' })
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'rp-docs')
    await fireEvent.click(screen.getByRole('button', { name: /Close right panel/ }))
    expect(rightPanel.open).toBe(false)
  })

  it('resizes with the keyboard (Left widens) and remembers the width', async () => {
    open()
    const handle = screen.getByRole('separator', { name: 'Resize right panel' })
    await fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(rightPanel.width).toBe(336)
    await fireEvent.keyDown(handle, { key: 'ArrowRight' })
    await fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(stored()).toMatchObject({ width: 304 })
  })

  it('shows empty states when no request tab is active (or an overview is)', () => {
    for (const p of SIDE_PANELS) {
      open(p.id)
      expect(screen.getByTestId('panel-empty')).toHaveTextContent(/Open a request/)
      cleanup()
    }
    tabsStore.openOverview({ kind: 'collection', id: app.collections[0]!.id })
    open('info')
    expect(screen.getByTestId('panel-empty')).toBeInTheDocument()
  })

  it('Variables: resolved values with their scope, masked secrets, undefined ones flagged, the whole scope', async () => {
    const tab = tabsStore.openRequest(find('API key in query'))
    tab.draft.url = '{{baseUrl}}/echo?key={{apiToken}}&x={{nope}}'
    open('variables')
    const used = screen.getAllByTestId('used-var')
    expect(used.map((li) => li.dataset.status)).toEqual(['resolved', 'secret', 'unresolved'])
    expect(used[0]).toHaveTextContent('baseUrl')
    expect(used[0]).toHaveTextContent('Environment: Local')
    expect(used[0]).toHaveTextContent('https://mock.slinger.local')
    expect(used[1]).toHaveTextContent(SECRET_MASK)
    expect(used[2]).toHaveTextContent('Not defined')
    expect(within(used[2]!).queryByRole('button', { name: 'Create' })).toBeNull() // no shell registered in this test
    expect(screen.getByText('(1 undefined)')).toBeInTheDocument()
    const all = screen.getByRole('table', { name: 'All variables in scope' })
    expect(within(all).getByText('apiToken').closest('tr')).toHaveTextContent(SECRET_MASK)
    expect(all.textContent).not.toContain('null')
  })

  it('Docs: renders the draft’s documentation; empty state leads to the Docs section', async () => {
    const tab = tabsStore.openRequest(find('API key in query'))
    open('docs')
    expect(screen.getByText('This request has no documentation yet.')).toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'Write documentation' }))
    expect(tab.section).toBe('docs')
    tab.section = 'params'
    tab.draft.description = '# Paying\n\nUse **cents**.'
    await screen.findByRole('heading', { name: /Paying/ })
    expect(screen.getByText('cents').tagName).toBe('STRONG')
    await fireEvent.click(screen.getByRole('button', { name: 'Edit in Docs' }))
    expect(tab.section).toBe('docs')
  })

  it('Code: a snippet for the active request with a language picker and Copy', async () => {
    tabsStore.openRequest(find('API key in query'))
    open('code')
    const view = screen.getByTestId('panel-code')
    const picker = within(view).getByRole('combobox', { name: 'Language' })
    expect(picker).toHaveValue('curl')
    expect(view.querySelector('.cm-content')?.textContent).toContain('curl')
    expect(view.querySelector('.cm-content')?.textContent).toContain('https://mock.slinger.local/echo')
    expect(within(view).getByRole('button', { name: 'Copy' })).toBeEnabled()
    await fireEvent.change(picker, { target: { value: 'python' } })
    await waitFor(() => expect(view.querySelector('.cm-content')?.textContent).toContain('requests'))
  })

  it('Info: id, location, method, state, version and sync', async () => {
    const r = find('Get user')
    const tab = tabsStore.openRequest(r)
    open('info')
    const info = screen.getByTestId('panel-info')
    expect(screen.getByTestId('info-id')).toHaveTextContent(r.id)
    expect(info).toHaveTextContent('Demo API / Users')
    expect(info).toHaveTextContent(r.method)
    expect(info).toHaveTextContent('Saved')
    expect(info).toHaveTextContent(new RegExp(`Version\\s*${r.version}`))
    expect(info).toHaveTextContent('Local only')
    tab.draft.url += '?changed=1'
    await waitFor(() => expect(info).toHaveTextContent('Unsaved changes'))
  })
})
