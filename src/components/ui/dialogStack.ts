/** Tracks open dialogs so only the top-most one reacts to Escape / traps focus. */
const stack: symbol[] = []
export function pushDialog(): symbol {
  const id = Symbol('dialog')
  stack.push(id)
  return id
}
export function popDialog(id: symbol) {
  const i = stack.indexOf(id)
  if (i >= 0) stack.splice(i, 1)
}
export function isTopDialog(id: symbol): boolean {
  return stack[stack.length - 1] === id
}
