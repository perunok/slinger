/**
 * The cookie jar (0.29): one per workspace, in SQLite (migration 0021), local only. Implements `CookieJarPort` for the
 * HTTP executor (user sends, the collection runner and workflows through `HttpService`, pm.sendRequest through
 * `scriptHttp.ts`), the Cookies dialog's IPC methods, pm.cookies.jar() for scripts and the MCP output redaction.
 *
 * Values are credentials (session ids, auth tokens), so they are stored encrypted: AES-256-GCM with a random 256-bit key
 * per install, kept in the OS keychain (`slinger:cookie-jar-key`, read through the SecretStore like every other secret),
 * a random 96-bit IV per write and the workspace + cookie id as additional data (a value cannot be moved to another row).
 * Names, domains, paths and flags are plain. Matching rules are in shared/cookies.ts.
 *
 * When the keychain cannot be used, sends go out without jar cookies and store nothing (a warning is logged once); the
 * Cookies dialog reports the error.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { JarCookie, UpsertCookieInput } from '../../shared/types'
import {
  COOKIE_LIMITS,
  cookieHeaderValue,
  cookieMatches,
  domainMatch,
  isPublicSuffix,
  normalizeCookieDomain,
  parseSetCookie,
  scriptDomainAllowed,
  sortForHeader,
  type CookieFields,
} from '../../shared/cookies'
import type { Db } from '../db/database'
import { invalidInput, ioError, IpcError, notFound } from '../lib/errors'
import { assertUuid, newId } from '../lib/ids'
import { requireWorkspace } from '../repositories/common'
import type { CookieJarPort } from './cookieJarPort'
import type { SecretStore } from './secrets'
import type { CookieJarCall, CookieJarOutcome, ScriptCookie } from '../scripts/job'

/** Keychain entry of the per-install key that encrypts cookie values (base64 of 32 random bytes). */
export const COOKIE_KEY_REF = 'slinger:cookie-jar-key'
/** Most domains in a workspace's scripts allow-list. */
export const MAX_SCRIPT_DOMAINS = 200

interface CookieRow {
  id: string
  workspace_id: string
  name: string
  value_enc: string
  domain: string
  host_only: number
  path: string
  expires_at: number | null
  secure: number
  http_only: number
  same_site: 'Strict' | 'Lax' | 'None' | null
  created_at: number
  updated_at: number
  rowid: number
}

