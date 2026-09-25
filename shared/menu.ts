/**
 * Application menu -> renderer commands. The native menu (electron/lib/appMenu.ts) never touches app state
 * itself: every Slinger-specific item sends one of these names over the `menu:command` push channel and the
 * renderer (src/app/menuCommands.ts) runs the matching action. Both ends validate with `menuCommandSchema`.
 */
import { z } from 'zod'

export const MENU_COMMANDS = [
  'newRequest',
  'closeTab',
  'import',
  'exportCollection',
  'settings',
  'about',
  'shortcuts',
] as const

export type MenuCommand = (typeof MENU_COMMANDS)[number]

export const menuCommandSchema = z.enum(MENU_COMMANDS)

/** The command name, or null for anything else (unknown names, non-strings). */
export function parseMenuCommand(value: unknown): MenuCommand | null {
  const parsed = menuCommandSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
