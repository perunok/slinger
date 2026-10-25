/**
 * Application menu -> renderer commands. The native menu (electron/lib/appMenu.ts) never touches app state
 * itself: every Slinger-specific item sends one of these names over the `menu:command` push channel and the
 * renderer (src/app/menuCommands.ts) runs the matching action. Both ends validate with `parseMenuCommand`.
 * No zod here: the sandboxed preload imports this file, and zod would make up almost all of its bundle.
 */

export const MENU_COMMANDS = [
  'newRequest',
  'closeTab',
  'import',
  'exportCollection',
  'settings',
  'about',
  'shortcuts',
  'toggleResponsePosition',
  'toggleStatusBar',
  'toggleRightPanel',
  'toggleSidebar',
  'checkForUpdates',
] as const

export type MenuCommand = (typeof MENU_COMMANDS)[number]

const KNOWN: ReadonlySet<string> = new Set(MENU_COMMANDS)

/** The command name, or null for anything else (unknown names, non-strings). */
export function parseMenuCommand(value: unknown): MenuCommand | null {
  return typeof value === 'string' && KNOWN.has(value) ? (value as MenuCommand) : null
}
