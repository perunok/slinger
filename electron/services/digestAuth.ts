/**
 * HTTP Digest access authentication, client side (RFC 7616, compatible with RFC 2617 servers).
 *
 * The executor sends the request, and when the answer is `401` with a `WWW-Authenticate: Digest ...` challenge it computes
 * the `Authorization` header here and sends the same hop once more (httpExecutor.ts). Supported: algorithms MD5, MD5-sess,
 * SHA-256, SHA-256-sess, SHA-512-256, SHA-512-256-sess (also what Postman supports); qop `auth` and `auth-int` (the hash of
 * the body bytes actually sent) or no qop (RFC 2069); `opaque`; `userhash`; `username*` for a non-ASCII user name; `stale`.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { DigestAuthInput } from '../../shared/types'

/** Algorithm name (upper case, `-sess` included) -> node:crypto hash. */
const HASHES: Record<string, string> = {
  MD5: 'md5',
  'MD5-SESS': 'md5',
  'SHA-256': 'sha256',
  'SHA-256-SESS': 'sha256',
  'SHA-512-256': 'sha512-256',
  'SHA-512-256-SESS': 'sha512-256',
}

/** True for an algorithm this client implements ('' = MD5). */
export const isSupportedDigestAlgorithm = (algorithm: string | undefined): boolean => Object.hasOwn(HASHES, normalizeAlgorithm(algorithm))

/** The canonical spelling of an algorithm name ('' = MD5): `MD5`, `MD5-sess`, `SHA-256`, ... */
export function normalizeAlgorithm(algorithm: string | undefined): string {
  const a = (algorithm ?? '').trim().toUpperCase()
  return a === '' ? 'MD5' : a
}

const displayAlgorithm = (a: string) => a.replace(/-SESS$/, '-sess')

export interface DigestChallenge {
  realm: string
  nonce: string
  /** The qop options the server offers (lower case); empty: RFC 2069 (no qop). */
  qop: string[]
  /** Canonical upper-case name ('MD5' when the challenge names none). */
  algorithm: string
  opaque?: string
  stale: boolean
  userhash: boolean
}

/** One challenge of a WWW-Authenticate value: its scheme and parameters (names lower case). */
interface RawChallenge {
  scheme: string
  params: Record<string, string>
}

/**
 * Splits WWW-Authenticate values into challenges (RFC 9110 section 11.6.1: `scheme param=value, param="quoted", scheme2 ...`).
 * Tolerant: a token68 (`Bearer abc==`) is skipped, malformed parts end the parse of that value.
 */
