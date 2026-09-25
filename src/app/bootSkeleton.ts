/**
 * Launch skeleton lifecycle. index.html ships a static `#boot-skeleton` (styled by src/styles/boot.css) that is
 * painted before any script runs. It stays on top of the real UI until the app has mounted and loaded its first
 * workspace (App.svelte calls dismissBootSkeleton once `app.ready`), then cross-fades out and is removed.
 *
 * - Data ready within INSTANT_MS of mount (the usual case with the local database): removed at once, no fade,
 *   so a fast start never flickers.
 * - Fatal startup error, or prefers-reduced-motion: removed at once so the error UI is visible immediately.
 *
 * Startup timings (performance.now(), ms since navigation start) are kept in `window.__slingerStartup`; main reads
 * them when SLINGER_STARTUP_TIMING=1, and `VITE_SLINGER_STARTUP_TIMING=1` logs them to the renderer console.
 */
export const SKELETON_ID = 'boot-skeleton'
export const FADE_MS = 150
export const INSTANT_MS = 100

export interface StartupTimings {
  /** First paint of the page (the skeleton), from the Paint Timing API when available. */
  firstPaint?: number
  boot?: number
  mounted?: number
  ready?: number
  error?: number
  /** The skeleton left the DOM: the real UI is visible and interactive. */
  removed?: number
  faded?: boolean
}

declare global {
  interface Window {
    __slingerStartup?: StartupTimings
  }
}

const timings: StartupTimings = {}
let mountedAt: number | null = null

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function mark(name: 'boot' | 'mounted' | 'ready' | 'error' | 'removed'): number {
  const t = now()
  timings[name] = Math.round(t)
  try {
    performance.mark(`slinger:${name}`)
  } catch {
    /* User Timing unavailable */
  }
  return t
}

function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

function publish(): void {
  try {
    const paint = performance.getEntriesByType?.('paint').find((e) => e.name === 'first-paint')
    if (paint) timings.firstPaint = Math.round(paint.startTime)
  } catch {
    /* Paint Timing unavailable */
  }
  window.__slingerStartup = { ...timings }
  if (import.meta.env.VITE_SLINGER_STARTUP_TIMING) console.debug('[slinger] startup timings (ms)', window.__slingerStartup)
}

/** Called first thing in main.ts. */
export function markBoot(): void {
  mark('boot')
}

/** Called right after the Svelte app was mounted. */
export function markMounted(): void {
  mountedAt = mark('mounted')
}

/** True while the skeleton is still in the DOM (including while it fades out). */
export function bootSkeletonVisible(): boolean {
  return typeof document !== 'undefined' && document.getElementById(SKELETON_ID) !== null
}

/** Fades out and removes the skeleton; safe to call repeatedly and when there is no skeleton. */
export function dismissBootSkeleton(reason: 'ready' | 'error'): void {
  if (typeof document === 'undefined') return
  const el = document.getElementById(SKELETON_ID)
  if (!el || el.dataset.leaving) return
  el.dataset.leaving = reason
  const at = mark(reason)
  const remove = () => {
    if (!el.isConnected) return
    el.remove()
    mark('removed')
    publish()
  }
  const fast = mountedAt !== null && at - mountedAt < INSTANT_MS
  if (reason === 'error' || fast || prefersReducedMotion()) {
    remove()
    return
  }
  timings.faded = true
  el.classList.add('is-leaving')
  el.addEventListener('transitionend', remove, { once: true })
  // transitionend never fires if the transition did not run (hidden window, CSS missing): remove anyway.
  setTimeout(remove, FADE_MS + 50)
}

/** Test hook: forget mount time and timings. */
export function resetBootSkeletonForTests(): void {
  mountedAt = null
  for (const k of Object.keys(timings)) delete timings[k as keyof StartupTimings]
}
