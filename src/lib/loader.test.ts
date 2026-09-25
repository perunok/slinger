import { describe, expect, it } from 'vitest'
import {
  LAP_MIN_MS,
  LAP_START_MS,
  LOADER_CHARACTERS,
  LOADER_OPTIONS,
  RUNNER_CHEER,
  RUNNER_FRAMES,
  RUNNER_H,
  RUNNER_W,
  formatElapsed,
  isLoaderSetting,
  lapMs,
  pickLoader,
  spritePixels,
} from './loader'

/** Deterministic [0, 1) source. */
function seeded(seed = 42): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

describe('pickLoader', () => {
  it('Random covers all three characters over many sends, and never the spinner', () => {
    const rng = seeded(7)
    const seen = new Map<string, number>()
    for (let i = 0; i < 300; i++) {
      const k = pickLoader('random', rng)
      seen.set(k, (seen.get(k) ?? 0) + 1)
    }
    expect([...seen.keys()].sort()).toEqual([...LOADER_CHARACTERS].sort())
    for (const n of seen.values()) expect(n).toBeGreaterThan(50)
  })

  it('maps the RNG range onto the characters, including its edges', () => {
    expect(pickLoader('random', () => 0)).toBe('runner')
    expect(pickLoader('random', () => 0.5)).toBe('shuttle')
    expect(pickLoader('random', () => 0.9999)).toBe('pebble')
    expect(pickLoader('random', () => 1)).toBe('pebble') // defensive: an RNG that returns 1
  })

  it('a chosen character or the classic spinner overrides Random', () => {
    const rng = () => {
      throw new Error('not consulted')
    }
    for (const s of ['runner', 'shuttle', 'pebble', 'classic'] as const) expect(pickLoader(s, rng)).toBe(s)
  })

  it('knows the settings values', () => {
    expect(LOADER_OPTIONS.map((o) => o.id)).toEqual(['random', 'runner', 'shuttle', 'pebble', 'classic'])
    expect(isLoaderSetting('pebble')).toBe(true)
    expect(isLoaderSetting('mario')).toBe(false)
    expect(isLoaderSetting(undefined)).toBe(false)
  })
})

describe('lap speed', () => {
  it('starts at 1.6 s and gets faster the longer the request runs, capped', () => {
    expect(lapMs(0)).toBe(LAP_START_MS)
    expect(lapMs(-5)).toBe(LAP_START_MS)
    expect(lapMs(NaN)).toBe(LAP_START_MS)
    expect(lapMs(3000)).toBeLessThan(lapMs(1000))
    expect(lapMs(10_000)).toBe(LAP_MIN_MS)
    expect(lapMs(10 * 60_000)).toBe(LAP_MIN_MS)
  })

  it('formats the elapsed time', () => {
    expect(formatElapsed(0)).toBe('0.0 s')
    expect(formatElapsed(2345)).toBe('2.3 s')
    expect(formatElapsed(65_400)).toBe('1 min 5 s')
  })
})

describe('runner sprite', () => {
  it('has 4 frames plus the cheer, all on the same grid', () => {
    expect(RUNNER_FRAMES).toHaveLength(4)
    for (const f of [...RUNNER_FRAMES, RUNNER_CHEER]) {
      expect(f).toHaveLength(RUNNER_H)
      for (const row of f) expect(row).toMatch(new RegExp(`^[.#oe]{${RUNNER_W}}$`))
    }
    // the frames differ (it is a run cycle, not one picture)
    expect(new Set(RUNNER_FRAMES.map((f) => f.join('|'))).size).toBe(4)
  })

  it('merges pixels into horizontal runs per tone', () => {
    expect(spritePixels(['.##e', 'o..#'])).toEqual([
      { x: 1, y: 0, w: 2, tone: 'body' },
      { x: 3, y: 0, w: 1, tone: 'eye' },
      { x: 0, y: 1, w: 1, tone: 'far' },
      { x: 3, y: 1, w: 1, tone: 'body' },
    ])
  })
})
