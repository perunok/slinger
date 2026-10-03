/**
 * The main window's frame: with the custom title bar (default) the top bar is the title bar: it drags the window,
 * leaves room for the system window buttons the OS draws over it, and on Windows/Linux has a button for the application
 * menu (there is no menu bar). Settings > Window switches to the system title bar; that needs a new window.
 */
import type { TitleBarStyle } from '../../shared/types'
import { api, errorInfo } from '../lib/ipc'
import { toast } from './toast.svelte'

class WindowChromeStore {
  platform = $state('')
  /** What this window was created with. Until known, render as the system title bar (no drag region, no padding). */
  titleBar = $state<TitleBarStyle>('system')
  preferred = $state<TitleBarStyle>('system')
  loaded = $state(false)

  get custom(): boolean {
    return this.titleBar === 'custom'
  }
  /** macOS keeps its menu bar at the top of the screen. */
  get menuButton(): boolean {
    return this.custom && this.platform !== 'darwin'
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
      this.loaded = true
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

  /** The application menu under the title bar's menu button (`anchor`). */
  showMenu(anchor: HTMLElement) {
    const r = anchor.getBoundingClientRect()
    api()
      .showAppMenu(Math.max(0, Math.round(r.left)), Math.max(0, Math.round(r.bottom)))
      .catch(() => {})
  }
}

export const windowChrome = new WindowChromeStore()
