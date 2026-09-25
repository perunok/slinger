import { fireEvent, render, screen } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settings } from '../../app/settings.svelte'
import { APPEARANCE_KEY } from '../../lib/appearance'
import { FINISH_MS } from '../../lib/loader'
import SendingStatus from './SendingStatus.svelte'

type Props = { sending: boolean; outcome?: 'success' | 'error' | 'cancelled' | null; startedAt?: number | null; rng?: () => number; reducedMotion?: boolean }

function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

const block = () => screen.queryByTestId('sending')
const character = () => screen.queryByTestId('loading-character')
const oncancel = vi.fn()

function setup(props: Partial<Props> = {}) {
  const r = render(SendingStatus, { sending: false, oncancel, reducedMotion: false, ...props })
  return { ...r, update: (p: Partial<Props>) => r.rerender(p) }
}

/** One send: start, wait `ms`, end with `outcome`. */
async function send(update: (p: Partial<Props>) => Promise<void>, outcome: Props['outcome'], ms = 1000) {
  await update({ sending: true, outcome: null, startedAt: Date.now() })
  const kind = block()?.dataset.loader
  vi.advanceTimersByTime(ms)
  await update({ sending: false, outcome })
  return kind
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  settings.setLoader('random')
})
afterEach(() => {
  vi.useRealTimers()
})

describe('SendingStatus', () => {
  it('renders nothing while idle', () => {
    setup()
    expect(block()).toBeNull()
  })

  it('Random picks among all three characters per send (injected RNG)', async () => {
    const { update } = setup({ rng: seeded(3) })
    const seen = new Set<string>()
    for (let i = 0; i < 40; i++) {
      seen.add((await send(update, 'cancelled', 10))!)
      expect(block()).toBeNull()
    }
    expect([...seen].sort()).toEqual(['pebble', 'runner', 'shuttle'])
  })

  it('keeps the same character for the whole send', async () => {
    let n = 0
    const { update } = setup({ rng: () => [0, 0.5, 0.9][n++ % 3]! })
    await update({ sending: true, startedAt: Date.now() })
    expect(character()).toHaveAttribute('data-kind', 'runner')
    vi.advanceTimersByTime(5000)
    await update({ startedAt: Date.now() - 5000 })
    expect(character()).toHaveAttribute('data-kind', 'runner')
    expect(n).toBe(1)
  })

  it('the setting overrides Random', async () => {
    settings.setLoader('shuttle')
    const { update } = setup({ rng: () => 0 })
    for (let i = 0; i < 5; i++) expect(await send(update, 'cancelled', 10)).toBe('shuttle')
  })

  it('shows an accessible status, the elapsed time and Cancel', async () => {
    const { update } = setup({ rng: () => 0 })
    await update({ sending: true, startedAt: Date.now() })
    expect(screen.getByRole('status')).toHaveTextContent('Sending request…')
    expect(character()).toHaveAttribute('aria-hidden', 'true')
    await vi.advanceTimersByTimeAsync(2300)
    expect(screen.getByTestId('elapsed')).toHaveTextContent('2.3 s')
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(oncancel).toHaveBeenCalled()
  })

  it('classic spinner: no character', async () => {
    settings.setLoader('classic')
    const { update } = setup()
    await update({ sending: true, startedAt: Date.now() })
    expect(block()).toHaveAttribute('data-loader', 'classic')
    expect(character()).toBeNull()
    expect(block()!.querySelector('.animate-spin')).not.toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('Sending request…')
    // and no finish afterwards
    vi.advanceTimersByTime(1000)
    await update({ sending: false, outcome: 'success' })
    expect(block()).toBeNull()
  })

  it('prefers-reduced-motion (media query): the character stands still, no finish', async () => {
    const mm = vi.spyOn(globalThis, 'matchMedia').mockImplementation(
      (q: string) => ({ matches: q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList,
    )
    const { update } = setup({ reducedMotion: undefined, rng: () => 0.5 })
    await update({ sending: true, startedAt: Date.now() })
    expect(character()).toHaveAttribute('data-motion', 'reduced')
    vi.advanceTimersByTime(1000)
    await update({ sending: false, outcome: 'success' })
    expect(block()).toBeNull()
    mm.mockRestore()
  })

  it('success: a short finish drawn over the pane, then gone', async () => {
    const { update } = setup({ rng: () => 0 })
    await send(update, 'success')
    expect(block()).toHaveAttribute('data-phase', 'success')
    expect(block()).toHaveClass('absolute', 'pointer-events-none') // the response shows underneath, not delayed
    expect(character()).toHaveAttribute('data-phase', 'success')
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    await vi.advanceTimersByTimeAsync(FINISH_MS)
    expect(block()).toBeNull()
  })

  it('error: a stumble in the danger colour', async () => {
    const { update } = setup({ rng: () => 0.9 })
    await send(update, 'error')
    expect(character()).toHaveAttribute('data-phase', 'error')
    expect(character()!.querySelector('.slg-actor')).toHaveClass('text-danger')
    await vi.advanceTimersByTimeAsync(FINISH_MS)
    expect(block()).toBeNull()
  })

  it('cancel: stops immediately', async () => {
    const { update } = setup({ rng: () => 0 })
    await send(update, 'cancelled')
    expect(block()).toBeNull()
  })

  it('an instant response skips the finish', async () => {
    const { update } = setup({ rng: () => 0 })
    await send(update, 'success', 50)
    expect(block()).toBeNull()
  })

  it('a new send during the finish starts fresh', async () => {
    let n = 0
    const { update } = setup({ rng: () => [0, 0.5][n++ % 2]! })
    await send(update, 'success')
    await update({ sending: true, outcome: null, startedAt: Date.now() })
    expect(block()).toHaveAttribute('data-phase', 'running')
    expect(character()).toHaveAttribute('data-kind', 'shuttle')
    await vi.advanceTimersByTimeAsync(FINISH_MS * 2)
    expect(block()).toHaveAttribute('data-phase', 'running') // the old finish timer did not end it
  })

  it('the setting is persisted with the appearance', () => {
    settings.setLoader('pebble')
    expect(JSON.parse(localStorage.getItem(APPEARANCE_KEY)!).loader).toBe('pebble')
    settings.setLoader('nonsense')
    expect(settings.loader).toBe('pebble')
  })
})
