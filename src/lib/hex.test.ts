import { describe, expect, it } from 'vitest'
import { hexDump, suggestFileName } from './hex'

describe('hexDump', () => {
  it('formats offset, hex and ascii', () => {
    const out = hexDump(new TextEncoder().encode('Hello, world!\n\u0000'))
    expect(out.startsWith('00000000  48 65 6c 6c 6f 2c 20 77 6f 72 6c 64 21 0a 00')).toBe(true)
    expect(out.endsWith('Hello, world!..')).toBe(true)
  })
  it('limits output and reports the remainder', () => {
    const out = hexDump(new Uint8Array(100), 32)
    expect(out.split('\n')).toHaveLength(3)
    expect(out).toContain('68 more bytes')
  })
})

describe('suggestFileName', () => {
  it('prefers Content-Disposition', () => {
    expect(suggestFileName('application/pdf', 'attachment; filename="report 1.pdf"')).toBe('report 1.pdf')
    expect(suggestFileName('x/y', "attachment; filename*=UTF-8''a%20b.txt")).toBe('a b.txt')
  })
  it('falls back to mime extension', () => {
    expect(suggestFileName('application/json; charset=utf-8')).toBe('response.json')
    expect(suggestFileName('application/vnd.api+json')).toBe('response.json')
    expect(suggestFileName('application/x-unknown')).toBe('response.bin')
  })
})
