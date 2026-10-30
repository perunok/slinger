/**
 * How a request reaches its server: the undici dispatcher (connection pool) for a URL under the network settings
 * (Settings > Network, services/networkSettings.ts) and the request's own SSL setting. Dispatchers are cached by what
 * makes them differ (proxy, certificate verification, client certificate), so connections are reused across sends, and
 * all of them are closed when the settings change.
 *
 * Proxy choice, per hop:
 * - loopback hosts (localhost, *.localhost, 127.0.0.0/8, ::1) always connect directly: mock servers, the OAuth 2.0
 *   redirect listener and local development servers are never proxied;
 * - 'none': direct; 'custom': the configured proxy unless the host matches the bypass list;
 * - 'system': in the app, Electron's `session.resolveProxy` (the OS / desktop proxy settings, PAC scripts included; first
 *   `PROXY` / `HTTPS` entry, `DIRECT` = none; SOCKS entries are skipped since undici has no SOCKS support); without a
 *   resolver (tests, plain Node) the HTTPS_PROXY / HTTP_PROXY / NO_PROXY environment variables.
 * Plain-http requests go to an http proxy as absolute-URI requests; https requests are tunnelled with CONNECT.
 */
import { readFile } from 'node:fs/promises'
import { rootCertificates, type ConnectionOptions } from 'node:tls'
import { Agent, fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici'
import type { ProxyMode } from '../../shared/types'
import { invalidInput, networkError, type IpcError } from '../lib/errors'

export interface NetworkRoute {
  dispatcher: Dispatcher
  /** The proxy this route goes through (`host:port`, no credentials), for error messages; null = direct. */
  proxy: string | null
}

export interface NetworkRouter {
  /** The dispatcher for a request to `url`. `strictSSL`: the request's own setting (absent: the app setting). */
  route(url: URL, opts?: { strictSSL?: boolean }): Promise<NetworkRoute>
}

export interface ClientCertConfig {
  id: string
  host: string
  port: number | null
  crtPath: string | null
  keyPath: string | null
  pfxPath: string | null
  /** Read from the keychain when the certificate is first used. */
  passphrase(): string | null
}

export interface NetworkConfig {
  verifySsl: boolean
  /** Extra trusted CA certificates (PEM text). */
  caPems: string[]
  clientCerts: ClientCertConfig[]
  proxy: {
    mode: ProxyMode
    url: string
    username: string
    /** Read from the keychain when the proxy is first used. */
    password(): string | null
    bypass: string[]
  }
}

export const DIRECT_CONFIG: NetworkConfig = {
  verifySsl: true,
  caPems: [],
  clientCerts: [],
  proxy: { mode: 'none', url: '', username: '', password: () => null, bypass: [] },
}

/** `resolveProxy`'s answer for a URL, e.g. "PROXY proxy:3128; DIRECT". */
export type SystemProxyResolver = (url: string) => Promise<string>

export interface NetworkDispatchersOptions {
  /** The current settings (called once per settings generation). */
  load(): NetworkConfig
  /** The system proxy for a URL (Electron's session.resolveProxy); absent: environment variables. */
  resolveSystemProxy?: SystemProxyResolver
  env?: Record<string, string | undefined>
}

const MAX_CACHED = 32

/** True for hosts that are this computer: never proxied. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || h === '0:0:0:0:0:0:0:1'
}

/** The URL's port, or the scheme's default. */
const portOf = (url: URL): number => (url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80)

/**
 * True when a bypass / NO_PROXY list covers the URL. Entries: `*` (everything), `host`, `.domain` or `*.domain` (the domain
 * and its subdomains), each optionally with `:port`; separated by commas, semicolons or whitespace.
 */
export function bypassMatches(url: URL, entries: readonly string[]): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const port = portOf(url)
  for (const raw of entries.flatMap((e) => e.split(/[\s,;]+/))) {
    let entry = raw.trim().toLowerCase()
    if (!entry) continue
    if (entry === '*') return true
    let entryPort: number | null = null
    const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry)
    if (bracketed) {
      entry = bracketed[1]!
      entryPort = bracketed[2] ? Number(bracketed[2]) : null
    } else if (entry.split(':').length === 2) {
      const [h, p] = entry.split(':')
      if (!/^\d+$/.test(p!)) continue
      entry = h!
      entryPort = Number(p)
    }
    if (entryPort !== null && entryPort !== port) continue
    if (entry.startsWith('*.')) entry = entry.slice(1)
    if (entry.startsWith('.')) {
      if (host === entry.slice(1) || host.endsWith(entry)) return true
    } else if (host === entry) return true
  }
  return false
}

