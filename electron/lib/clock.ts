/** Injectable time source so timers and backoff are testable without real waiting. */
export interface Clock {
  /** Epoch milliseconds. */
  now(): number
}
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}
export const realClock: Clock = { now: () => Date.now() }
export const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}
