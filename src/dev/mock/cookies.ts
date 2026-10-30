/**
 * The cookie jar of the browser mock: in memory, one per workspace, same rules as main (shared/cookies.ts), so browser
 * dev mode and renderer tests behave like the app. Values are plain here (main encrypts them at rest).
 */
import type { SlingerIpcApi } from '../../../shared/ipc-contract'
import type { JarCookie } from '../../../shared/types'
import {
  COOKIE_LIMITS,
  cookieHeaderValue,
  cookieMatches,
  isPublicSuffix,
  normalizeCookieDomain,
  parseSetCookie,
  sortForHeader,
  type CookieFields,
} from '../../../shared/cookies'
import type { MockState } from './store'
import { fail, nowSec, uuid } from './util'

export interface MockCookie extends JarCookie {
  value: string
  /** Creation order (header order tie-break). */
  order: number
}

type CookiesApi = Pick<
  SlingerIpcApi,
  'listCookies' | 'revealCookie' | 'upsertCookie' | 'deleteCookie' | 'clearCookies' | 'getCookieScriptDomains' | 'setCookieScriptDomains'
>

let order = 0
const BAD_NAME = /[\x00-\x20\x7f;=,"\\]/
const BAD_VALUE = /[\x00-\x08\x0a-\x1f\x7f;]/

const listed = ({ value: _v, order: _o, ...c }: MockCookie): JarCookie => ({ ...c })

function purge(s: MockState, workspaceId: string): void {
  const now = nowSec()
  s.cookies = s.cookies.filter((c) => c.workspaceId !== workspaceId || c.expiresAt === null || c.expiresAt > now)
}

/** Inserts or replaces (name + domain + path) one cookie; applies main's limits. */
function put(s: MockState, workspaceId: string, f: CookieFields, replaceId?: string): MockCookie {
  const now = nowSec()
  const same = (c: MockCookie) => c.workspaceId === workspaceId && c.domain === f.domain && c.path === f.path && c.name === f.name
  const existing = s.cookies.find(same)
  const previous = replaceId ? s.cookies.find((c) => c.id === replaceId) : undefined
  if (previous && existing && previous !== existing) s.cookies = s.cookies.filter((c) => c !== previous)
  const target = existing ?? previous
  const row: MockCookie = {
    id: target?.id ?? uuid(),
    workspaceId,
    ...f,
    createdAt: target?.createdAt ?? now,
    updatedAt: now,
    order: target?.order ?? ++order,
  }
  s.cookies = [...s.cookies.filter((c) => c !== target), row]
  purge(s, workspaceId)
  const trim = (pick: (c: MockCookie) => boolean, max: number) => {
    const rows = s.cookies.filter(pick).sort((a, b) => a.order - b.order)
    if (rows.length > max) {
      const drop = new Set(rows.slice(0, rows.length - max))
      s.cookies = s.cookies.filter((c) => !drop.has(c))
    }
  }
  trim((c) => c.workspaceId === workspaceId && c.domain === f.domain, COOKIE_LIMITS.perDomain)
  trim((c) => c.workspaceId === workspaceId, COOKIE_LIMITS.perJar)
  return row
}

/** The Cookie header the jar adds for a request to `url` (null: none). */
export function mockCookieHeader(s: MockState, workspaceId: string, url: URL): string | null {
  const now = nowSec()
  const hits = s.cookies.filter((c) => c.workspaceId === workspaceId && cookieMatches(c, url, now))
  return cookieHeaderValue(sortForHeader(hits))
}

/** Stores a response's Set-Cookie headers as received from `url`. */
export function mockStoreCookies(s: MockState, workspaceId: string, url: URL, setCookies: string[]): void {
  if (!s.workspaces.some((w) => w.id === workspaceId)) return
  for (const header of setCookies) {
    const parsed = parseSetCookie(header, url, nowSec())
    if (!parsed.ok) continue
    const c = parsed.cookie
    if (parsed.expired) s.cookies = s.cookies.filter((x) => !(x.workspaceId === workspaceId && x.domain === c.domain && x.path === c.path && x.name === c.name))
    else put(s, workspaceId, c)
  }
}

/** Like main's CookieService.redact: the jar's values (>= 4 characters) except those the response set. */
export function mockRedactCookies(s: MockState, workspaceId: string, texts: string[], responseSetCookies: string[]): string[] {
  const keep = new Set(responseSetCookies.map((h) => (h.split(';')[0] ?? '').split('=').slice(1).join('=').trim()))
  const values = [...new Set(s.cookies.filter((c) => c.workspaceId === workspaceId && c.value.length >= 4 && !keep.has(c.value)).map((c) => c.value))]
  values.sort((a, b) => b.length - a.length)
  return texts.map((t) => {
    let out = t
    for (const v of values) {
      out = out.split(v).join('[hidden]')
      const enc = encodeURIComponent(v)
      if (enc !== v) out = out.split(enc).join('[hidden]')
    }
    return out
  })
}

export function createCookiesApi(s: MockState): CookiesApi {
  const workspace = (id: string) => {
    if (!s.workspaces.some((w) => w.id === id)) fail('not_found', `workspace not found: ${id}`)
  }
  const cookie = (id: string) => s.cookies.find((c) => c.id === id) ?? fail('not_found', 'cookie not found')
  return {
    async listCookies(workspaceId) {
      workspace(workspaceId)
      purge(s, workspaceId)
      return s.cookies
        .filter((c) => c.workspaceId === workspaceId)
        .sort((a, b) => a.domain.localeCompare(b.domain) || a.path.localeCompare(b.path) || a.name.localeCompare(b.name))
        .map(listed)
    },
    async revealCookie(id) {
      return cookie(id).value
    },
    async upsertCookie(input) {
      workspace(input.workspaceId)
      const name = input.name.trim()
      if (!name) fail('invalid_input', 'The cookie needs a name')
      if (BAD_NAME.test(name)) fail('invalid_input', 'A cookie name cannot contain spaces, control characters or any of ; = , " \\')
      const domain = normalizeCookieDomain(input.domain)
      if (!domain) fail('invalid_input', 'The domain is not a valid host name')
      if (!input.hostOnly && isPublicSuffix(domain)) fail('invalid_input', `"${domain}" is a public suffix: a cookie for it and all its subdomains is not allowed`)
      const path = input.path.trim() || '/'
      if (!path.startsWith('/')) fail('invalid_input', 'The path must start with "/"')
      const previous = input.id ? cookie(input.id) : undefined
      if (previous && previous.workspaceId !== input.workspaceId) fail('not_found', 'cookie not found')
      const value = input.value ?? previous?.value ?? ''
      if (BAD_VALUE.test(value)) fail('invalid_input', 'A cookie value cannot contain ";" or control characters')
      if (new TextEncoder().encode(name + value).length > COOKIE_LIMITS.maxBytes) fail('invalid_input', `Name and value together are larger than ${COOKIE_LIMITS.maxBytes} bytes`)
      const row = put(
        s,
        input.workspaceId,
        { name, value, domain, hostOnly: input.hostOnly, path, expiresAt: input.expiresAt, secure: input.secure, httpOnly: input.httpOnly, sameSite: input.sameSite },
        previous?.id,
      )
      return listed(row)
    },
    async deleteCookie(id) {
      s.cookies = s.cookies.filter((c) => c.id !== id)
    },
    async clearCookies(workspaceId, domain) {
      workspace(workspaceId)
      const d = domain === null ? null : (normalizeCookieDomain(domain) ?? domain.trim().toLowerCase())
      const before = s.cookies.length
      s.cookies = s.cookies.filter((c) => c.workspaceId !== workspaceId || (d !== null && c.domain !== d))
      return before - s.cookies.length
    },
    async getCookieScriptDomains(workspaceId) {
      workspace(workspaceId)
      return [...(s.cookieScriptDomains[workspaceId] ?? [])]
    },
    async setCookieScriptDomains(workspaceId, domains) {
      workspace(workspaceId)
      const clean: string[] = []
      for (const d of domains) {
        if (!d.trim()) continue
        const n = normalizeCookieDomain(d)
        if (!n) fail('invalid_input', `"${d.trim()}" is not a domain`)
        if (isPublicSuffix(n)) fail('invalid_input', `"${n}" is a public suffix; allow a domain under it instead`)
        if (!clean.includes(n)) clean.push(n)
      }
      s.cookieScriptDomains[workspaceId] = clean
      return [...clean]
    },
  }
}
