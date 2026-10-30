/** Pure helpers of the Cookies dialog: grouping by domain, search, expiry text and the edit form's model. */
import type { JarCookie, UpsertCookieInput } from '../../../shared/types'

export interface DomainGroup {
  domain: string
  cookies: JarCookie[]
}

/** Cookies whose name, domain or path contains the query (case-insensitive), grouped by domain in name order. */
export function groupCookies(cookies: JarCookie[], query: string): DomainGroup[] {
  const q = query.trim().toLowerCase()
  const groups = new Map<string, JarCookie[]>()
  for (const c of cookies) {
    if (q && !`${c.domain}\n${c.name}\n${c.path}`.toLowerCase().includes(q)) continue
    const list = groups.get(c.domain) ?? []
    list.push(c)
    groups.set(c.domain, list)
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([domain, list]) => ({ domain, cookies: list.sort((x, y) => x.name.localeCompare(y.name) || x.path.localeCompare(y.path)) }))
}

/** "Session", or the expiry as a local date and time. */
export function expiryText(expiresAt: number | null): string {
  if (expiresAt === null) return 'Session'
  return new Date(expiresAt * 1000).toLocaleString()
}

/** The flags column: Secure, HttpOnly, SameSite, "subdomains". */
export function flagsText(c: Pick<JarCookie, 'secure' | 'httpOnly' | 'sameSite' | 'hostOnly'>): string {
  return [c.secure && 'Secure', c.httpOnly && 'HttpOnly', c.sameSite && `SameSite=${c.sameSite}`, !c.hostOnly && 'subdomains'].filter(Boolean).join(', ')
}

/** Unix seconds -> the value of an `<input type="datetime-local">` (local time), '' for none. */
export function toLocalInput(expiresAt: number | null): string {
  if (expiresAt === null) return ''
  const d = new Date(expiresAt * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** `<input type="datetime-local">` value -> Unix seconds; null for empty or invalid. */
export function fromLocalInput(text: string): number | null {
  if (!text.trim()) return null
  const t = new Date(text).getTime()
  return Number.isFinite(t) ? Math.floor(t / 1000) : null
}

/** The add/edit form. `value` null = keep the stored value (an edit whose value was not revealed or typed). */
export interface CookieForm {
  id: string | null
  name: string
  value: string | null
  domain: string
  /** The inverse of hostOnly ("Include subdomains"). */
  subdomains: boolean
  path: string
  expires: string
  secure: boolean
  httpOnly: boolean
  sameSite: '' | 'Strict' | 'Lax' | 'None'
}

export function newForm(domain = ''): CookieForm {
  return { id: null, name: '', value: '', domain, subdomains: false, path: '/', expires: '', secure: false, httpOnly: false, sameSite: '' }
}

export function formOf(c: JarCookie): CookieForm {
  return {
    id: c.id,
    name: c.name,
    value: null,
    domain: c.domain,
    subdomains: !c.hostOnly,
    path: c.path,
    expires: toLocalInput(c.expiresAt),
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite ?? '',
  }
}

export function formInput(workspaceId: string, f: CookieForm): UpsertCookieInput {
  return {
    workspaceId,
    ...(f.id ? { id: f.id } : {}),
    name: f.name,
    ...(f.value !== null ? { value: f.value } : {}),
    domain: f.domain,
    hostOnly: !f.subdomains,
    path: f.path,
    expiresAt: fromLocalInput(f.expires),
    secure: f.secure,
    httpOnly: f.httpOnly,
    sameSite: f.sameSite || null,
  }
}

/** The allow-list as typed (one domain per line, or separated by commas / spaces). */
export function parseDomainList(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((d) => d.trim())
    .filter(Boolean)
}
