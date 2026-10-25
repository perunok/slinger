import { describe, expect, it } from 'vitest'
import { DYNAMIC_VARIABLES, hasDynamicVariables, resolveDynamicVariables } from '../../shared/dynamicVariables'

describe('dynamic variables', () => {
  it('resolves known names, each occurrence fresh, and leaves the rest alone', () => {
    const out = resolveDynamicVariables('{"a":"{{$guid}}","b":"{{$guid}}","c":"{{env}}","d":"{{$nope}}","e":{{ $randomInt }}}')
    const j = JSON.parse(out) as Record<string, unknown>
    expect(j.a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(j.a).not.toBe(j.b)
    expect(j.c).toBe('{{env}}')
    expect(j.d).toBe('{{$nope}}')
    expect(typeof j.e).toBe('number')
  })

  it('every generator gives a non-empty value that is safe inside a JSON string', () => {
    for (const [name, gen] of Object.entries(DYNAMIC_VARIABLES)) {
      for (let i = 0; i < 20; i++) {
        const v = gen(Math.random)
        expect(v, name).not.toBe('')
        expect(JSON.parse(`"${v}"`), name).toBe(v)
      }
    }
  })

  it('timestamps are now', () => {
    const t = Number(resolveDynamicVariables('{{$timestamp}}'))
    expect(Math.abs(t - Date.now() / 1000)).toBeLessThan(5)
    expect(Date.parse(resolveDynamicVariables('{{$isoTimestamp}}'))).toBeGreaterThan(Date.now() - 5000)
  })

  it('hasDynamicVariables only for known names', () => {
    expect(hasDynamicVariables('plain')).toBe(false)
    expect(hasDynamicVariables('{{baseUrl}}')).toBe(false)
    expect(hasDynamicVariables('{{$unknown}}')).toBe(false)
    expect(hasDynamicVariables('x {{$timestamp}}')).toBe(true)
  })
})
