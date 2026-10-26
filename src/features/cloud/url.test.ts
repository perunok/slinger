import { describe, expect, it } from 'vitest'
import { isInsecureRemote, isValidBaseUrl, normalizeBaseUrl } from './url'

describe('cloud server URL field', () => {
  it('accepts an address typed without http:// (as main stores it)', () => {
    expect(isValidBaseUrl('172.16.0.236:8088')).toBe(true)
    expect(isValidBaseUrl('localhost:4000')).toBe(true)
    expect(isValidBaseUrl('ftp://x')).toBe(false)
    expect(normalizeBaseUrl(' 172.16.0.236:8088/ ')).toBe('http://172.16.0.236:8088')
    expect(normalizeBaseUrl('cloud.example.com:443')).toBe('https://cloud.example.com:443')
    expect(isInsecureRemote('172.16.0.236:8088')).toBe(true)
    expect(isInsecureRemote('localhost:4000')).toBe(false)
  })
})