export function parseAuthenticate(values: string | readonly string[]): RawChallenge[] {
  const out: RawChallenge[] = []
  for (const value of typeof values === 'string' ? [values] : values) {
    let i = 0
    let current: RawChallenge | null = null
    const n = value.length
    const skip = (re: RegExp) => {
      while (i < n && re.test(value[i]!)) i++
    }
    const token = () => {
      const start = i
      while (i < n && /[!#$%&'*+.^_`|~0-9A-Za-z-]/.test(value[i]!)) i++
      return value.slice(start, i)
    }
    while (i < n) {
      skip(/[\s,]/)
      if (i >= n) break
      const name = token()
      if (!name) break
      skip(/\s/)
      if (value[i] === '=' && current) {
        i++
        skip(/\s/)
        let v = ''
        if (value[i] === '"') {
          i++
          while (i < n && value[i] !== '"') {
            if (value[i] === '\\' && i + 1 < n) i++
            v += value[i]
            i++
          }
          i++
        } else {
          const start = i
          while (i < n && value[i] !== ',' && !/\s/.test(value[i]!)) i++
          v = value.slice(start, i)
        }
        current.params[name.toLowerCase()] = v
      } else if (value[i] === '=') {
        // token68 or a parameter without a scheme: skip to the next comma
        while (i < n && value[i] !== ',') i++
      } else {
        current = { scheme: name.toLowerCase(), params: {} }
        out.push(current)
        // A token68 credential right after the scheme (`Bearer abc==`): not a parameter list.
        const rest = /^\s*[A-Za-z0-9\-._~+/]+=*\s*(?=,|$)/.exec(value.slice(i))
        if (rest) i += rest[0].length
      }
    }
  }
  return out
}

/** The first Digest challenge with an algorithm this client supports, or null (no usable Digest challenge). */
export function parseDigestChallenge(values: string | readonly string[] | null | undefined): DigestChallenge | null {
  if (!values || values.length === 0) return null
  for (const c of parseAuthenticate(values)) {
    if (c.scheme !== 'digest') continue
    const p = c.params
    if (p.nonce === undefined) continue
    const algorithm = normalizeAlgorithm(p.algorithm)
    if (!isSupportedDigestAlgorithm(algorithm)) continue
    return {
      realm: p.realm ?? '',
      nonce: p.nonce,
      qop: (p.qop ?? '')
        .split(',')
        .map((q) => q.trim().toLowerCase())
        .filter(Boolean),
      algorithm,
      ...(p.opaque !== undefined ? { opaque: p.opaque } : {}),
      stale: (p.stale ?? '').toLowerCase() === 'true',
      userhash: (p.userhash ?? '').toLowerCase() === 'true',
    }
  }
  return null
}

const hash = (algo: string, data: string | Buffer) => createHash(algo).update(data).digest('hex')

/** A quoted-string (RFC 9110): `"` and `\` escaped. */
const quoted = (s: string) => `"${s.replace(/["\\]/g, (c) => `\\${c}`)}"`

export interface DigestResponseInput {
  username: string
  password: string
  realm: string
  nonce: string
  algorithm: string
  /** The qop to use ('' = none, RFC 2069). */
  qop: '' | 'auth' | 'auth-int'
  opaque?: string
  userhash?: boolean
  method: string
  /** The request-target: path and query of the hop's URL. */
  uri: string
  /** The body bytes actually sent (auth-int). */
  body?: Buffer
  /** Nonce count (1 for the first use of a nonce). */
  nc: number
  cnonce: string
}

/** The `Authorization` header value for one request. */
export function digestAuthorization(i: DigestResponseInput): string {
  const algorithm = normalizeAlgorithm(i.algorithm)
  const h = HASHES[algorithm]
  if (!h) throw new Error(`Unsupported Digest algorithm "${i.algorithm}"`)
  const nc = i.nc.toString(16).padStart(8, '0')
  let ha1 = hash(h, `${i.username}:${i.realm}:${i.password}`)
  if (algorithm.endsWith('-SESS')) ha1 = hash(h, `${ha1}:${i.nonce}:${i.cnonce}`)
  const ha2 = i.qop === 'auth-int' ? hash(h, `${i.method}:${i.uri}:${hash(h, i.body ?? Buffer.alloc(0))}`) : hash(h, `${i.method}:${i.uri}`)
  const response = i.qop ? hash(h, `${ha1}:${i.nonce}:${nc}:${i.cnonce}:${i.qop}:${ha2}`) : hash(h, `${ha1}:${i.nonce}:${ha2}`)

  const parts: string[] = []
  if (i.userhash) parts.push(`username=${quoted(hash(h, `${i.username}:${i.realm}`))}`)
  // eslint-disable-next-line no-control-regex
  else if (/[^\x20-\x7e]/.test(i.username)) parts.push(`username*=UTF-8''${encodeURIComponent(i.username)}`)
  else parts.push(`username=${quoted(i.username)}`)
  parts.push(`realm=${quoted(i.realm)}`, `nonce=${quoted(i.nonce)}`, `uri=${quoted(i.uri)}`, `algorithm=${displayAlgorithm(algorithm)}`)
  if (i.qop) parts.push(`qop=${i.qop}`, `nc=${nc}`, `cnonce=${quoted(i.cnonce)}`)
  parts.push(`response=${quoted(response)}`)
  if (i.opaque !== undefined && i.opaque !== '') parts.push(`opaque=${quoted(i.opaque)}`)
  if (i.userhash) parts.push('userhash=true')
  return `Digest ${parts.join(', ')}`
}

export const newCnonce = () => randomBytes(16).toString('hex')

/** The qop to answer with: the one the user set when offered, else `auth`, else `auth-int`, else none. */
function chooseQop(offered: string[], preferred: string | undefined): DigestResponseInput['qop'] {
  const want = (preferred ?? '').trim().toLowerCase()
  if ((want === 'auth' || want === 'auth-int') && offered.includes(want)) return want
  if (offered.includes('auth')) return 'auth'
  if (offered.includes('auth-int')) return 'auth-int'
  return ''
}

/**
 * The Digest state of one send: which challenge applies, nonce counts, how many answers were tried. The executor calls
 * `header` before each hop and `onUnauthorized` on a 401; the answer depends only on the hop's method, URI and body.
 */
export class DigestSession {
  private challenge: DigestChallenge | null = null
  private qop: DigestResponseInput['qop'] = ''
  private cnonce = ''
  private nc = 0
  /** Answers sent for the current hop (a stale nonce allows one more). */
  private answers = 0
  private staleRetried = false
  /** What the response view says (null: Digest was not used). */
  note: string | null = null

  constructor(private readonly auth: DigestAuthInput) {
    // Realm and nonce given up front (Postman stores the last challenge's values): the first request carries the header.
    if (auth.realm && auth.nonce) {
      const algorithm = normalizeAlgorithm(auth.algorithm)
      if (!isSupportedDigestAlgorithm(algorithm)) throw new Error(`Unsupported Digest algorithm "${auth.algorithm}"`)
      const qop = (auth.qop ?? '').trim().toLowerCase()
      this.challenge = {
        realm: auth.realm,
        nonce: auth.nonce,
        qop: qop ? qop.split(',').map((q) => q.trim()) : [],
        algorithm,
        ...(auth.opaque ? { opaque: auth.opaque } : {}),
        stale: false,
        userhash: false,
      }
      this.qop = chooseQop(this.challenge.qop, auth.qop)
      this.cnonce = auth.clientNonce?.trim() || newCnonce()
      const nc = Number.parseInt(auth.nonceCount?.trim() || '1', 16)
      this.nc = Number.isFinite(nc) && nc > 0 ? nc - 1 : 0
      this.note = `Digest (${displayAlgorithm(algorithm)}${this.qop ? `, qop=${this.qop}` : ''}): sent with the realm and nonce from the Authorization tab`
    }
  }

  /** A new hop (redirect): its own answer count. */
  nextHop(): void {
    this.answers = 0
    this.staleRetried = false
  }

  /** The Authorization header for this hop, or null before any challenge is known. */
  header(method: string, url: URL, body: Buffer | undefined): string | null {
    const c = this.challenge
    if (!c) return null
    this.nc++
    return digestAuthorization({
      username: this.auth.username,
      password: this.auth.password,
      realm: c.realm,
      nonce: c.nonce,
      algorithm: c.algorithm,
      qop: this.qop,
      opaque: c.opaque,
      userhash: c.userhash,
      method,
      uri: `${url.pathname}${url.search}`,
      body,
      nc: this.nc,
      cnonce: this.cnonce,
    })
  }

  /**
   * A 401 arrived for the current hop: true when it should be sent again with an answer to its challenge. Once per hop,
   * plus once more when the server says the nonce was stale; never with `disableRetryRequest`.
   */
  onUnauthorized(wwwAuthenticate: string[]): boolean {
    if (this.auth.disableRetryRequest) return false
    const c = parseDigestChallenge(wwwAuthenticate)
    if (!c) return false
    if (this.answers > 0) {
      if (!c.stale || this.staleRetried) return false
      this.staleRetried = true
    }
    this.answers++
    if (!this.challenge || this.challenge.nonce !== c.nonce) {
      this.nc = 0
      this.cnonce = newCnonce()
    }
    this.challenge = c
    this.qop = chooseQop(c.qop, this.auth.qop)
    this.note = `Digest (${displayAlgorithm(c.algorithm)}${this.qop ? `, qop=${this.qop}` : ''}): answered the server's challenge${c.stale ? ' (the nonce had expired)' : ''}`
    return true
  }
}
