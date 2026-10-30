/** Cookie rules (shared/cookies.ts): RFC 6265 parsing and matching, used by main's jar and the browser mock. */
import { describe, expect, it } from 'vitest'
import {
  COOKIE_LIMITS,
  cookieHeaderValue,
  cookieMatches,
  defaultPath,
  domainMatch,
  isPublicSuffix,
  isSecureUrl,
  mergeCookieHeader,
  normalizeCookieDomain,
  parseCookieDate,
  parseSetCookie,
  pathMatch,
  scriptDomainAllowed,
  sortForHeader,
  type CookieFields,
} from '../../shared/cookies'

const NOW = 1_800_000_000
const u = (s: string) => new URL(s)
const parse = (h: string, url = 'https://api.example.com/v1/users') => parseSetCookie(h, u(url), NOW)
const ok = (h: string, url?: string): CookieFields => {
  const r = parse(h, url)
  if (!r.ok) throw new Error(r.reason)
  return r.cookie
}
const refused = (h: string, url?: string): string => {
  const r = parse(h, url)
  if (r.ok) throw new Error('accepted')
  return r.reason
}

describe('parseSetCookie', () => {
  it('a plain cookie is host-only with the default path, session, no flags', () => {
    expect(ok('sid=abc')).toEqual({
      name: 'sid',
      value: 'abc',
      domain: 'api.example.com',
      hostOnly: true,
      path: '/v1',
      expiresAt: null,
      secure: false,
      httpOnly: false,
      sameSite: null,
    })
  })

  it('reads every attribute, case-insensitively', () => {
    const c = ok('token=x=y; Domain=.Example.COM; Path=/; Secure; HttpOnly; SameSite=lax; Max-Age=60')
    expect(c).toMatchObject({ name: 'token', value: 'x=y', domain: 'example.com', hostOnly: false, path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expiresAt: NOW + 60 })
    expect(ok('a=1; samesite=STRICT').sameSite).toBe('Strict')
    expect(ok('a=1; SameSite=None; Secure').sameSite).toBe('None')
    expect(ok('a=1; SameSite=bogus').sameSite).toBeNull()
  })

  it('Max-Age wins over Expires; Max-Age <= 0 and past dates expire; the expiry is capped at 400 days', () => {
    expect(ok('a=1; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Max-Age=10').expiresAt).toBe(NOW + 10)
    expect(ok('a=1; Expires=Thu, 01 Jan 2026 00:00:00 GMT').expiresAt).toBe(Date.UTC(2026, 0, 1) / 1000)
    const gone = parse('a=1; Max-Age=0')
    expect(gone.ok && gone.expired).toBe(true)
    const past = parse('a=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT')
    expect(past.ok && past.expired).toBe(true)
    expect(ok('a=1; Max-Age=999999999').expiresAt).toBe(NOW + COOKIE_LIMITS.maxAgeSeconds)
    // An invalid Max-Age / Expires is ignored: a session cookie.
    expect(ok('a=1; Max-Age=soon; Expires=never').expiresAt).toBeNull()
  })

  it('Domain must match the host and must not be a public suffix', () => {
    expect(refused('a=1; Domain=other.com')).toMatch(/does not match/)
    expect(refused('a=1; Domain=com')).toMatch(/public suffix/)
    expect(refused('a=1; Domain=co.uk', 'https://shop.example.co.uk/')).toMatch(/public suffix/)
    expect(refused('a=1; Domain=github.io', 'https://me.github.io/')).toMatch(/public suffix/)
    expect(ok('a=1; Domain=example.co.uk', 'https://shop.example.co.uk/')).toMatchObject({ domain: 'example.co.uk', hostOnly: false })
    // A public suffix that is the host itself: host-only.
    expect(ok('a=1; Domain=localhost', 'http://localhost:3000/')).toMatchObject({ domain: 'localhost', hostOnly: true })
    // A subdomain is not a match for its parent.
    expect(refused('a=1; Domain=deep.api.example.com')).toMatch(/does not match/)
    // IP hosts: only the exact address.
    expect(ok('a=1; Domain=127.0.0.1', 'http://127.0.0.1:8080/')).toMatchObject({ domain: '127.0.0.1', hostOnly: false })
    expect(refused('a=1; Domain=0.0.1', 'http://127.0.0.1/')).toMatch(/public suffix|does not match/)
  })

  it('Secure cookies only over https or localhost', () => {
    expect(refused('a=1; Secure', 'http://example.com/')).toMatch(/plain http/)
    expect(ok('a=1; Secure', 'http://localhost:8080/').secure).toBe(true)
    expect(ok('a=1; Secure', 'http://127.0.0.1/').secure).toBe(true)
    expect(ok('a=1; Secure', 'http://app.localhost/').secure).toBe(true)
  })

  it('cookie prefixes, names, sizes and control characters', () => {
    expect(refused('__Secure-a=1')).toMatch(/__Secure-/)
    expect(ok('__Secure-a=1; Secure').name).toBe('__Secure-a')
    expect(refused('__Host-a=1; Secure; Domain=example.com')).toMatch(/__Host-/)
    expect(refused('__Host-a=1; Secure; Path=/x')).toMatch(/__Host-/)
    expect(ok('__Host-a=1; Secure; Path=/').hostOnly).toBe(true)
    expect(refused('novalue')).toMatch(/name=value/)
    expect(refused('=abc')).toMatch(/empty/)
    expect(refused('a=b\u0001c')).toMatch(/control/)
    expect(refused(`a=${'x'.repeat(COOKIE_LIMITS.maxBytes)}`)).toMatch(/larger/)
    expect(ok(`a=${'x'.repeat(COOKIE_LIMITS.maxBytes - 1)}`).value).toHaveLength(COOKIE_LIMITS.maxBytes - 1)
  })

  it('a Path that does not start with "/" falls back to the default path', () => {
    expect(ok('a=1; Path=relative').path).toBe('/v1')
    expect(ok('a=1; Path=').path).toBe('/v1')
  })
})

