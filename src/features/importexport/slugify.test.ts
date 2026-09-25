import { describe, expect, it } from 'vitest'
import { slugify } from './slugify'

describe('slugify', () => {
  it.each([
    ['Demo API', 'demo-api'],
    ['  My / Weird: Name!! ', 'my-weird-name'],
    ['Café Ünï', 'cafe-uni'],
    ['../../etc/passwd', 'etc-passwd'],
    ['日本語', 'collection'],
    ['', 'collection'],
  ])('%s -> %s', (input, out) => expect(slugify(input)).toBe(out))

  it('caps the length without trailing dash', () => {
    const s = slugify('a'.repeat(59) + ' bbbb')
    expect(s.length).toBeLessThanOrEqual(60)
    expect(s.endsWith('-')).toBe(false)
  })
})
