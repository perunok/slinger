/**
 * The native application menu, as a plain template (no Electron runtime needed, so it is unit-testable).
 * electron/main.ts turns it into a Menu and supplies the callbacks.
 *
 * Slinger-specific items never act in main: they call `send(command)`, which main forwards to the trusted
 * main window over the `menu:command` push channel (shared/menu.ts); the renderer runs the same action as the
 * matching keyboard shortcut (src/app/menuCommands.ts).
 *
 * Accelerators. The renderer owns Ctrl/Cmd+T (new tab), Ctrl/Cmd+W (close the request TAB), Ctrl/Cmd+, (settings)
 * and Ctrl/Cmd+/ (shortcuts) in src/app/shortcuts.ts. The menu shows those accelerators as labels only
 * (`registerAccelerator: false`), so on Windows/Linux the key press reaches the renderer's handler exactly once.
 * macOS always registers menu key equivalents; there Electron gives the page the key first and only falls back to
 * the menu when the page did not handle it (preventDefault), and the renderer additionally drops a menu command that
 * arrives right after the same command ran from the keyboard, so a key press never runs twice.
 * Cmd/Ctrl+W is never bound to closing the window: "Close Window" (macOS Window menu) uses Shift+Cmd+W.
 */
import type { MenuItemConstructorOptions } from 'electron'
import { MENU_COMMAND_CHANNEL } from '../../shared/ipc-contract'
import { parseMenuCommand, type MenuCommand } from '../../shared/menu'

export const APP_NAME = 'Slinger'

export const HELP_URLS = {
  userGuide: 'https://github.com/perunok/slinger/blob/master/docs/USER_GUIDE.md',
  releaseNotes: 'https://github.com/perunok/slinger/releases',
  reportIssue: 'https://github.com/perunok/slinger/issues/new',
  license: 'https://github.com/perunok/slinger/blob/master/LICENSE',
} as const

export type ZoomDirection = 'in' | 'out' | 'reset'

export interface AppMenuOptions {
  platform: NodeJS.Platform
  /** Packaged builds hide Reload / Developer Tools unless `devTools` is set. */
  isPackaged: boolean
  /** Force the developer items in a packaged build (SLINGER_DEVTOOLS=1). */
  devTools?: boolean
  send(command: MenuCommand): void
  openExternal(url: string): void
  zoom(direction: ZoomDirection): void
}

const separator: MenuItemConstructorOptions = { type: 'separator' }

export function buildAppMenuTemplate(o: AppMenuOptions): MenuItemConstructorOptions[] {
  const mac = o.platform === 'darwin'
  const dev = !o.isPackaged || !!o.devTools
  // An accelerator the renderer already handles: shown in the menu, not registered (see the header comment).
  const shown = (accelerator: string) => ({ accelerator, registerAccelerator: false })
  const command = (label: string, cmd: MenuCommand, extra: Partial<MenuItemConstructorOptions> = {}): MenuItemConstructorOptions => ({
    label,
    ...extra,
    click: () => o.send(cmd),
  })
  // Alt-key mnemonics (Windows/Linux only; macOS has none).
  const top = (label: string) => (mac ? label : `&${label}`)
  const link = (label: string, url: string): MenuItemConstructorOptions => ({ label, click: () => o.openExternal(url) })

  const settings = command('Settings…', 'settings', shown('CmdOrCtrl+,'))
  const about = command(`About ${APP_NAME}`, 'about')

  const appMenu: MenuItemConstructorOptions = {
    label: APP_NAME,
    submenu: [
      about,
      separator,
      settings,
      separator,
      { role: 'services' },
      separator,
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      separator,
      { role: 'quit' },
    ],
  }

  const fileMenu: MenuItemConstructorOptions = {
    label: top('File'),
    submenu: [
      command('New Request', 'newRequest', shown('CmdOrCtrl+T')),
      command('Close Tab', 'closeTab', shown('CmdOrCtrl+W')),
      separator,
      command('Import…', 'import'),
      command('Export Collection…', 'exportCollection'),
      ...(mac ? [] : [separator, settings, separator, { role: 'quit' } as MenuItemConstructorOptions]),
    ],
  }

  const editMenu: MenuItemConstructorOptions = {
    label: top('Edit'),
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      separator,
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(mac ? [{ role: 'pasteAndMatchStyle' } as MenuItemConstructorOptions] : []),
      { role: 'delete' },
      separator,
      { role: 'selectAll' },
    ],
  }

  const viewMenu: MenuItemConstructorOptions = {
    label: top('View'),
    submenu: [
      ...(dev
        ? ([{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, separator] as MenuItemConstructorOptions[])
        : []),
      { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => o.zoom('reset') },
      { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => o.zoom('in') },
      { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => o.zoom('out') },
      separator,
      { role: 'togglefullscreen' },
    ],
  }

  const windowMenu: MenuItemConstructorOptions = {
    label: 'Window',
    role: 'windowMenu',
    submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      separator,
      // Cmd+W closes the request tab (File > Close Tab); closing the window gets Shift+Cmd+W.
      { role: 'close', label: 'Close Window', accelerator: 'Shift+CmdOrCtrl+W' },
      separator,
      { role: 'front' },
    ],
  }

  const helpMenu: MenuItemConstructorOptions = {
    label: top('Help'),
    role: 'help',
    submenu: [
      link('User Guide', HELP_URLS.userGuide),
      command('Keyboard Shortcuts', 'shortcuts', shown('CmdOrCtrl+/')),
      separator,
      link('Release Notes', HELP_URLS.releaseNotes),
      link('Report an Issue', HELP_URLS.reportIssue),
      separator,
      link('View License', HELP_URLS.license),
      ...(mac ? [] : [separator, about]),
    ],
  }

  return mac ? [appMenu, fileMenu, editMenu, viewMenu, windowMenu, helpMenu] : [fileMenu, editMenu, viewMenu, helpMenu]
}

/** Chromium zoom levels (factor 1.2^level, 0 = 100 %), stepped by 0.5 like Electron's zoom roles, kept to about 40 %..250 %. */
export const ZOOM_MIN = -5
export const ZOOM_MAX = 5

export function nextZoomLevel(current: number, direction: ZoomDirection): number {
  if (direction === 'reset') return 0
  const next = Math.round(current * 2) / 2 + (direction === 'in' ? 0.5 : -0.5)
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next))
}

/** The slice of a BrowserWindow that `deliverMenuCommand` needs. */
export interface MenuCommandTarget {
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  focus(): void
  webContents: { isDestroyed(): boolean; getURL(): string; send(channel: string, ...args: unknown[]): void }
}

/**
 * Sends a menu command to the main window over `menu:command`, only while that window shows Slinger's own UI
 * (`isTrustedUrl`), and only a known command name. Returns whether it was sent.
 */
export function deliverMenuCommand(win: MenuCommandTarget | null, command: MenuCommand, isTrustedUrl: (url: string) => boolean): boolean {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return false
  const valid = parseMenuCommand(command)
  if (!valid || !isTrustedUrl(win.webContents.getURL())) return false
  if (win.isMinimized()) win.restore()
  win.focus()
  win.webContents.send(MENU_COMMAND_CHANNEL, valid)
  return true
}