/** The first usable proxy of a PAC-style answer ("PROXY a:1; HTTPS b:2; DIRECT"), or null for direct. */
export function parsePacResult(result: string): string | null {
  for (const part of result.split(';')) {
    const [kind, target] = part.trim().split(/\s+/)
    if (!kind) continue
    const k = kind.toUpperCase()
    if (k === 'DIRECT') return null
    if ((k === 'PROXY' || k === 'HTTP') && target) return `http://${target}`
    if (k === 'HTTPS' && target) return `https://${target}`
    // SOCKS / SOCKS4 / SOCKS5: not supported by the HTTP engine, try the next entry.
  }
  return null
}

/** The proxy from HTTPS_PROXY / HTTP_PROXY / NO_PROXY (either case) for a URL, or null. */
export function envProxyFor(url: URL, env: Record<string, string | undefined>): string | null {
  const get = (name: string) => env[name.toLowerCase()]?.trim() || env[name]?.trim() || ''
  const noProxy = get('NO_PROXY')
  if (noProxy && bypassMatches(url, [noProxy])) return null
  const proxy = url.protocol === 'https:' ? get('HTTPS_PROXY') || get('HTTP_PROXY') : get('HTTP_PROXY')
  if (!proxy) return null
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(proxy) ? proxy : `http://${proxy}`
}

/** The client certificate configured for a URL's host and port (exact host first, then the longest wildcard). */
export function matchClientCert<T extends { host: string; port: number | null }>(certs: readonly T[], url: URL): T | null {
  if (url.protocol !== 'https:') return null
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const port = portOf(url)
  let best: T | null = null
  let bestScore = -1
  for (const c of certs) {
    if (c.port !== null && c.port !== port) continue
    const h = c.host.trim().toLowerCase()
    let score = -1
    if (h === host) score = 1000 + (c.port !== null ? 1 : 0)
    else if (h.startsWith('*.') && host.endsWith(h.slice(1))) score = h.length + (c.port !== null ? 1 : 0)
    if (score > bestScore) {
      best = c
      bestScore = score
    }
  }
  return best
}

/** `host:port` of a proxy URL, without credentials. */
export function proxyLabel(proxyUrl: string): string {
  try {
    const u = new URL(proxyUrl)
    return `${u.hostname}:${u.port || (u.protocol === 'https:' ? 443 : 80)}`
  } catch {
    return 'the proxy'
  }
}

async function readCertFile(path: string, what: string, host: string): Promise<Buffer> {
  try {
    return await readFile(path)
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'the file does not exist' : err instanceof Error ? err.message : String(err)
    throw invalidInput(`Client certificate for ${host}: could not read the ${what} file "${path}" (${reason}). Fix it in Settings > Network.`, {
      reason: 'client_certificate_file',
    })
  }
}

async function clientCertTls(cert: ClientCertConfig): Promise<ConnectionOptions> {
  const passphrase = cert.passphrase() ?? undefined
  if (cert.pfxPath) return { pfx: await readCertFile(cert.pfxPath, 'PFX', cert.host), passphrase }
  if (cert.crtPath && cert.keyPath) {
    const [crt, key] = await Promise.all([readCertFile(cert.crtPath, 'certificate', cert.host), readCertFile(cert.keyPath, 'key', cert.host)])
    return { cert: crt, key, passphrase }
  }
  return {}
}

/** Builds and caches dispatchers for the current settings. */
export class NetworkDispatchers implements NetworkRouter {
  private config: NetworkConfig | null = null
  private readonly cache = new Map<string, Promise<Dispatcher>>()

  constructor(private readonly options: NetworkDispatchersOptions) {}

  /** Forgets the settings and closes every pooled connection (in-flight requests finish). Call after a settings change. */
  invalidate(): void {
    this.config = null
    for (const d of this.cache.values()) void d.then((x) => x.close()).catch(() => {})
    this.cache.clear()
  }

