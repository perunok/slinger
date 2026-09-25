/**
 * The "sending request" loading animation: which character runs, how fast, and the runner's pixel frames.
 * Pure data and logic; the drawing is components/ui/LoadingCharacter.svelte.
 */

/** The animated characters (all original designs). */
export const LOADER_CHARACTERS = ['runner', 'shuttle', 'pebble'] as const
export type LoaderCharacter = (typeof LOADER_CHARACTERS)[number]
/** What the settings can pick: a random character per send, a fixed one, or the plain spinner. */
export type LoaderSetting = 'random' | LoaderCharacter | 'classic'
/** What a single send actually shows. */
export type LoaderKind = LoaderCharacter | 'classic'
/** The in-flight animation, then (briefly) how the send ended. Cancelling removes it at once. */
export type LoaderPhase = 'running' | 'success' | 'error'

export const LOADER_OPTIONS: readonly { id: LoaderSetting; label: string; hint: string }[] = [
  { id: 'random', label: 'Random', hint: 'a different character each send' },
  { id: 'runner', label: 'Runner', hint: 'pixel runner' },
  { id: 'shuttle', label: 'Shuttle', hint: 'space shuttle' },
  { id: 'pebble', label: 'Pebble', hint: 'slingshot pebble' },
  { id: 'classic', label: 'Classic spinner', hint: 'no character' },
]
export const DEFAULT_LOADER: LoaderSetting = 'random'

export function isLoaderSetting(v: unknown): v is LoaderSetting {
  return typeof v === 'string' && LOADER_OPTIONS.some((o) => o.id === v)
}

/** The kind shown for one send. `rng` returns [0, 1) like Math.random (injected by tests). */
export function pickLoader(setting: LoaderSetting, rng: () => number = Math.random): LoaderKind {
  if (setting !== 'random') return setting
  const i = Math.floor(rng() * LOADER_CHARACTERS.length)
  return LOADER_CHARACTERS[Math.min(LOADER_CHARACTERS.length - 1, Math.max(0, i))]!
}

/** One lap (edge to edge) at the start of a request. */
export const LAP_START_MS = 1600
/** Laps get faster the longer a request runs, down to this. */
export const LAP_MIN_MS = 1000
/** The success / error finish; the response is shown underneath meanwhile, never delayed. */
export const FINISH_MS = 380
/** Sends answered faster than this skip the finish (it would only flicker). */
export const MIN_SHOWN_FOR_FINISH_MS = 400

/** Duration of the next lap after `elapsedMs` of waiting: 1.6 s, 60 ms faster per second, never under 1 s. */
export function lapMs(elapsedMs: number): number {
  const e = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0
  return Math.round(Math.max(LAP_MIN_MS, LAP_START_MS - e * 0.06))
}

/** "0.4 s", "12.3 s", "1 min 5 s". */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, ms) / 1000
  if (s < 60) return `${s.toFixed(1)} s`
  const m = Math.floor(s / 60)
  return `${m} min ${Math.floor(s - m * 60)} s`
}

export function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

// ---- runner sprite ---------------------------------------------------------
// 10 x 12 pixel grid, facing right. '#' = body (the accent), 'o' = the far arm / leg (same colour, faded) so the two
// strides look different, 'e' = the eye (surface colour), '.' = empty. Frames: contact, passing, contact (other leg),
// passing (other leg).

export const RUNNER_W = 10
export const RUNNER_H = 12

export const RUNNER_FRAMES: readonly (readonly string[])[] = [
  [
    '...#####..',
    '...##e#...',
    '...###....',
    '....##.o..',
    '...###o...',
    '..#.##....',
    '....##....',
    '...o..#...',
    '..o....#..',
    'oo.....#..',
    '.......##.',
    '..........',
  ],
  [
    '..........',
    '...#####..',
    '...##e#...',
    '...###....',
    '....##....',
    '...o##....',
    '....###...',
    '....##....',
    '....o###..',
    '....o..#..',
    '....oo....',
    '..........',
  ],
  [
    '...#####..',
    '...##e#...',
    '...###....',
    '....##.#..',
    '...o###...',
    '..o.##....',
    '....##....',
    '...#..o...',
    '..#....o..',
    '##.....o..',
    '.......oo.',
    '..........',
  ],
  [
    '..........',
    '...#####..',
    '...##e#...',
    '...###....',
    '....##....',
    '...###....',
    '....##o...',
    '....##....',
    '....#ooo..',
    '....#..o..',
    '....##....',
    '..........',
  ],
]

/** Arms up: the finish after a successful send. */
export const RUNNER_CHEER: readonly string[] = [
  '...#####..',
  '...##e#...',
  '.#.###..#.',
  '..#.##.#..',
  '...####...',
  '....##....',
  '....##....',
  '...#..#...',
  '...#..#...',
  '..##..##..',
  '..........',
  '..........',
]

export interface Pixel {
  x: number
  y: number
  /** body, far limb or eye */
  tone: 'body' | 'far' | 'eye'
}

/** The filled cells of a frame, merged into horizontal runs (fewer rects). */
export function spritePixels(frame: readonly string[]): (Pixel & { w: number })[] {
  const out: (Pixel & { w: number })[] = []
  frame.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      const c = row[x]!
      if (c === '.') {
        x++
        continue
      }
      let w = 1
      while (row[x + w] === c) w++
      out.push({ x, y, w, tone: c === 'e' ? 'eye' : c === 'o' ? 'far' : 'body' })
      x += w
    }
  })
  return out
}
