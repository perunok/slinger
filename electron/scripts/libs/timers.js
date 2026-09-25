// Build-time shim for Node's `timers` inside the script sandbox (no real timers exist there). xml2js only uses
// setImmediate for its `async: true` mode; a microtask keeps that working because the sandbox drains promise jobs.
export function setImmediate(fn, ...args) {
  Promise.resolve().then(() => fn(...args))
}
export function clearImmediate() {}
