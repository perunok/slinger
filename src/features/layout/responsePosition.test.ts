/** Request/response orientation: the divider toggle, per-orientation ratios, drag + keyboard resizing, shortcut and menu. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runMenuCommand } from '../../app/menuCommands'
import { settings } from '../../app/settings.svelte'
import { handleShortcut } from '../../app/shortcuts'
import { app } from '../../app/state.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import ExampleView from '../examples/ExampleView.svelte'
import RequestView from '../requests/RequestView.svelte'
import { tabsStore } from '../requests/tabs.svelte'

beforeEach(async () => {
  localStorage.clear()
  settings.setResponsePosition('below')
  localStorage.clear()
  const backend = createMockBackend({ latencyMs: 0 })
  window.slinger = backend
  tabsStore.tabs = []
  tabsStore.activeId = null
  await app.init()
  // jsdom has no pointer events / pointer capture and lays nothing out.
  ;(globalThis as { PointerEvent?: unknown }).PointerEvent ??= class extends MouseEvent {
    pointerId: number
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init)
      this.pointerId = init.pointerId ?? 0
    }
  }
  HTMLElement.prototype.setPointerCapture ??= () => {}
})
afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  settings.setResponsePosition('below')
})

const separator = () => screen.getByRole('separator', { name: 'Resize panes' })
const toggle = () => screen.getByTestId('response-position-toggle')

function renderRequest() {
  const tab = tabsStore.newTab()
  return render(RequestView, { tab })
}

/** Gives the split container a size so pointer positions map to ratios. */
function layOut(width = 1000, height = 800) {
  const root = separator().parentElement!.parentElement!
  root.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height, toJSON() {} }) as DOMRect
}

describe('response position toggle', () => {
  it('sits on the divider and switches between below and beside, persisted', async () => {
    renderRequest()
    expect(separator()).toHaveAttribute('aria-orientation', 'horizontal')
    expect(toggle()).toHaveAccessibleName('Show response beside the request')
    expect(toggle().closest('[data-testid="split-action"]')).not.toBeNull()

    await fireEvent.click(toggle())
    expect(settings.responsePosition).toBe('beside')
    expect(localStorage.getItem('slinger.responsePosition')).toBe('beside')
    expect(separator()).toHaveAttribute('aria-orientation', 'vertical')
    expect(toggle()).toHaveAccessibleName('Show response below the request')
    // The response stays mounted (no remount of the editors on a switch).
    expect(screen.getByRole('region', { name: 'Response' })).toBeInTheDocument()

    await fireEvent.click(toggle())
    expect(settings.responsePosition).toBe('below')
    expect(localStorage.getItem('slinger.responsePosition')).toBe('below')
  })

  it('each orientation remembers its own split ratio', async () => {
    localStorage.setItem('slinger.split.request', '0.7')
    localStorage.setItem('slinger.split.request.beside', '0.35')
    renderRequest()
    expect(separator()).toHaveAttribute('aria-valuenow', '70')
    await fireEvent.click(toggle())
    expect(separator()).toHaveAttribute('aria-valuenow', '35')
    await fireEvent.keyDown(separator(), { key: 'ArrowRight' })
    expect(localStorage.getItem('slinger.split.request.beside')).toBe(String(0.35 + 0.03))
    expect(localStorage.getItem('slinger.split.request')).toBe('0.7')
    await fireEvent.click(toggle())
    expect(separator()).toHaveAttribute('aria-valuenow', '70')
  })

  it('dragging the divider still resizes; pressing the toggle does not start a drag', async () => {
    renderRequest()
    layOut()
    await fireEvent.pointerDown(separator(), { pointerId: 1, clientY: 400 })
    await fireEvent.pointerMove(separator(), { pointerId: 1, clientY: 240 })
    await fireEvent.pointerUp(separator(), { pointerId: 1 })
    expect(separator()).toHaveAttribute('aria-valuenow', '30')
    expect(localStorage.getItem('slinger.split.request')).toBe('0.3')

    // The button is not part of the separator: pointer events on it never reach the drag handler.
    expect(separator().contains(toggle())).toBe(false)
    await fireEvent.pointerDown(toggle(), { pointerId: 2, clientY: 240 })
    await fireEvent.pointerMove(separator(), { pointerId: 2, clientY: 600 })
    expect(separator()).toHaveAttribute('aria-valuenow', '30')

    // Side by side: horizontal drags and Left/Right keys.
    await fireEvent.click(toggle())
    layOut()
    await fireEvent.pointerDown(separator(), { pointerId: 3, clientX: 500 })
    await fireEvent.pointerMove(separator(), { pointerId: 3, clientX: 600 })
    await fireEvent.pointerUp(separator(), { pointerId: 3 })
    expect(separator()).toHaveAttribute('aria-valuenow', '60')
    expect(localStorage.getItem('slinger.split.request.beside')).toBe('0.6')
    await fireEvent.keyDown(separator(), { key: 'ArrowDown' }) // not an axis key when side by side
    expect(separator()).toHaveAttribute('aria-valuenow', '60')
  })

  it('applies to example tabs too', async () => {
    const parent = app.requests.find((r) => r.name === 'List pets')!
    const tab = tabsStore.openExample(parent, 0)
    settings.setResponsePosition('beside')
    render(ExampleView, { tab })
    const view = screen.getByTestId('example-view')
    expect(within(view).getByRole('separator', { name: 'Resize panes' })).toHaveAttribute('aria-orientation', 'vertical')
    await fireEvent.click(within(view).getByTestId('response-position-toggle'))
    expect(within(view).getByRole('separator', { name: 'Resize panes' })).toHaveAttribute('aria-orientation', 'horizontal')
  })
})

