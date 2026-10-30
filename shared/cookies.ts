/**
 * Cookie jar rules (RFC 6265, with the parts of RFC 6265bis that browsers apply today). Pure: used by the main process's
 * jar (electron/services/cookieJar.ts) and by the browser mock (src/dev/mock/cookies.ts), so both behave the same.
 *
 * Decisions (also in docs/ARCHITECTURE.md, "Cookie jar"):
 * - Secure cookies are sent over https, and to localhost (localhost, *.localhost, 127.0.0.0/8, [::1]) over http too, as
 *   browsers treat those as secure contexts. A Secure cookie set by a plain-http response from another host is refused.
 * - Session cookies (no Expires / Max-Age) are kept until the user deletes them (Postman parity), not until quit.
 * - Max-Age wins over Expires; expiry is capped at 400 days, as in browsers. Max-Age <= 0 or a past Expires deletes.
 * - A Domain attribute that is a public suffix (a bare TLD, or one of PUBLIC_SUFFIXES) is refused unless it is exactly the
 *   request's host (then the cookie is host-only). The list is small and built in; nothing is fetched.
 * - HttpOnly cookies are sent like any other (an API client is not a page); SameSite is stored and shown, not enforced.
 * - Limits: name + value at most 4096 bytes, 180 cookies per domain (the oldest go first), 3000 per jar.
 * - `__Secure-` / `__Host-` prefixes are enforced; a cookie without "=" or with an empty name is refused.
 */

export type CookieSameSite = 'Strict' | 'Lax' | 'None'

/** The stored fields of one cookie (expiry in Unix seconds, null = session cookie). */
export interface CookieFields {
  name: string
  value: string
  /** Lower case, no leading dot (an IPv6 host keeps its brackets, as URL.hostname prints it). */
  domain: string
  /** Sent only to exactly `domain` (no Domain attribute), else also to its subdomains. */
  hostOnly: boolean
  path: string
  expiresAt: number | null
  secure: boolean
  httpOnly: boolean
  sameSite: CookieSameSite | null
}

export const COOKIE_LIMITS = {
  /** Name + value, in bytes (UTF-8). */
  maxBytes: 4096,
  perDomain: 180,
  perJar: 3000,
  /** Expiry cap (seconds): 400 days. */
  maxAgeSeconds: 400 * 24 * 60 * 60,
  /** Longest attribute value considered (longer ones are ignored, RFC 6265bis). */
  attributeChars: 1024,
} as const

/**
 * Public suffixes under which nobody may set a cookie for the whole suffix (besides every single-label TLD). A small
 * built-in excerpt of the Public Suffix List: common second-level registries and shared hosting domains.
 */
