/**
 * Quitting with unsaved edits that would be lost. The window reports (setUnsavedChanges) which open tabs hold edits that
 * are neither saved nor kept for the next start (a draft too large to keep, storage full, or "Restore open tabs" off);
 * before the app quits or its window closes for good, main asks once whether to discard them. Pure: main.ts shows the
 * native dialog with `discardPrompt` and decides with `needsDiscardConfirm`.
 */

export interface DiscardContext {
  /** Titles of the tabs whose unsaved edits would be lost (as last reported by the window). */
  titles: readonly string[]
  /** Smoke test / e2e (hidden window): never block on a dialog. */
  automated: boolean
  /** The OS session is ending (log off, shutdown): not the user quitting Slinger. */
  sessionEnding: boolean
  /** The user already chose to discard them for this quit. */
  confirmed: boolean
}

export function needsDiscardConfirm(c: DiscardContext): boolean {
  return c.titles.length > 0 && !c.automated && !c.sessionEnding && !c.confirmed
}

/** At most this many titles are listed in the dialog. */
const LISTED = 8

/** The native message box: button 0 discards and quits, button 1 (default, Escape) cancels. */
export function discardPrompt(titles: readonly string[]): { type: 'warning'; message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number; noLink: boolean } {
  const n = titles.length
  const listed = titles.slice(0, LISTED).map((t) => `• ${t.length > 80 ? `${t.slice(0, 79)}…` : t}`)
  if (n > LISTED) listed.push(`… and ${n - LISTED} more`)
  return {
    type: 'warning',
    message: `Quit and discard ${n} unsaved ${n === 1 ? 'change' : 'changes'}?`,
    detail: `${n === 1 ? 'This tab has edits' : 'These tabs have edits'} that are not saved and will not be restored next time:\n${listed.join('\n')}\n\nCancel to go back and save them.`,
    buttons: ['Discard and Quit', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  }
}