  /** Closes everything (app quit). */
  async close(): Promise<void> {
    const all = [...this.cache.values()]
    this.cache.clear()
    await Promise.all(all.map((d) => d.then((x) => x.close()).catch(() => {})))
  }

  private current(): NetworkConfig {
    this.config ??= this.options.load()
    return this.config
  }

  /** The proxy URL (with credentials) for a request to `url`, or null for a direct connection. */
  async proxyFor(url: URL, config = this.current()): Promise<string | null> {
    if (isLoopbackHost(url.hostname)) return null
    const p = config.proxy
    if (p.mode === 'none') return null
    if (p.mode === 'custom') {
      if (!p.url.trim() || bypassMatches(url, p.bypass)) return null
      if (!p.username) return p.url
      const u = new URL(p.url)
      u.username = encodeURIComponent(p.username)
      u.password = encodeURIComponent(p.password() ?? '')
      return u.toString()
    }
    if (this.options.resolveSystemProxy) {
      try {
        return parsePacResult(await this.options.resolveSystemProxy(url.toString()))
      } catch {
        return null
      }
    }
    return envProxyFor(url, this.options.env ?? process.env)
  }

  async route(url: URL, opts: { strictSSL?: boolean } = {}): Promise<NetworkRoute> {
    const config = this.current()
    const verify = opts.strictSSL ?? config.verifySsl
    const proxy = await this.proxyFor(url, config)
    const cert = matchClientCert(config.clientCerts, url)
    const key = `${proxy ?? 'direct'}\u0000${verify ? 1 : 0}\u0000${cert?.id ?? ''}`
    let dispatcher = this.cache.get(key)
    if (!dispatcher) {
      dispatcher = this.build(config, proxy, verify, cert)
      this.cache.set(key, dispatcher)
      // A failed build (unreadable certificate file) is not cached: the next send tries again.
      dispatcher.catch(() => this.cache.get(key) === dispatcher && this.cache.delete(key))
      if (this.cache.size > MAX_CACHED) {
        const [oldestKey, oldest] = this.cache.entries().next().value as [string, Promise<Dispatcher>]
        this.cache.delete(oldestKey)
        void oldest.then((x) => x.close()).catch(() => {})
      }
    }
    return { dispatcher: await dispatcher, proxy: proxy ? proxyLabel(proxy) : null }
  }

  private async build(config: NetworkConfig, proxy: string | null, verify: boolean, cert: ClientCertConfig | null): Promise<Dispatcher> {
    const ca = config.caPems.length ? [...rootCertificates, ...config.caPems] : undefined
    const tls: ConnectionOptions = { rejectUnauthorized: verify, ...(ca ? { ca } : {}), ...(cert ? await clientCertTls(cert) : {}) }
    if (!proxy) return new Agent({ connect: tls })
    const u = new URL(proxy)
    const username = decodeURIComponent(u.username)
    const password = decodeURIComponent(u.password)
    u.username = ''
    u.password = ''
    return new ProxyAgent({
      uri: u.toString(),
      token: username || password ? `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}` : undefined,
      requestTls: tls,
      proxyTls: { rejectUnauthorized: config.verifySsl, ...(ca ? { ca } : {}) },
      // Plain-http requests through an http proxy are sent to it directly (absolute URI), not through a CONNECT tunnel
      // (many proxies only allow CONNECT to port 443).
      proxyTunnel: false,
    })
  }
}

/** Requests the executor sends without network settings (internal cloud calls, tests): direct, verified unless the request says otherwise. */
export const DIRECT_ROUTER = new NetworkDispatchers({ load: () => DIRECT_CONFIG })

// ---- errors -------------------------------------------------------------------------------------------------------------

const TLS_HINT = 'Turn off SSL certificate verification for this request (Settings tab) or add the CA certificate in Settings > Network.'

