/**
 * Helpers shared by the right-click menus (`ContextMenu.svelte`): opening one from the keyboard (Shift+F10 or the
 * Menu key on a focused element) and placing it.
 */

/** Shift+F10 or the context-menu key: open the focused element's menu from the keyboard. */
export function isMenuKey(e: KeyboardEvent): boolean {
  return e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)
}

/**
 * Where a menu opens: at the pointer for a right-click, or just below the element for the keyboard (a key event, or
 * a `contextmenu` event the browser raised from the keyboard, which has no pointer position).
 */
export function menuPoint(e: MouseEvent | KeyboardEvent, el?: Element | null): { x: number; y: number } {
  if ('clientX' in e && (e.clientX !== 0 || e.clientY !== 0)) return { x: e.clientX, y: e.clientY }
  const target = el ?? (e.currentTarget instanceof Element ? e.currentTarget : null)
  const r = target?.getBoundingClientRect()
  return { x: (r?.left ?? 0) + 24, y: r?.bottom ?? 0 }
}

/** Text the user has selected in the page (a right-click keeps it), for a "Copy" entry over selectable text. */
export function selectedText(): string {
  return (typeof window !== 'undefined' && window.getSelection?.()?.toString()) || ''
}
