import { fireEvent, render, screen } from '@testing-library/svelte'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SlingerIpcApi } from '../../shared/ipc-contract'
import { createMockBackend, type MockControls } from '../dev/mockBackend'
import TopBar from './TopBar.svelte'
import { windowChrome } from './windowChrome.svelte'

let backend: SlingerIpcApi & MockControls

beforeEach(() => {
  sessionStorage.clear()
  backend = createMockBackend({ latencyMs: 0, seed: false })
  window.slinger = backend
})

describe('custom title bar', () => {
  it('is the default: the top bar becomes the drag region with a menu button (not on macOS)', async () => {
    await windowChrome.init()
    expect(windowChrome.custom).toBe(true)
    expect(windowChrome.menuButton).toBe(true)
    render(TopBar)
    const bar = document.querySelector('[data-titlebar]')!
    expect(bar.classList.contains('app-titlebar')).toBe(true)
    const show = vi.spyOn(backend, 'showAppMenu')
    await fireEvent.click(screen.getByRole('button', { name: 'Application menu' }))
    expect(show).toHaveBeenCalledTimes(1)

    windowChrome.platform = 'darwin'
    expect(windowChrome.menuButton).toBe(false)
  })

  it('a saved preference applies once the window reopens', async () => {
    await windowChrome.init()
    await windowChrome.setPreferred('system')
    expect(windowChrome.pendingReopen).toBe(true)
    // The mock "reopens" by reloading the page: a new page starts with the saved preference.
    expect(await backend.getWindowChrome()).toMatchObject({ titleBar: 'custom', preferredTitleBar: 'system' })
    await windowChrome.setPreferred('custom')
    expect(windowChrome.pendingReopen).toBe(false)
  })

  it('with the system title bar: an ordinary top bar, no menu button', async () => {
    sessionStorage.setItem('slinger.mock.titleBar', 'system')
    window.slinger = createMockBackend({ latencyMs: 0, seed: false })
    await windowChrome.init()
    render(TopBar)
    expect(document.querySelector('[data-titlebar]')!.classList.contains('app-titlebar')).toBe(false)
    expect(screen.queryByRole('button', { name: 'Application menu' })).toBeNull()
  })

  it('keeps the saved preference when saving fails', async () => {
    await windowChrome.init()
    backend.failNext('setTitleBarStyle', { code: 'io_error', message: 'disk full' })
    await windowChrome.setPreferred('system')
    expect(windowChrome.preferred).toBe('custom')
  })
})