const TLS_REASONS: Record<string, string> = {
  DEPTH_ZERO_SELF_SIGNED_CERT: "the server's certificate is self-signed",
  SELF_SIGNED_CERT_IN_CHAIN: "the server's certificate chain ends in a self-signed certificate that is not trusted",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "the server's certificate is signed by a certificate authority that is not trusted",
  UNABLE_TO_GET_ISSUER_CERT: "the server's certificate is signed by a certificate authority that is not trusted",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "the server's certificate is signed by a certificate authority that is not trusted",
  CERT_UNTRUSTED: "the server's certificate is not trusted",
  CERT_HAS_EXPIRED: "the server's certificate has expired",
  CERT_NOT_YET_VALID: "the server's certificate is not valid yet",
  ERR_TLS_CERT_ALTNAME_INVALID: "the server's certificate is not valid for this host name",
  CERT_SIGNATURE_FAILURE: "the server's certificate signature is invalid",
  CERT_REVOKED: "the server's certificate has been revoked",
}

const PROXY_CONNECT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT'])

/** The innermost error of a fetch failure ("fetch failed" -> its cause chain). */
function rootCause(err: unknown): Error & { code?: string } {
  let e = err as Error & { code?: string; cause?: unknown }
  for (let i = 0; i < 5 && e && e.cause instanceof Error; i++) e = e.cause as Error & { code?: string; cause?: unknown }
  return e instanceof Error ? e : new Error(String(err))
}

/**
 * A user-facing network_error for a failed send: TLS problems name the problem and the settings that fix it, proxy failures
 * say so; anything else keeps the platform's message.
 */
export function describeSendError(err: unknown, route: NetworkRoute | null, url?: URL): IpcError {
  const cause = rootCause(err)
  const code = typeof cause.code === 'string' ? cause.code : ''
  const message = cause.message || String(err)
  const reason = TLS_REASONS[code]
  if (reason) return networkError(`SSL error: ${reason} (${code}). ${TLS_HINT}`, { tls: code })
  if (/certificate required|alert bad certificate|alert unknown ca|peer did not return a certificate/i.test(message)) {
    return networkError(
      `SSL error: the server requires a client certificate and did not accept the one sent (or none was sent). Add a client certificate for this host in Settings > Network. (${message})`,
      { tls: code || 'client_certificate' },
    )
  }
  if (/bad decrypt|mac verify failure|bad password read|unsupported pkcs12|wrong tag|no start line/i.test(message)) {
    return networkError(
      `SSL error: the client certificate for this host could not be used (wrong passphrase or not a certificate/key file). Check it in Settings > Network. (${message})`,
      { tls: 'client_certificate' },
    )
  }
  if (route?.proxy) {
    const status = /Proxy response \((\d+)\)|Proxy Authentication Required \((\d+)\)/.exec(message)?.slice(1).find(Boolean)
    if (status) {
      const auth = status === '407' ? ': check the proxy username and password' : ''
      return networkError(`The proxy ${route.proxy} refused the connection (HTTP ${status})${auth}. Check the proxy in Settings > Network.`, {
        proxy: route.proxy,
        proxyStatus: Number(status),
      })
    }
    if (PROXY_CONNECT_CODES.has(code) || /proxy/i.test(cause.name)) {
      return networkError(`Could not connect to the proxy ${route.proxy}: ${message}. Check the proxy in Settings > Network.`, { proxy: route.proxy })
    }
  }
  if (code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_') || /^CERT_|_CERT/.test(code)) {
    return networkError(`SSL error: ${message} (${code}). ${TLS_HINT}`, { tls: code })
  }
  // A server that requires a client certificate often just closes the connection after the TLS handshake (TLS 1.3).
  if (url?.protocol === 'https:' && (code === 'UND_ERR_SOCKET' || code === 'ECONNRESET')) {
    return networkError(`${message} (if this server requires a client certificate, add one for this host in Settings > Network)`)
  }
  return networkError(message)
}

/**
 * A `fetch` that goes through the network settings (for callers written against fetch, such as the OpenAPI URL import).
 * Redirects are followed by undici on the first URL's route. Failures keep fetch's shape (a rejected Error) with the
 * same messages as a send (SSL / proxy explanations); timeouts and aborts are rethrown as they are.
 */
export function networkFetch(router: NetworkRouter): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    let route: NetworkRoute | null = null
    try {
      route = await router.route(url)
      return (await undiciFetch(url, { ...(init as object), dispatcher: route.dispatcher })) as unknown as Response
    } catch (err) {
      const name = (err as Error)?.name
      if (name === 'AbortError' || name === 'TimeoutError') throw err
      throw new Error(describeSendError(err, route).message)
    }
  }) as typeof fetch
}