export const PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  // Country second-level registries
  ...['co', 'org', 'ac', 'gov', 'ltd', 'plc', 'me', 'net', 'sch', 'nhs', 'police'].map((s) => `${s}.uk`),
  ...['com', 'net', 'org', 'edu', 'gov', 'asn', 'id'].map((s) => `${s}.au`),
  ...['co', 'org', 'net', 'ac', 'govt', 'school', 'geek', 'gen', 'kiwi', 'maori'].map((s) => `${s}.nz`),
  ...['co', 'ne', 'or', 'ac', 'go', 'ed', 'gr', 'lg', 'ad'].map((s) => `${s}.jp`),
  ...['co', 'or', 'ne', 'ac', 'go', 're', 'pe'].map((s) => `${s}.kr`),
  ...['com', 'net', 'org', 'gov', 'edu', 'ac'].map((s) => `${s}.cn`),
  ...['com', 'net', 'org', 'gov', 'edu', 'idv'].map((s) => `${s}.tw`),
  ...['com', 'net', 'org', 'gov', 'edu', 'idv'].map((s) => `${s}.hk`),
  ...['com', 'net', 'org', 'gov', 'edu'].map((s) => `${s}.sg`),
  ...['com', 'net', 'org', 'gov', 'edu', 'art', 'blog', 'eco', 'eti', 'ind', 'inf', 'tec'].map((s) => `${s}.br`),
  ...['com', 'net', 'org', 'gob', 'edu'].map((s) => `${s}.mx`),
  ...['com', 'net', 'org', 'gob', 'edu', 'int'].map((s) => `${s}.ar`),
  ...['com', 'net', 'org', 'gov', 'edu'].map((s) => `${s}.co`),
  ...['com', 'net', 'org', 'gob', 'edu'].map((s) => `${s}.pe`),
  ...['co', 'net', 'org', 'firm', 'gen', 'ind', 'ac', 'gov', 'edu', 'res'].map((s) => `${s}.in`),
  ...['co', 'org', 'net', 'ac', 'gov', 'edu', 'nom', 'web'].map((s) => `${s}.za`),
  ...['com', 'net', 'org', 'gov', 'edu', 'bel', 'av', 'gen', 'web'].map((s) => `${s}.tr`),
  ...['co', 'or', 'ac', 'go', 'in', 'net', 'mil'].map((s) => `${s}.th`),
  ...['co', 'or', 'ac', 'go', 'net', 'web', 'my', 'biz'].map((s) => `${s}.id`),
  ...['com', 'net', 'org', 'gov', 'edu'].map((s) => `${s}.my`),
  ...['com', 'net', 'org', 'gov', 'edu'].map((s) => `${s}.ph`),
  ...['com', 'net', 'org', 'gov', 'edu'].map((s) => `${s}.vn`),
  ...['com', 'net', 'org', 'gov', 'edu', 'in'].map((s) => `${s}.ua`),
  ...['com', 'net', 'org', 'gov', 'edu', 'biz', 'info'].map((s) => `${s}.pl`),
  ...['co', 'org', 'net', 'ac', 'gov', 'muni'].map((s) => `${s}.il`),
  ...['com', 'net', 'org', 'gov', 'edu', 'med', 'sch'].map((s) => `${s}.sa`),
  ...['com', 'net', 'org', 'gov', 'edu'].map((s) => `${s}.eg`),
  ...['com', 'net', 'org', 'gov', 'edu'].map((s) => `${s}.ng`),
  ...['co', 'or', 'ac', 'go', 'ne', 'sc'].map((s) => `${s}.ke`),
  ...['com', 'net', 'org', 'gov', 'edu'].map((s) => `${s}.pk`),
  ...['com', 'net', 'org', 'gov', 'edu', 'gob'].map((s) => `${s}.ve`),
  ...['com', 'net', 'org', 'gov', 'edu'].map((s) => `${s}.ru`),
  ...['co', 'com', 'net', 'org', 'gv'].map((s) => `${s}.at`),
  'gc.ca', 'qc.ca', 'on.ca', 'bc.ca', 'ab.ca',
  'com.es', 'nom.es', 'org.es', 'gob.es', 'edu.es',
  'gouv.fr', 'asso.fr', 'com.fr', 'nom.fr',
  'co.it', 'gov.it', 'edu.it',
  'com.pt', 'org.pt', 'gov.pt', 'edu.pt',
  'com.gr', 'org.gr', 'gov.gr', 'edu.gr',
  'co.hu', 'org.hu', 'gov.hu',
  'eu.org', 'us.org', 'za.org', 'co.com',
  // Shared hosting: every customer is a subdomain and must not set cookies for all the others.
  'github.io', 'githubusercontent.com', 'gitlab.io', 'herokuapp.com', 'herokussl.com', 'appspot.com', 'blogspot.com',
  'vercel.app', 'now.sh', 'netlify.app', 'netlify.com', 'pages.dev', 'workers.dev', 'web.app', 'firebaseapp.com',
  'cloudfront.net', 'azurewebsites.net', 'azurestaticapps.net', 'cloudapp.net', 's3.amazonaws.com', 'elasticbeanstalk.com',
  'fly.dev', 'onrender.com', 'glitch.me', 'repl.co', 'replit.dev', 'ngrok.io', 'ngrok-free.app', 'ngrok.app', 'surge.sh',
  'readthedocs.io', 'deno.dev', 'railway.app', 'up.railway.app', 'pythonanywhere.com', 'wixsite.com', 'myshopify.com',
  'bitbucket.io', 'codeberg.page', 'translate.goog', 'run.app', 'r.appspot.com', 'trycloudflare.com', 'loca.lt',
])

/** True for an IPv4 address or a bracketed IPv6 address (URL.hostname forms). */
export function isIpHost(host: string): boolean {
  return host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
}

/** A bare TLD or a known public suffix: no cookie may be set for it as a Domain (see PUBLIC_SUFFIXES). */
export function isPublicSuffix(domain: string): boolean {
  const d = domain.toLowerCase().replace(/^\.+/, '').replace(/\.$/, '')
  if (!d) return true
  if (isIpHost(d)) return false
  return !d.includes('.') || PUBLIC_SUFFIXES.has(d)
}

/** RFC 6265 5.1.3: `host` is `domain` or a subdomain of it (never for IP addresses). */
export function domainMatch(host: string, domain: string): boolean {
  const h = host.toLowerCase()
  const d = domain.toLowerCase()
  if (h === d) return true
  return !isIpHost(h) && h.endsWith(`.${d}`)
}

