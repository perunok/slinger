import { describe, expect, it } from 'vitest'
import { DYNAMIC_VARIABLE_LIST, generateDynamic, hasDynamicVariables, isDynamicVariable, resolveDynamicVariables } from '../../shared/dynamicVariables'

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
    for (const { name } of DYNAMIC_VARIABLE_LIST) {
      for (let i = 0; i < 20; i++) {
        const v = generateDynamic(name)!
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

  it('one list for requests, scripts and mocks: names with $, descriptions and examples, unknown names null', () => {
    expect(DYNAMIC_VARIABLE_LIST.length).toBeGreaterThan(50)
    expect(new Set(DYNAMIC_VARIABLE_LIST.map((d) => d.name)).size).toBe(DYNAMIC_VARIABLE_LIST.length)
    for (const d of DYNAMIC_VARIABLE_LIST) {
      expect(d.name).toMatch(/^\$[a-zA-Z][a-zA-Z0-9]*$/)
      expect(d.description).not.toBe('')
      expect(d.example).not.toBe('')
      expect(isDynamicVariable(d.name)).toBe(true)
    }
    expect(generateDynamic('$nope')).toBeNull()
    expect(generateDynamic('guid')).toBeNull() // needs the $
    expect(isDynamicVariable('baseUrl')).toBe(false)
    const now = new Date('2026-06-03T16:00:00Z')
    expect(generateDynamic('$date', { now })).toBe('2026-06-03')
    expect(generateDynamic('$time', { now })).toBe('16:00:00')
    expect(generateDynamic('$timestamp', { now })).toBe('1780502400')
    expect(Number(generateDynamic('$randomInt'))).toBeLessThanOrEqual(1000)
    expect(generateDynamic('$randomEmail')).toMatch(/^[a-z]+\.[a-z]+@example\.com$/)
  })
})
