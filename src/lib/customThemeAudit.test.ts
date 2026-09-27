import { parseHex } from './contrast'
import { auditCustomTheme, describeWarning, effectiveVars, formatRatio, tokenHex } from './customThemeAudit'
import type { CustomThemeData } from './customThemes'

const none = () => null
const base = (over: Partial<CustomThemeData> = {}): CustomThemeData => ({ label: 't', scheme: 'dark', base: 'midnight', tokens: {}, ...over })

describe('custom theme contrast audit', () => {
  it('a custom theme without overrides is as good as its base (built-ins pass)', () => {
    expect(auditCustomTheme(base(), null, none)).toEqual({ failures: [], unchecked: [] })
    expect(auditCustomTheme(base({ scheme: 'light', base: 'paper' }), 'violet', none)).toEqual({ failures: [], unchecked: [] })
  })

  it('reports the pairs an override breaks, with ratio and target', () => {
    const bgHex = tokenHex(base(), null, 'bg', none)!
    const { failures } = auditCustomTheme(base({ tokens: { text: bgHex } }), null, none)
    const textOnBg = failures.find((f) => f.fg === 'text' && f.bg === 'bg')!
    expect(textOnBg.ratio).toBeCloseTo(1, 5)
    expect(textOnBg.target).toBe(4.5)
    expect(describeWarning(textOnBg)).toBe('Text on Background: 1.0:1, needs 4.5:1 (body text)')
    expect(failures.every((f) => f.fg === 'text')).toBe(true)
  })

  it('layers a chosen accent over the custom accent tokens, like built-in themes', () => {
    const t = base({ tokens: { accent: tokenHex(base(), null, 'bg', none)! } })
    expect(auditCustomTheme(t, null, none).failures.some((f) => f.fg === 'accent')).toBe(true)
    expect(auditCustomTheme(t, 'blue', none).failures).toEqual([])
    expect(effectiveVars(t, 'blue').accent).toMatch(/^light-dark\(/)
  })

  it('derives accent backgrounds from the custom surface', () => {
    const surface = '#400000'
    const t = base({ tokens: { surface } })
    const soft = parseHex(tokenHex(t, 'blue', 'accent-soft', none)!)!
    const plain = parseHex(tokenHex(base(), 'blue', 'accent-soft', none)!)!
    expect(soft.r).toBeGreaterThan(plain.r)
  })

  it('follows the custom scheme for light-dark() values', () => {
    const t = base({ scheme: 'light', tokens: { bg: 'light-dark(#ffffff, #000000)' } })
    expect(tokenHex(t, null, 'bg', none)).toBe('#ffffff')
  })

  it('lists colours it cannot evaluate instead of failing, and uses the browser fallback when there is one', () => {
    const t = base({ tokens: { bg: 'rebeccapurple' } })
    const a = auditCustomTheme(t, null, none)
    expect(a.unchecked).toEqual(['bg'])
    const b = auditCustomTheme(t, null, (e) => (e === 'rebeccapurple' ? { r: 102, g: 51, b: 153, a: 1 } : null))
    expect(b.unchecked).toEqual([])
    expect(b.failures.some((f) => f.bg === 'bg')).toBe(true)
  })

  it('rounds ratios down so a warning never shows the target itself', () => {
    expect(formatRatio(4.49)).toBe('4.4')
    expect(formatRatio(3)).toBe('3.0')
  })
})
