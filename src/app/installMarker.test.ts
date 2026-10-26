import { describe, expect, it, vi } from 'vitest'

describe('installMarker', () => {
  it('reads the profile markers once, when the module loads', async () => {
    vi.resetModules()
    localStorage.clear()
    const fresh = await import('./installMarker')
    localStorage.setItem('slinger.workspace', 'w1') // written later in the same start
    expect(fresh.existedBeforeStart).toBe(false)
    vi.resetModules()
    const next = await import('./installMarker')
    expect(next.existedBeforeStart).toBe(true)
    localStorage.clear()
  })
})
