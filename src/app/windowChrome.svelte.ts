/**
 * The main window's frame: with the custom title bar (default) the top bar is the title bar: it drags the window,
 * leaves room for the system window buttons the OS draws over it, and on Windows/Linux has a button for the application
 * menu (there is no menu bar). Settings > Layout & window switches to the system title bar; that needs a new window.
 */
import type { TitleBarStyle, WindowAction, WindowState } from '../../shared/types'
import { api, errorInfo } from '../lib/ipc'
import { toast } from './toast.svelte'

class WindowChromeStore {
  platform = $state('')
  /** What this window was created with. Until known, render as the system title bar (no drag region, no padding). */
  titleBar = $state<TitleBarStyle>('system')
  preferred = $state<TitleBarStyle>('system')
  loaded = $state(false)
  /** Maximised / full screen / focused (pushed by main on every change). */
  state = $state<WindowState>({ maximized: false, fullScreen: false, focused: true })
  #off: (() => void) | null = null

  get custom(): boolean {
    return this.titleBar === 'custom'
  }
  /** macOS keeps its menu bar at the top of the screen. */
  get menuButton(): boolean {
    return this.custom && this.platform !== 'darwin'
  }
  /** Windows/Linux with the custom title bar: Slinger draws minimise / maximise / close (macOS keeps its traffic lights). */
  get ownWindowButtons(): boolean {
    return this.custom && this.platform !== 'darwin' && !this.state.fullScreen
  }
  /** The saved preference differs from this window: it applies once the window is reopened. */
  get pendingReopen(): boolean {
    return this.loaded && this.preferred !== this.titleBar
  }

  async init() {
    try {
      const c = await api().getWindowChrome()
      this.platform = c.platform
      this.titleBar = c.titleBar
      this.preferred = c.preferredTitleBar
      this.state = c.state
      this.loaded = true
      this.#off?.()
      this.#off = api().onWindowState?.((s) => (this.state = s)) ?? null
    } catch {
      /* stays as the system title bar */
    }
  }

  async setPreferred(style: TitleBarStyle) {
    const before = this.preferred
    this.preferred = style
    try {
      this.preferred = (await api().setTitleBarStyle(style)).preferredTitleBar
    } catch (e) {
      this.preferred = before
      toast.error('Could not save the title bar setting', errorInfo(e).message)
    }
  }

  async reopen() {
    try {
      await api().reopenWindow()
    } catch (e) {
      toast.error('Could not reopen the window', errorInfo(e).message)
    }
  }

  control(action: WindowAction) {
    api()
      .windowControl(action)
      .catch(() => {})
  }

  /** The application menu under the title bar's menu button (`anchor`). */
  showMenu(anchor: HTMLElement) {
    const r = anchor.getBoundingClientRect()
    api()
      .showAppMenu(Math.max(0, Math.round(r.left)), Math.max(0, Math.round(r.bottom)))
      .catch(() => {})
  }
}

export const windowChrome = new WindowChromeStore()