const toJarCookie = (r: CookieRow): JarCookie => ({
  id: r.id,
  workspaceId: r.workspace_id,
  name: r.name,
  domain: r.domain,
  hostOnly: r.host_only === 1,
  path: r.path,
  expiresAt: r.expires_at,
  secure: r.secure === 1,
  httpOnly: r.http_only === 1,
  sameSite: r.same_site,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

const SELECT = 'SELECT rowid, * FROM cookies'
// Name and value as a cookie header can carry them: no separators that would split it, no control characters.
const BAD_NAME = /[\x00-\x20\x7f;=,"\\]/
const BAD_VALUE = /[\x00-\x08\x0a-\x1f\x7f;]/

export class CookieService {
  private keyCache: Buffer | null = null
  private warned = false

  constructor(
    private readonly db: Db,
    private readonly secrets: SecretStore,
    /** Unix seconds. */
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  // ---- encryption ---------------------------------------------------------------

  private key(): Buffer {
    if (this.keyCache) return this.keyCache
    let stored: string | null
    try {
      stored = this.secrets.get(COOKIE_KEY_REF)
    } catch (err) {
      throw err instanceof IpcError ? err : ioError(`The cookie jar's key could not be read: ${err instanceof Error ? err.message : String(err)}`)
    }
    let key = stored ? Buffer.from(stored, 'base64') : null
    if (!key || key.length !== 32) {
      // First use, or an unusable entry: a new key (values encrypted under a lost key cannot be read anyway).
      key = randomBytes(32)
      this.secrets.set(COOKIE_KEY_REF, key.toString('base64'))
    }
    this.keyCache = key
    return key
  }

  private encrypt(workspaceId: string, id: string, value: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv)
    cipher.setAAD(Buffer.from(`${workspaceId}:${id}`, 'utf8'))
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return `v1:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')}`
  }

  private decrypt(r: Pick<CookieRow, 'workspace_id' | 'id' | 'value_enc'>): string {
    const m = /^v1:(.+)$/.exec(r.value_enc)
    try {
      if (!m) throw new Error('unknown format')
      const raw = Buffer.from(m[1]!, 'base64')
      const decipher = createDecipheriv('aes-256-gcm', this.key(), raw.subarray(0, 12))
      decipher.setAAD(Buffer.from(`${r.workspace_id}:${r.id}`, 'utf8'))
      decipher.setAuthTag(raw.subarray(12, 28))
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
    } catch (err) {
      if (err instanceof IpcError) throw err
      throw ioError('This cookie\'s value cannot be read on this device any more (the key in the OS keychain changed); delete it')
    }
  }

  private warnOnce(err: unknown): void {
    if (this.warned) return
    this.warned = true
    console.warn('[slinger] the cookie jar is unavailable:', err instanceof Error ? err.message : err)
  }

  // ---- storage ------------------------------------------------------------------

  private purgeExpired(workspaceId: string): void {
    this.db.prepare('DELETE FROM cookies WHERE workspace_id = ? AND expires_at IS NOT NULL AND expires_at <= ?').run(workspaceId, this.now())
  }

  private rowsOf(workspaceId: string): CookieRow[] {
    return this.db.prepare(`${SELECT} WHERE workspace_id = ? ORDER BY domain, path, name`).all(workspaceId) as CookieRow[]
  }

  private rowById(id: string): CookieRow {
    const row = this.db.prepare(`${SELECT} WHERE id = ?`).get(assertUuid(id, 'cookieId')) as CookieRow | undefined
    if (!row) throw notFound('cookie')
    return row
  }

  /** Stores (inserts or replaces by name + domain + path) one cookie, then applies the limits. Runs in a transaction. */
  private put(workspaceId: string, c: CookieFields, replaceId?: string): CookieRow {
    return this.db.transaction(() => {
      const now = this.now()
      const existing = this.db
        .prepare('SELECT id, created_at FROM cookies WHERE workspace_id = ? AND domain = ? AND path = ? AND name = ?')
        .get(workspaceId, c.domain, c.path, c.name) as { id: string; created_at: number } | undefined
      let id = existing?.id ?? replaceId ?? newId()
      const createdAt = existing?.created_at ?? now
      if (replaceId && existing && existing.id !== replaceId) {
        // An edit that now has the name/domain/path of another cookie replaces that one.
        this.db.prepare('DELETE FROM cookies WHERE id = ?').run(replaceId)
        id = existing.id
      }
      const enc = this.encrypt(workspaceId, id, c.value)
      if (replaceId && !existing) {
        this.db
          .prepare(
            `UPDATE cookies SET name = ?, value_enc = ?, domain = ?, host_only = ?, path = ?, expires_at = ?, secure = ?, http_only = ?,
             same_site = ?, updated_at = ? WHERE id = ?`,
          )
          .run(c.name, enc, c.domain, c.hostOnly ? 1 : 0, c.path, c.expiresAt, c.secure ? 1 : 0, c.httpOnly ? 1 : 0, c.sameSite, now, id)
      } else {
        this.db
          .prepare(
            `INSERT INTO cookies (id, workspace_id, name, value_enc, domain, host_only, path, expires_at, secure, http_only, same_site, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET value_enc = excluded.value_enc, host_only = excluded.host_only, expires_at = excluded.expires_at,
               secure = excluded.secure, http_only = excluded.http_only, same_site = excluded.same_site, updated_at = excluded.updated_at`,
          )
          .run(id, workspaceId, c.name, enc, c.domain, c.hostOnly ? 1 : 0, c.path, c.expiresAt, c.secure ? 1 : 0, c.httpOnly ? 1 : 0, c.sameSite, createdAt, now)
      }
      this.enforceLimits(workspaceId, c.domain)
      return this.rowById(id)
    })()
  }

  /** 180 per domain and 3000 per jar: expired ones go first, then the oldest. */
  private enforceLimits(workspaceId: string, domain: string): void {
    this.purgeExpired(workspaceId)
    const trim = (where: string, args: unknown[], max: number) => {
      const { n } = this.db.prepare(`SELECT COUNT(*) AS n FROM cookies WHERE ${where}`).get(...args) as { n: number }
      if (n <= max) return
      this.db
        .prepare(`DELETE FROM cookies WHERE id IN (SELECT id FROM cookies WHERE ${where} ORDER BY created_at, rowid LIMIT ?)`)
        .run(...args, n - max)
    }
    trim('workspace_id = ? AND domain = ?', [workspaceId, domain], COOKIE_LIMITS.perDomain)
    trim('workspace_id = ?', [workspaceId], COOKIE_LIMITS.perJar)
  }

  private deleteByKey(workspaceId: string, c: Pick<CookieFields, 'domain' | 'path' | 'name'>): void {
    this.db.prepare('DELETE FROM cookies WHERE workspace_id = ? AND domain = ? AND path = ? AND name = ?').run(workspaceId, c.domain, c.path, c.name)
  }

  /** The cookies going with a request to `url`, in header order (shared/cookies.ts). */
  private matching(workspaceId: string, url: URL): CookieRow[] {
    const now = this.now()
    const host = url.hostname.toLowerCase()
    // Only rows whose domain is the host or one of its parent domains can match.
    const labels = host.split('.')
    const candidates = host.startsWith('[') ? [host] : labels.map((_, i) => labels.slice(i).join('.'))
    const rows = this.db
      .prepare(`${SELECT} WHERE workspace_id = ? AND domain IN (${candidates.map(() => '?').join(',')})`)
      .all(workspaceId, ...candidates) as CookieRow[]
    const hits = rows
      .filter((r) => cookieMatches({ domain: r.domain, hostOnly: r.host_only === 1, path: r.path, secure: r.secure === 1, expiresAt: r.expires_at }, url, now))
      .map((r) => ({ ...r, order: r.created_at * 1e9 + r.rowid }))
    return sortForHeader(hits)
  }

  // ---- CookieJarPort --------------------------------------------------------------

  /** The workspace's jar as the HTTP executor uses it. */
  jar(workspaceId: string): CookieJarPort {
    const wid = assertUuid(workspaceId, 'workspaceId')
    return {
      cookieHeaderFor: async (url) => this.cookieHeaderFor(wid, url),
      storeFromResponse: async (url, headers) => this.storeFromResponse(wid, url, headers),
    }
  }

  cookieHeaderFor(workspaceId: string, url: URL): string | null {
    try {
      const rows = this.matching(workspaceId, url)
      if (rows.length === 0) return null
      this.key() // a keychain failure: no cookies at all (below)
      const pairs: Array<{ name: string; value: string }> = []
      for (const r of rows) {
        try {
          pairs.push({ name: r.name, value: this.decrypt(r) })
        } catch {
          // A value under a lost key is skipped (the dialog still lists the cookie; the user can delete it).
        }
      }
      return cookieHeaderValue(pairs)
    } catch (err) {
      this.warnOnce(err)
      return null
    }
  }

  storeFromResponse(workspaceId: string, url: URL, setCookieHeaders: string[]): void {
    if (setCookieHeaders.length === 0) return
    try {
      const now = this.now()
      for (const header of setCookieHeaders) {
        const parsed = parseSetCookie(header, url, now)
        if (!parsed.ok) continue
        if (parsed.expired) this.deleteByKey(workspaceId, parsed.cookie)
        else this.put(workspaceId, parsed.cookie)
      }
    } catch (err) {
      // The workspace was deleted meanwhile, or the keychain is unavailable: the response still counts.
      this.warnOnce(err)
    }
  }

  // ---- IPC (Cookies dialog) ---------------------------------------------------------

  list(workspaceId: string): JarCookie[] {
    const ws = requireWorkspace(this.db, workspaceId)
    this.purgeExpired(ws.id)
    return this.rowsOf(ws.id).map(toJarCookie)
  }

  reveal(cookieId: string): string {
    return this.decrypt(this.rowById(cookieId))
  }

  upsert(input: UpsertCookieInput): JarCookie {
    const ws = requireWorkspace(this.db, input.workspaceId)
    const name = input.name.trim()
    if (!name) throw invalidInput('The cookie needs a name')
    if (BAD_NAME.test(name)) throw invalidInput('A cookie name cannot contain spaces, control characters or any of ; = , " \\')
    const domain = normalizeCookieDomain(input.domain)
    if (!domain) throw invalidInput('The domain is not a valid host name')
    if (!input.hostOnly && isPublicSuffix(domain)) throw invalidInput(`"${domain}" is a public suffix: a cookie for it and all its subdomains is not allowed`)
    const path = input.path.trim() || '/'
    if (!path.startsWith('/')) throw invalidInput('The path must start with "/"')
    if (path.length > COOKIE_LIMITS.attributeChars) throw invalidInput('The path is too long')
    const previous = input.id ? this.rowById(input.id) : null
    if (previous && previous.workspace_id !== ws.id) throw notFound('cookie')
    const value = input.value ?? (previous ? this.decrypt(previous) : '')
    if (BAD_VALUE.test(value)) throw invalidInput('A cookie value cannot contain ";" or control characters')
    if (new TextEncoder().encode(name + value).length > COOKIE_LIMITS.maxBytes) throw invalidInput(`Name and value together are larger than ${COOKIE_LIMITS.maxBytes} bytes`)
    const fields: CookieFields = {
      name,
      value,
      domain,
      hostOnly: input.hostOnly,
      path,
      expiresAt: input.expiresAt,
      secure: input.secure,
      httpOnly: input.httpOnly,
      sameSite: input.sameSite,
    }
    return toJarCookie(this.put(ws.id, fields, previous?.id))
  }

  delete(cookieId: string): void {
    this.db.prepare('DELETE FROM cookies WHERE id = ?').run(assertUuid(cookieId, 'cookieId'))
  }

  clear(workspaceId: string, domain: string | null): number {
    const ws = requireWorkspace(this.db, workspaceId)
    if (domain === null) return this.db.prepare('DELETE FROM cookies WHERE workspace_id = ?').run(ws.id).changes
    const d = normalizeCookieDomain(domain) ?? domain.trim().toLowerCase()
    return this.db.prepare('DELETE FROM cookies WHERE workspace_id = ? AND domain = ?').run(ws.id, d).changes
  }

  scriptDomains(workspaceId: string): string[] {
    const ws = requireWorkspace(this.db, workspaceId)
    const row = this.db.prepare('SELECT script_domains FROM cookie_settings WHERE workspace_id = ?').get(ws.id) as { script_domains: string } | undefined
    try {
      const list: unknown = JSON.parse(row?.script_domains ?? '[]')
      return Array.isArray(list) ? list.filter((d): d is string => typeof d === 'string') : []
    } catch {
      return []
    }
  }

  setScriptDomains(workspaceId: string, domains: string[]): string[] {
    const ws = requireWorkspace(this.db, workspaceId)
    const clean: string[] = []
    for (const d of domains) {
      if (!d.trim()) continue
      const n = normalizeCookieDomain(d)
      if (!n) throw invalidInput(`"${d.trim()}" is not a domain`)
      if (isPublicSuffix(n)) throw invalidInput(`"${n}" is a public suffix; allow a domain under it instead`)
      if (!clean.includes(n)) clean.push(n)
    }
    if (clean.length > MAX_SCRIPT_DOMAINS) throw invalidInput(`At most ${MAX_SCRIPT_DOMAINS} domains`)
    this.db
      .prepare('INSERT INTO cookie_settings (workspace_id, script_domains) VALUES (?, ?) ON CONFLICT (workspace_id) DO UPDATE SET script_domains = excluded.script_domains')
      .run(ws.id, JSON.stringify(clean))
    return clean
  }

  // ---- MCP output -------------------------------------------------------------------

  /**
   * Replaces the values of the workspace's jar in `texts` with `[hidden]` (and their URL-encoded forms), except the
   * values the response set itself (`responseSetCookies`, raw Set-Cookie values: the assistant sees those in its headers).
   * Values shorter than 4 characters are left alone (like the other redactions; they would hide unrelated text).
   */
  redact(workspaceId: string, texts: string[], responseSetCookies: string[]): string[] {
    const keep = new Set<string>()
    for (const h of responseSetCookies) {
      const pair = h.split(';')[0] ?? ''
      const i = pair.indexOf('=')
      if (i >= 0) keep.add(pair.slice(i + 1).trim())
    }
    const values = new Set<string>()
    for (const r of this.rowsOf(assertUuid(workspaceId, 'workspaceId'))) {
      let v: string
      try {
        v = this.decrypt(r)
      } catch {
        continue
      }
      if (v.length >= 4 && !keep.has(v)) values.add(v)
    }
    if (values.size === 0) return texts
    const list = [...values].sort((a, b) => b.length - a.length)
    return texts.map((t) => {
      let out = t
      for (const v of list) {
        if (out.includes(v)) out = out.split(v).join('[hidden]')
        const enc = encodeURIComponent(v)
        if (enc !== v && out.includes(enc)) out = out.split(enc).join('[hidden]')
      }
      return out
    })
  }

  // ---- pm.cookies.jar() -----------------------------------------------------------------

  /**
   * One pm.cookies.jar() call of a script in `workspaceId`. Only URLs whose host is on the workspace's allow-list
   * (Cookies dialog > Domains scripts may access; empty = none) are served. Never rejects.
   */
  async scriptOp(workspaceId: string, call: CookieJarCall): Promise<CookieJarOutcome> {
    try {
      return { ok: true, value: this.runScriptOp(workspaceId, call) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  private runScriptOp(workspaceId: string, call: CookieJarCall): unknown {
    let url: URL
    try {
      url = new URL(call.url)
    } catch {
      throw new Error(`pm.cookies.jar(): "${call.url}" is not a valid URL`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('pm.cookies.jar(): only http and https URLs')
    const host = url.hostname.toLowerCase()
    if (!scriptDomainAllowed(host, this.scriptDomains(workspaceId))) {
      throw new Error(
        `pm.cookies.jar(): scripts may not access the cookies of ${host}. Add the domain under "Domains scripts may access" in the Cookies dialog (Ctrl+K, Cookies).`,
      )
    }
    const now = this.now()
    switch (call.op) {
      case 'get': {
        const r = this.matching(workspaceId, url).find((c) => c.name === call.name)
        return r ? this.decrypt(r) : null
      }
      case 'getAll':
        return this.matching(workspaceId, url).map((r) => this.scriptCookie(r))
      case 'set': {
        const c = call.cookie
        const parts = [`${c.name}=${c.value}`]
        if (c.domain) parts.push(`Domain=${c.domain}`)
        parts.push(`Path=${c.path || '/'}`)
        if (typeof c.expires === 'number') parts.push(`Max-Age=${Math.max(0, c.expires - now)}`)
        if (c.secure) parts.push('Secure')
        if (c.httpOnly) parts.push('HttpOnly')
        if (c.sameSite) parts.push(`SameSite=${c.sameSite}`)
        if (!c.name.trim() || BAD_NAME.test(c.name.trim())) throw new Error('pm.cookies.jar().set: the cookie name is empty or contains characters not allowed in cookies')
        if (BAD_VALUE.test(c.value)) throw new Error('pm.cookies.jar().set: the cookie value contains ";" or control characters')
        const parsed = parseSetCookie(parts.join('; '), url, now)
        if (!parsed.ok) throw new Error(`pm.cookies.jar().set: the cookie was refused: ${parsed.reason}`)
        if (!parsed.cookie.hostOnly && !scriptDomainAllowed(parsed.cookie.domain, this.scriptDomains(workspaceId))) {
          throw new Error(`pm.cookies.jar().set: scripts may not set cookies for all of ${parsed.cookie.domain}`)
        }
        if (parsed.expired) {
          this.deleteByKey(workspaceId, parsed.cookie)
          return null
        }
        return this.scriptCookie(this.put(workspaceId, parsed.cookie))
      }
      case 'unset': {
        for (const r of this.matching(workspaceId, url)) if (r.name === call.name) this.db.prepare('DELETE FROM cookies WHERE id = ?').run(r.id)
        return null
      }
      case 'clear': {
        // Every cookie the URL's host receives, whatever its path; a parent domain's cookies only when that domain is
        // allowed too.
        const allowed = this.scriptDomains(workspaceId)
        const rows = this.rowsOf(workspaceId).filter(
          (r) => (r.host_only === 1 ? r.domain === host : domainMatch(host, r.domain)) && scriptDomainAllowed(r.domain, allowed),
        )
        for (const r of rows) this.db.prepare('DELETE FROM cookies WHERE id = ?').run(r.id)
        return null
      }
      default:
        throw new Error('pm.cookies.jar(): unknown operation')
    }
  }

  private scriptCookie(r: CookieRow): ScriptCookie {
    return {
      name: r.name,
      value: this.decrypt(r),
      domain: r.domain,
      path: r.path,
      expires: r.expires_at === null ? null : new Date(r.expires_at * 1000).toISOString(),
      hostOnly: r.host_only === 1,
      session: r.expires_at === null,
      secure: r.secure === 1,
      httpOnly: r.http_only === 1,
      sameSite: r.same_site,
    }
  }
}
