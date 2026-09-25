import type { EditorView } from '@codemirror/view'

/**
 * Pushes an externally changed value into the editor with a minimal diff, so the caret
 * and scroll position survive (never replaces the whole document unless it must).
 */
export function applyExternalValue(view: EditorView, next: string): void {
  const current = view.state.doc.toString()
  if (current === next) return
  let start = 0
  const max = Math.min(current.length, next.length)
  while (start < max && current.charCodeAt(start) === next.charCodeAt(start)) start++
  let endCur = current.length
  let endNext = next.length
  while (endCur > start && endNext > start && current.charCodeAt(endCur - 1) === next.charCodeAt(endNext - 1)) {
    endCur--
    endNext--
  }
  view.dispatch({
    changes: { from: start, to: endCur, insert: next.slice(start, endNext) },
    // Not a user edit: keeps undo history sane and avoids re-emitting an input event upstream.
    annotations: [],
  })
}