describe('response position shortcut and menu', () => {
  const press = (init: KeyboardEventInit) => {
    const e = new KeyboardEvent('keydown', { cancelable: true, ...init })
    return { handled: handleShortcut(e), e }
  }

  it('Ctrl+Alt+V toggles (Cmd+Option+V on macOS, where the key reads "√")', () => {
    const { handled, e } = press({ key: 'v', code: 'KeyV', ctrlKey: true, altKey: true })
    expect(handled).toBe(true)
    expect(e.defaultPrevented).toBe(true)
    expect(settings.responsePosition).toBe('beside')
    expect(press({ key: '√', code: 'KeyV', metaKey: true, altKey: true }).handled).toBe(true)
    expect(settings.responsePosition).toBe('below')
  })

  it('leaves AltGr characters alone and does nothing behind a modal dialog', () => {
    // AltGr+V types "@" on some layouts (Windows reports AltGr as Ctrl+Alt).
    expect(press({ key: '@', code: 'KeyV', ctrlKey: true, altKey: true }).handled).toBe(false)
    expect(press({ key: 'v', code: 'KeyV', altKey: true }).handled).toBe(false) // no Ctrl/Cmd
    document.body.innerHTML = '<div role="dialog" aria-modal="true"></div>'
    expect(press({ key: 'v', code: 'KeyV', ctrlKey: true, altKey: true }).handled).toBe(false)
    expect(runMenuCommand('toggleResponsePosition')).toBe(false)
    expect(settings.responsePosition).toBe('below')
  })

  it('View > Toggle Response Position runs once, not twice after the key press', () => {
    expect(runMenuCommand('toggleResponsePosition')).toBe(true)
    expect(settings.responsePosition).toBe('beside')
    press({ key: 'v', code: 'KeyV', ctrlKey: true, altKey: true })
    expect(settings.responsePosition).toBe('below')
    expect(runMenuCommand('toggleResponsePosition')).toBe(false) // the macOS key equivalent of the same press
    expect(settings.responsePosition).toBe('below')
  })
})
