import { contrast, evalColor, luminance, mix, parseHex, toHex } from './contrast'

const hex = (s: string) => parseHex(s)!

describe('contrast', () => {
  it('matches the WCAG reference values', () => {
    expect(contrast(hex('#000'), hex('#fff'))).toBeCloseTo(21, 5)
    expect(contrast(hex('#fff'), hex('#fff'))).toBeCloseTo(1, 5)
    expect(contrast(hex('#777777'), hex('#ffffff'))).toBeCloseTo(4.48, 2)
    expect(luminance(hex('#ffffff'))).toBeCloseTo(1, 5)
  })

  it('parses short, long and alpha hex', () => {
    expect(parseHex('#abc')).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc, a: 1 })
    expect(parseHex('#11223380')!.a).toBeCloseTo(0.5, 2)
    expect(parseHex('red')).toBeNull()
    expect(toHex(hex('#0a0B0c'))).toBe('#0a0b0c')
  })

  it('evaluates var(), light-dark() and color-mix(in srgb) like the browser', () => {
    const vars = { a: '#000000', b: '#ffffff', pick: 'light-dark(var(--a), var(--b))' }
    expect(toHex(evalColor('var(--pick)', { vars, scheme: 'light' }))).toBe('#000000')
    expect(toHex(evalColor('var(--pick)', { vars, scheme: 'dark' }))).toBe('#ffffff')
    expect(toHex(evalColor('color-mix(in srgb, var(--a) 25%, var(--b))', { vars, scheme: 'dark' }))).toBe('#bfbfbf')
    expect(toHex(mix(hex('#000'), hex('#fff'), 0.5))).toBe('#808080')
    expect(() => evalColor('var(--nope)', { vars, scheme: 'dark' })).toThrow(/undefined/)
    expect(() => evalColor('color-mix(in oklch, red, blue)', { vars, scheme: 'dark' })).toThrow()
  })
})

describe('evalColor fallbacks', () => {
  const ctx = { vars: {}, scheme: 'dark' as const }
  it('reads percentage rgb() channels and alpha', () => {
    expect(toHex(evalColor('rgb(100% 0% 50%)', ctx))).toBe('#ff0080')
    expect(evalColor('rgba(0, 0, 0, 50%)', ctx).a).toBeCloseTo(0.5, 5)
  })
  it('hands colours outside its subset to the leaf converter', () => {
    const leaf = (e: string) => (e === 'red' || e === 'hsl(0 100% 50%)' ? { r: 255, g: 0, b: 0, a: 1 } : null)
    expect(toHex(evalColor('red', { ...ctx, leaf }))).toBe('#ff0000')
    expect(toHex(evalColor('color-mix(in srgb, hsl(0 100% 50%) 50%, #000000)', { ...ctx, leaf }))).toBe('#800000')
    expect(() => evalColor('blue', { ...ctx, leaf })).toThrow(/unsupported/)
  })
})