describe('matching', () => {
  const base = { domain: 'example.com', hostOnly: false, path: '/', secure: false, expiresAt: null }

  it('domain match: host-only only for the exact host, otherwise subdomains too', () => {
    expect(domainMatch('api.example.com', 'example.com')).toBe(true)
    expect(domainMatch('badexample.com', 'example.com')).toBe(false)
    expect(domainMatch('10.0.0.1', '0.0.1')).toBe(false)
    expect(cookieMatches(base, u('http://a.b.example.com/'), NOW)).toBe(true)
    expect(cookieMatches({ ...base, hostOnly: true }, u('http://a.example.com/'), NOW)).toBe(false)
    expect(cookieMatches({ ...base, hostOnly: true }, u('http://EXAMPLE.com/'), NOW)).toBe(true)
  })

  it('path match and default path', () => {
    expect(pathMatch('/a/b', '/a')).toBe(true)
    expect(pathMatch('/a', '/a')).toBe(true)
    expect(pathMatch('/ab', '/a')).toBe(false)
    expect(pathMatch('/a/b', '/a/')).toBe(true)
    expect(defaultPath(u('http://x/'))).toBe('/')
    expect(defaultPath(u('http://x/a'))).toBe('/')
    expect(defaultPath(u('http://x/a/b/c?q=1'))).toBe('/a/b')
    expect(cookieMatches({ ...base, path: '/api' }, u('http://example.com/api/users'), NOW)).toBe(true)
    expect(cookieMatches({ ...base, path: '/api' }, u('http://example.com/apiv2'), NOW)).toBe(false)
  })

  it('Secure and expiry', () => {
    expect(cookieMatches({ ...base, secure: true }, u('http://example.com/'), NOW)).toBe(false)
    expect(cookieMatches({ ...base, secure: true }, u('https://example.com/'), NOW)).toBe(true)
    expect(cookieMatches({ ...base, domain: 'localhost', secure: true }, u('http://localhost:3000/'), NOW)).toBe(true)
    expect(cookieMatches({ ...base, expiresAt: NOW }, u('http://example.com/'), NOW)).toBe(false)
    expect(cookieMatches({ ...base, expiresAt: NOW + 1 }, u('http://example.com/'), NOW)).toBe(true)
    expect(isSecureUrl(u('http://[::1]:80/'))).toBe(true)
    expect(isSecureUrl(u('http://127.1.2.3/'))).toBe(true)
    expect(isSecureUrl(u('http://example.localhost.com/'))).toBe(false)
  })

  it('header order: longer paths first, then older; user header wins per name', () => {
    const sorted = sortForHeader([
      { name: 'a', value: '1', path: '/', order: 1 },
      { name: 'b', value: '2', path: '/x/y', order: 3 },
      { name: 'c', value: '3', path: '/x/y', order: 2 },
    ])
    expect(cookieHeaderValue(sorted)).toBe('c=3; b=2; a=1')
    expect(cookieHeaderValue([])).toBeNull()
    expect(mergeCookieHeader('a=mine; z=9', 'a=jar; b=2')).toBe('a=mine; z=9; b=2')
    expect(mergeCookieHeader(null, 'b=2')).toBe('b=2')
    expect(mergeCookieHeader('', null)).toBeNull()
  })
})

describe('helpers', () => {
  it('RFC 6265 dates', () => {
    expect(parseCookieDate('Sun, 06 Nov 1994 08:49:37 GMT')).toBe(Date.UTC(1994, 10, 6, 8, 49, 37) / 1000)
    expect(parseCookieDate('Sunday, 06-Nov-94 08:49:37 GMT')).toBe(Date.UTC(1994, 10, 6, 8, 49, 37) / 1000)
    expect(parseCookieDate('Sun Nov  6 08:49:37 1994')).toBe(Date.UTC(1994, 10, 6, 8, 49, 37) / 1000)
    expect(parseCookieDate('06 Nov 2030 08:49:37')).toBe(Date.UTC(2030, 10, 6, 8, 49, 37) / 1000)
    expect(parseCookieDate('31 Feb 2030 08:49:37')).toBeNull()
    expect(parseCookieDate('06 Nov 1500 08:49:37')).toBeNull()
    expect(parseCookieDate('tomorrow')).toBeNull()
  })

  it('public suffixes, domains typed by the user, the scripts allow-list', () => {
    expect(isPublicSuffix('com')).toBe(true)
    expect(isPublicSuffix('.co.uk')).toBe(true)
    expect(isPublicSuffix('example.com')).toBe(false)
    expect(isPublicSuffix('127.0.0.1')).toBe(false)
    expect(normalizeCookieDomain(' .API.Example.com ')).toBe('api.example.com')
    expect(normalizeCookieDomain('bücher.de')).toBe('xn--bcher-kva.de')
    expect(normalizeCookieDomain('a b')).toBeNull()
    expect(normalizeCookieDomain('http://x')).toBeNull()
    expect(scriptDomainAllowed('api.example.com', ['example.com'])).toBe(true)
    expect(scriptDomainAllowed('example.com', ['api.example.com'])).toBe(false)
    expect(scriptDomainAllowed('evil.com', [])).toBe(false)
  })
})
