/** Tracks open dialogs so only the top-most one reacts to Escape / traps focus. */
const stack: symbol[] = []
const listeners = new Set<(open: number) => void>()
const notify = () => listeners.forEach((l) => l(stack.length))

export function pushDialog(): symbol {
  const id = Symbol('dialog')
  stack.push(id)
  notify()
  return id
}
export function popDialog(id: symbol) {
  const i = stack.indexOf(id)
  if (i >= 0) {
    stack.splice(i, 1)
    notify()
  }
}
export function isTopDialog(id: symbol): boolean {
  return stack[stack.length - 1] === id
}
/** Calls `listener` with the number of open dialogs now and on every change; returns an unsubscribe function. */
export function onDialogCountChange(listener: (open: number) => void): () => void {
  listeners.add(listener)
  listener(stack.length)
  return () => listeners.delete(listener)
}
