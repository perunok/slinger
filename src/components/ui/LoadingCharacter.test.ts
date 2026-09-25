import { fireEvent, render, screen } from '@testing-library/svelte'
import { describe, expect, it } from 'vitest'
import { lapMs } from '../../lib/loader'
import LoadingCharacter from './LoadingCharacter.svelte'

const track = () => screen.getByTestId('loading-character')
const mover = () => track().querySelector<HTMLElement>('.slg-mover')!

describe('LoadingCharacter', () => {
  it.each(['runner', 'shuttle', 'pebble'] as const)('%s turns around at every edge (animationend) with faster laps', async (kind) => {
    let t = 0
    render(LoadingCharacter, { kind, startedAt: 0, now: () => t })
    expect(track()).toHaveAttribute('data-kind', kind)
    expect(track()).toHaveAttribute('data-direction', 'right')
    expect(track()).toHaveAttribute('data-lap-ms', String(lapMs(0)))
    expect(mover().style.animationDuration).toBe('1600ms')

    t = 1600
    await fireEvent.animationEnd(mover())
    expect(track()).toHaveAttribute('data-direction', 'left')
    expect(track()).toHaveAttribute('data-lap', '1')
    expect(mover()).toHaveClass('reverse')
    expect(Number(track().dataset.lapMs)).toBeLessThan(1600)

    t = 20_000
    await fireEvent.animationEnd(mover())
    expect(track()).toHaveAttribute('data-direction', 'right')
    expect(mover()).not.toHaveClass('reverse')
    expect(track()).toHaveAttribute('data-lap-ms', '1000')
  })

  it('the runner faces the way it runs', async () => {
    render(LoadingCharacter, { kind: 'runner' })
    const actor = () => track().querySelector('.slg-actor')!
    expect(actor()).not.toHaveClass('left')
    await fireEvent.animationEnd(mover())
    expect(actor()).toHaveClass('left')
  })

  it('ignores animations of the limbs / flame bubbling up', async () => {
    render(LoadingCharacter, { kind: 'shuttle' })
    await fireEvent.animationEnd(track().querySelector('.slg-flame')!)
    expect(track()).toHaveAttribute('data-direction', 'right')
  })

  it('is decorative and uses theme colours only', () => {
    render(LoadingCharacter, { kind: 'runner' })
    expect(track()).toHaveAttribute('aria-hidden', 'true')
    expect(track().querySelector('.slg-actor')).toHaveClass('text-accent')
    expect(track().innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i)
  })

  it('success: stops where it is and plays the finish (runner cheers)', async () => {
    const { rerender } = render(LoadingCharacter, { kind: 'runner' })
    await rerender({ phase: 'success' })
    expect(track()).toHaveAttribute('data-phase', 'success')
    expect(track()).toHaveClass('finishing')
    expect(mover()).toHaveClass('still')
    expect(track().querySelector('.slg-fin')).toHaveClass('success')
    expect(track().querySelectorAll('.slg-frame')).toHaveLength(0) // the cheer replaces the run cycle
    await fireEvent.animationEnd(mover())
    expect(track()).toHaveAttribute('data-lap', '0') // no more laps
  })

  it('pebble success bursts; shuttle success lands and the flame goes out', async () => {
    const p = render(LoadingCharacter, { kind: 'pebble', phase: 'success' })
    expect(track().querySelector('.slg-burst')).not.toBeNull()
    p.unmount()
    render(LoadingCharacter, { kind: 'shuttle', phase: 'success' })
    expect(track().querySelector('.slg-fin')).toHaveClass('success')
    expect(track().querySelector('.slg-flame')).toHaveClass('out')
  })

  it.each(['runner', 'shuttle', 'pebble'] as const)('%s error: stumbles in the danger colour', (kind) => {
    render(LoadingCharacter, { kind, phase: 'error' })
    expect(track().querySelector('.slg-actor')).toHaveClass('text-danger')
    expect(track().querySelector('.slg-fin')).toHaveClass('error')
  })

  it('reduced motion: stands still with a pulse, never runs a lap', async () => {
    render(LoadingCharacter, { kind: 'runner', reduced: true })
    expect(track()).toHaveAttribute('data-motion', 'reduced')
    expect(track().querySelector('.slg-actor')).toHaveClass('pulse')
    expect(track().querySelector('.cycling')).toBeNull()
    await fireEvent.animationEnd(mover())
    expect(track()).toHaveAttribute('data-direction', 'right')
  })

  it('pauses while the window is hidden', async () => {
    render(LoadingCharacter, { kind: 'pebble' })
    expect(track()).not.toHaveAttribute('data-paused')
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    await fireEvent(document, new Event('visibilitychange'))
    expect(track()).toHaveAttribute('data-paused')
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    await fireEvent(document, new Event('visibilitychange'))
    expect(track()).not.toHaveAttribute('data-paused')
  })
})
