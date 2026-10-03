import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settings } from '../../app/settings.svelte'
import { handleShortcut } from '../../app/shortcuts'
import { runMenuCommand } from '../../app/menuCommands'
import TopBar from '../../app/TopBar.svelte'
import { ui } from '../../app/ui.svelte'
import { windowChrome } from '../../app/windowChrome.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import { DEFAULT_TITLE_BAR_LAYOUT, TITLE_BAR_LAYOUT_KEY } from '../../lib/titleBarLayout'
import TitleBarLayoutEditor from './TitleBarLayoutEditor.svelte'

beforeEach(async () => {
  localStorage.clear()
  sessionStorage.clear()
  window.slinger = createMockBackend({ latencyMs: 0, seed: false })
  settings.resetTitleBarLayout()
  settings.setShowSidebar(true)
  ui.settingsOpen = false
  await windowChrome.init()
})
afterEach(cleanup)

/** Accessible names of the controls on one side of the title bar, in order. */
function sideNames(index: 0 | 1): string[] {
  const side = document.querySelectorAll('[data-titlebar] [data-titlebar-side]')[index]!
  return [...side.querySelectorAll<HTMLElement>('button, select')].map((el) => el.getAttribute('aria-label') ?? el.textContent!.trim())
}
const stored = () => JSON.parse(localStorage.getItem(TITLE_BAR_LAYOUT_KEY) ?? 'null')

describe('title bar layout', () => {
  it('the title bar shows the items of each side in their order, and not the hidden ones', async () => {
    render(TopBar)
    const known = ['Go to request… Ctrl K', 'Right panel', 'Keyboard shortcuts', 'Settings', 'About Slinger']
    expect(sideNames(1).filter((n) => known.includes(n))).toEqual(known)
    expect(sideNames(0)).toContain('Sidebar')
    settings.setTitleBarLayout({ left: ['settings', 'search'], right: ['sidebar'], hidden: ['menu', 'workspace', 'sync', 'environment', 'rightPanel', 'shortcuts', 'about'] })
    await waitFor(() => expect(sideNames(0)).toEqual(['Settings', 'Go to request… Ctrl K']))
    expect(sideNames(1)).toEqual(['Sidebar'])
    expect(screen.queryByRole('button', { name: 'About Slinger' })).toBeNull()
  })

  it('the editor moves items with the arrow keys, saves at once, and resets', async () => {
    render(TitleBarLayoutEditor)
    const left = screen.getByRole('list', { name: 'Left items' })
    const right = screen.getByRole('list', { name: 'Right items' })
    const hidden = screen.getByRole('list', { name: 'Hidden items' })
    expect(within(left).getAllByRole('button').map((b) => b.dataset.item)).toEqual(DEFAULT_TITLE_BAR_LAYOUT.left)

    // Workspace switcher: up within Left, then to Right, then to Hidden.
    const ws = () => screen.getByRole('button', { name: /^Workspace switcher/ })
    await fireEvent.keyDown(ws(), { key: 'ArrowUp' })
    expect(settings.titleBarLayout.left).toEqual(['menu', 'workspace', 'sidebar', 'sync'])
    await waitFor(() => expect(document.activeElement).toBe(ws()))
    await fireEvent.keyDown(ws(), { key: 'ArrowRight' })
    expect(within(right).getAllByRole('button').map((b) => b.dataset.item)).toContain('workspace')
    await fireEvent.keyDown(ws(), { key: 'ArrowRight' })
    expect(within(hidden).getAllByRole('button').map((b) => b.dataset.item)).toEqual(['workspace'])
    expect(stored()).toMatchObject({ v: 1, hidden: ['workspace'] })

    // Settings cannot be hidden.
    const s = screen.getByRole('button', { name: /^Settings, right/ })
    await fireEvent.keyDown(s, { key: 'ArrowRight' })
    expect(settings.titleBarLayout.hidden).toEqual(['workspace'])

    await fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(settings.titleBarLayout).toEqual(DEFAULT_TITLE_BAR_LAYOUT)
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled()
  })

  it('right-clicking an empty part of the title bar offers to customize it', async () => {
    render(TopBar)
    await fireEvent.contextMenu(document.querySelector('[data-titlebar]')!)
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Customize title bar…' }))
    expect(ui.settingsOpen).toBe(true)
    expect(ui.settingsFocus).toBe('titlebar')
  })
})

describe('sidebar toggle', () => {
  it('Ctrl+B, the View menu command and the title bar button all toggle it, remembered', async () => {
    const e = new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, cancelable: true })
    expect(handleShortcut(e)).toBe(true)
    expect(e.defaultPrevented).toBe(true)
    expect(settings.showSidebar).toBe(false)
    expect(localStorage.getItem('slinger.sidebar')).toBe('false')
    // The macOS menu key equivalent of the same press is not run twice.
    expect(runMenuCommand('toggleSidebar')).toBe(false)
    await new Promise((r) => setTimeout(r, 350))
    expect(runMenuCommand('toggleSidebar')).toBe(true)
    expect(settings.showSidebar).toBe(true)

    render(TopBar)
    const button = screen.getByRole('button', { name: 'Sidebar' })
    expect(button).toHaveAttribute('aria-pressed', 'true')
    await fireEvent.click(button)
    expect(settings.showSidebar).toBe(false)
    expect(button).toHaveAttribute('aria-pressed', 'false')
  })
})

describe('window buttons', () => {
  it('are drawn by the custom title bar (Windows/Linux), act on the window, and follow its state', async () => {
    const backend = window.slinger as ReturnType<typeof createMockBackend>
    const control = vi.spyOn(backend, 'windowControl')
    render(TopBar)
    const group = screen.getByRole('group', { name: 'Window' })
    expect(within(group).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Minimise', 'Maximise', 'Close'])
    await fireEvent.click(screen.getByRole('button', { name: 'Minimise' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Maximise' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(control.mock.calls.map((c) => c[0])).toEqual(['minimize', 'toggleMaximize', 'close'])
    windowChrome.state = { ...windowChrome.state, maximized: true }
    await waitFor(() => expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument())
    windowChrome.state = { ...windowChrome.state, maximized: false }
    // At the right end they sit in the corner (no padding).
    expect(document.querySelector('[data-titlebar]')!.classList.contains('!pr-0')).toBe(true)
  })

  it('can move anywhere, e.g. to the left in macOS order, and sit flush there', async () => {
    let layout = settings.titleBarLayout
    const { moveItem } = await import('../../lib/titleBarLayout')
    layout = moveItem(moveItem(moveItem(layout, 'close', 'left', 0), 'minimize', 'left', 1), 'maximize', 'left', 2)
    settings.setTitleBarLayout(layout)
    render(TopBar)
    expect(sideNames(0).slice(0, 3)).toEqual(['Close', 'Minimise', 'Maximise'])
    const bar = document.querySelector('[data-titlebar]')!
    expect(bar.classList.contains('!pl-0')).toBe(true)
    expect(bar.classList.contains('!pr-0')).toBe(false)
  })

  it('are not drawn on macOS (traffic lights) or with the system title bar', async () => {
    windowChrome.platform = 'darwin'
    render(TopBar)
    expect(screen.queryByRole('group', { name: 'Window' })).toBeNull()
    cleanup()
    windowChrome.platform = 'linux'
    windowChrome.titleBar = 'system'
    render(TopBar)
    expect(screen.queryByRole('group', { name: 'Window' })).toBeNull()
  })
})