/** RFC 6265 5.1.4: the directory of the request path ("/a/b/c" -> "/a/b", "/a" -> "/"). */
export function defaultPath(url: URL): string {
  const p = url.pathname
  if (!p.startsWith('/')) return '/'
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

/** RFC 6265 5.1.4 path-match. */
export function pathMatch(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true
  if (!requestPath.startsWith(cookiePath)) return false
  return cookiePath.endsWith('/') || requestPath.charAt(cookiePath.length) === '/'
}

/** https, or a loopback host over http (what browsers treat as a secure context). */
export function isSecureUrl(url: URL): boolean {
  if (url.protocol === 'https:') return true
  if (url.protocol !== 'http:') return false
  const h = url.hostname.toLowerCase()
  return h === 'localhost' || h.endsWith('.localhost') || h === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
// RFC 6265 5.1.1 delimiter = %x09 / %x20-2F / %x3B-40 / %x5B-60 / %x7B-7E
const DATE_DELIMITER = /[\x09\x20-\x2f\x3b-\x40\x5b-\x60\x7b-\x7e]+/

/** RFC 6265 5.1.1 cookie-date parsing; Unix seconds, or null when the date is not valid. */
export function parseCookieDate(text: string): number | null {
  let time: [number, number, number] | null = null
  let day: number | null = null
  let month: number | null = null
  let year: number | null = null
  for (const token of text.split(DATE_DELIMITER)) {
    if (!token) continue
    let m: RegExpExecArray | null
    if (!time && (m = /^(\d{1,2}):(\d{1,2}):(\d{1,2})(?:\D.*)?$/.exec(token))) {
      time = [Number(m[1]), Number(m[2]), Number(m[3])]
    } else if (day === null && (m = /^(\d{1,2})(?:\D.*)?$/.exec(token))) {
      day = Number(m[1])
    } else if (month === null && MONTHS.includes(token.slice(0, 3).toLowerCase())) {
      month = MONTHS.indexOf(token.slice(0, 3).toLowerCase())
    } else if (year === null && (m = /^(\d{2,4})(?:\D.*)?$/.exec(token))) {
      year = Number(m[1])
    }
  }
  if (year !== null) {
    if (year >= 70 && year <= 99) year += 1900
    else if (year >= 0 && year <= 69) year += 2000
  }
  if (!time || day === null || month === null || year === null) return null
  if (day < 1 || day > 31 || year < 1601 || time[0] > 23 || time[1] > 59 || time[2] > 59) return null
  const ms = Date.UTC(year, month, day, time[0], time[1], time[2])
  // Feb 31 and the like roll over into the next month: invalid.
  if (new Date(ms).getUTCDate() !== day) return null
  return Math.floor(ms / 1000)
}

const utf8Length = (s: string) => new TextEncoder().encode(s).length

/** Cookie names and values must not contain control characters (other than tab); RFC 6265bis 5.6 step 2. */
const CONTROL_RE = /[\x00-\x08\x0a-\x1f\x7f]/

export type ParsedSetCookie =
  /** `expired`: the header deletes the cookie (Max-Age <= 0 or a past Expires). */
  | { ok: true; cookie: CookieFields; expired: boolean }
  | { ok: false; reason: string }

/** Parses one Set-Cookie header value received from `url` (RFC 6265 5.2 + 5.3), at `now` (Unix seconds). */
export function parseSetCookie(header: string, url: URL, now: number): ParsedSetCookie {
  if (CONTROL_RE.test(header)) return { ok: false, reason: 'it contains control characters' }
  const [pair = '', ...attributes] = header.split(';')
  const eq = pair.indexOf('=')
  if (eq < 0) return { ok: false, reason: 'it has no "name=value"' }
  const name = pair.slice(0, eq).trim()
  const value = pair.slice(eq + 1).trim()
  if (!name) return { ok: false, reason: 'its name is empty' }
  if (utf8Length(name) + utf8Length(value) > COOKIE_LIMITS.maxBytes) return { ok: false, reason: `it is larger than ${COOKIE_LIMITS.maxBytes} bytes` }

  let expires: number | null = null
  let maxAge: number | null = null
  let domainAttr: string | null = null
  let pathAttr: string | null = null
  let secure = false
  let httpOnly = false
  let sameSite: CookieSameSite | null = null
  for (const raw of attributes) {
    const i = raw.indexOf('=')
    const key = (i < 0 ? raw : raw.slice(0, i)).trim().toLowerCase()
    const val = i < 0 ? '' : raw.slice(i + 1).trim()
    if (val.length > COOKIE_LIMITS.attributeChars) continue
    switch (key) {
      case 'expires': {
        const t = parseCookieDate(val)
        if (t !== null) expires = t
        break
      }
      case 'max-age':
        if (/^-?\d+$/.test(val)) {
          const n = Number(val)
          maxAge = n <= 0 ? Number.NEGATIVE_INFINITY : n
        }
        break
      case 'domain':
        if (val) domainAttr = val.replace(/^\.+/, '').toLowerCase()
        break
      case 'path':
        pathAttr = val.startsWith('/') ? val : null
        break
      case 'secure':
        secure = true
        break
      case 'httponly':
        httpOnly = true
        break
      case 'samesite': {
        const s = val.toLowerCase()
        sameSite = s === 'strict' ? 'Strict' : s === 'lax' ? 'Lax' : s === 'none' ? 'None' : null
        break
      }
      default:
        break
    }
  }

  const host = url.hostname.toLowerCase()
  if (!host) return { ok: false, reason: 'the request has no host' }
  let domain = host
  let hostOnly = true
  if (domainAttr) {
    if (isPublicSuffix(domainAttr)) {
      if (domainAttr !== host) return { ok: false, reason: `its Domain "${domainAttr}" is a public suffix` }
    } else if (!domainMatch(host, domainAttr)) {
      return { ok: false, reason: `its Domain "${domainAttr}" does not match the host ${host}` }
    } else {
      domain = domainAttr
      hostOnly = false
    }
  }
  if (secure && !isSecureUrl(url)) return { ok: false, reason: 'it is Secure but came over plain http' }
  const path = pathAttr ?? defaultPath(url)
  const lower = name.toLowerCase()
  if (lower.startsWith('__secure-') && !secure) return { ok: false, reason: 'a "__Secure-" cookie must be Secure' }
  if (lower.startsWith('__host-') && (!secure || !hostOnly || path !== '/')) {
    return { ok: false, reason: 'a "__Host-" cookie must be Secure, without Domain, with Path=/' }
  }

  let expiresAt: number | null = null
  if (maxAge !== null) expiresAt = maxAge === Number.NEGATIVE_INFINITY ? now - 1 : now + maxAge
  else if (expires !== null) expiresAt = expires
  if (expiresAt !== null) expiresAt = Math.min(expiresAt, now + COOKIE_LIMITS.maxAgeSeconds)
  const expired = expiresAt !== null && expiresAt <= now
  return { ok: true, cookie: { name, value, domain, hostOnly, path, expiresAt, secure, httpOnly, sameSite }, expired }
}

/** Whether a stored cookie goes with a request to `url` at `now` (domain, path, Secure, expiry). */
export function cookieMatches(c: Pick<CookieFields, 'domain' | 'hostOnly' | 'path' | 'secure' | 'expiresAt'>, url: URL, now: number): boolean {
  if (c.expiresAt !== null && c.expiresAt <= now) return false
  const host = url.hostname.toLowerCase()
  if (c.hostOnly ? host !== c.domain : !domainMatch(host, c.domain)) return false
  if (!pathMatch(url.pathname || '/', c.path)) return false
  return !c.secure || isSecureUrl(url)
}

/** RFC 6265 5.4 order: longer paths first, then earlier creation (`order`: creation order, smaller = older). */
export function sortForHeader<T extends { path: string; order: number }>(cookies: T[]): T[] {
  return [...cookies].sort((a, b) => b.path.length - a.path.length || a.order - b.order)
}

/** `name=value; name2=value2`, or null for none. */
export function cookieHeaderValue(cookies: Array<Pick<CookieFields, 'name' | 'value'>>): string | null {
  return cookies.length ? cookies.map((c) => `${c.name}=${c.value}`).join('; ') : null
}

/** The names of a Cookie header's pairs. */
function headerPairs(header: string): Array<{ name: string; text: string }> {
  return header
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((text) => ({ name: (text.includes('=') ? text.slice(0, text.indexOf('=')) : text).trim(), text }))
}

/** A user-set Cookie header plus the jar's cookies; the user's value wins for a name both have. */
export function mergeCookieHeader(user: string | null | undefined, jar: string | null | undefined): string | null {
  const own = user?.trim() ? headerPairs(user) : []
  const names = new Set(own.map((p) => p.name))
  const extra = jar ? headerPairs(jar).filter((p) => !names.has(p.name)) : []
  const all = [...own, ...extra].map((p) => p.text)
  return all.length ? all.join('; ') : null
}

/**
 * Normalizes a domain typed by the user (manager dialog, the scripts' allow-list): lower case, no leading dot, IDN as
 * punycode. Null when it is not a host name.
 */
export function normalizeCookieDomain(input: string): string | null {
  const d = input.trim().replace(/^\.+/, '').replace(/\.$/, '')
  if (!d || /[\s/?#@:]/.test(d.replace(/^\[[0-9a-fA-F:.]+\]$/, ''))) return null
  try {
    const host = new URL(`http://${d}/`).hostname.toLowerCase()
    return host || null
  } catch {
    return null
  }
}

/** Whether scripts may use the jar for `host`: it is an allowed domain or a subdomain of one. */
export function scriptDomainAllowed(host: string, allowed: readonly string[]): boolean {
  const h = host.toLowerCase()
  return allowed.some((d) => domainMatch(h, d))
}
