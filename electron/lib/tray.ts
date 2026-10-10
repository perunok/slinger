/**
 * Closing to the tray (Settings > Layout & window): closing the main window hides it and Slinger keeps running in the
 * system tray (macOS: the menu bar), so the MCP server, collection runs and sync go on. Only Quit (tray menu, File/app
 * menu, Ctrl/Cmd+Q) ends the app. Plain templates and decisions here (no Electron runtime, unit-testable); main.ts owns
 * the Tray and the window.
 */
import type { MenuItemConstructorOptions } from 'electron'
import { APP_NAME } from './appMenu'

/** Icon files in build/tray (resources/tray when packaged). macOS: a template image, so it follows the menu bar's colour. */
export function trayIconFiles(platform: NodeJS.Platform): { file: string; hiDpi?: string } {
  if (platform === 'darwin') return { file: 'trayTemplate.png' } // trayTemplate@2x.png is picked up next to it
  if (platform === 'win32') return { file: 'tray-16.png', hiDpi: 'tray-32.png' }
  return { file: 'tray-32.png' } // the panel scales it to its own size
}

export interface TrayMenuOptions {
  open(): void
  quit(): void
}

export function trayMenuTemplate(o: TrayMenuOptions): MenuItemConstructorOptions[] {
  return [
    { label: `Open ${APP_NAME}`, click: o.open },
    { type: 'separator' },
    { label: `Quit ${APP_NAME}`, click: o.quit },
  ]
}

export interface CloseContext {
  /** The setting (absent in window-state.json = on). */
  closeToTray: boolean
  /** A quit has begun: windows close for real. */
  quitting: boolean
  /** The window is being replaced (title bar change), not closed by the user. */
  reopening: boolean
  /** The OS is logging out or shutting down (Windows `session-end`). */
  sessionEnding: boolean
}

/** Whether closing the main window should only hide it to the tray. */
export function hidesOnClose(c: CloseContext): boolean {
  return c.closeToTray && !c.quitting && !c.reopening && !c.sessionEnding
}
