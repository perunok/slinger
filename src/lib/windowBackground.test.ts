import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reportWindowBackground, resetWindowBackgroundForTests } from './windowBackground'

describe('reportWindowBackground', () => {
  const setWindowBackground = vi.fn(async (_color: string) => {})
  beforeEach(() => {
    resetWindowBackgroundForTests()
    setWindowBackground.mockClear()
    window.slinger = { setWindowBackground } as unknown as typeof window.slinger
  })
  afterEach(() => document.documentElement.style.removeProperty('--bg'))

  it('sends the resolved --bg once per change', () => {
    document.documentElement.style.setProperty('--bg', '#16181d')
    reportWindowBackground()
    reportWindowBackground()
    expect(setWindowBackground.mock.calls).toEqual([['#16181d']])
    document.documentElement.style.setProperty('--bg', '#f4f5f7')
    reportWindowBackground()
    expect(setWindowBackground.mock.calls).toEqual([['#16181d'], ['#f4f5f7']])
  })

  it('stays quiet without a stylesheet or a bridge method, and retries after a rejected call', async () => {
    reportWindowBackground() // no --bg
    expect(setWindowBackground).not.toHaveBeenCalled()

    setWindowBackground.mockRejectedValueOnce(new Error('nope'))
    document.documentElement.style.setProperty('--bg', '#16181d')
    reportWindowBackground()
    await Promise.resolve()
    await Promise.resolve()
    reportWindowBackground()
    expect(setWindowBackground).toHaveBeenCalledTimes(2)

    window.slinger = {} as typeof window.slinger
    document.documentElement.style.setProperty('--bg', '#000000')
    expect(() => reportWindowBackground()).not.toThrow()
  })
})
