/**
 * The native right-click menu of text: Electron shows none by default, so text fields would have no Cut / Copy /
 * Paste menu. A plain template (no Electron runtime needed, so it is unit-testable); electron/main.ts pops it up from
 * the window's `context-menu` event. The renderer's own right-click menus (src/components/ui/ContextMenu.svelte) call
 * preventDefault on the DOM event, and Chromium then raises no `context-menu` event, so the two never both show.
 */
import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron'

export type EditMenuParams = Pick<ContextMenuParams, 'isEditable' | 'selectionText' | 'editFlags'>

/** Editable fields: undo/redo, cut/copy/paste, select all. Selected read-only text: Copy. Anything else: no menu. */
export function editMenuTemplate(params: EditMenuParams): MenuItemConstructorOptions[] | null {
  const f = params.editFlags
  if (params.isEditable) {
    return [
      { role: 'undo', enabled: f.canUndo },
      { role: 'redo', enabled: f.canRedo },
      { type: 'separator' },
      { role: 'cut', enabled: f.canCut },
      { role: 'copy', enabled: f.canCopy },
      { role: 'paste', enabled: f.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: f.canSelectAll },
    ]
  }
  if (params.selectionText.trim()) return [{ role: 'copy', enabled: f.canCopy }]
  return null
}
