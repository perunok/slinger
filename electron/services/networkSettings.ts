/**
 * Settings > Network: SSL certificate verification, extra CA certificates, client certificates per host and the proxy.
 * App-wide and local only (never synced, exported or versioned). Non-secret parts are in SQLite (`app_settings` and the
 * 0020 tables); the proxy password and client-certificate passphrases only in the OS keychain (`slinger:network:` keys),
 * and are never returned (`hasPassword` / `hasPassphrase`).
 *
 * The service is also the app's NetworkRouter: every user send, collection run, workflow, MCP send, pm.sendRequest,
 * OAuth 2.0 token request and OpenAPI URL import gets its dispatcher here (services/network.ts).
 */
import { X509Certificate } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type { Dispatcher } from 'undici'
import type {
  NetworkCaCertificate,
  NetworkClientCertificate,
  NetworkClientCertificateInput,
  NetworkProxySettings,
  NetworkSettings,
  NetworkSettingsUpdate,
  ProxyMode,
} from '../../shared/types'
import type { Db } from '../db/database'
import { invalidInput, notFound } from '../lib/errors'
import { newId } from '../lib/ids'
import { nowSeconds } from '../lib/text'
import { deleteSetting, getSetting, setSetting } from '../sync/store'
import type { FileAccess } from './fileGrants'
import { NetworkDispatchers, type NetworkConfig, type NetworkRoute, type NetworkRouter, type SystemProxyResolver } from './network'
import type { SecretStore } from './secrets'

/** Keychain keys of this service (reserved: nothing else reads or writes them). */
export const NETWORK_SECRET_PREFIX = 'slinger:network:'
export const PROXY_PASSWORD_KEY = `${NETWORK_SECRET_PREFIX}proxy-password`
export const clientCertPassphraseKey = (id: string) => `${NETWORK_SECRET_PREFIX}client-cert:${id}`

const VERIFY_KEY = 'network.verifySsl'
const PROXY_KEY = 'network.proxy'
const MAX_CERT_FILE_BYTES = 1024 * 1024
const MAX_CA_CERTS = 200
const MAX_CLIENT_CERTS = 200
const PEM_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g
const HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i
const IPV6_RE = /^[0-9a-f:.]+$/i

interface StoredProxy {
  mode: ProxyMode
  url: string
  username: string
  bypass: string[]
}
const DEFAULT_PROXY: StoredProxy = { mode: 'system', url: '', username: '', bypass: [] }

interface CaRow {
  id: string
  name: string
  subject: string
  pem: string
  expires_at: number
  added_at: number
}
interface ClientRow {
  id: string
  host: string
  port: number | null
  crt_path: string | null
  key_path: string | null
  pfx_path: string | null
  has_passphrase: number
}

export interface NetworkSettingsDeps {
  db: Db
  secrets: SecretStore
  /** Files the user picked in this session (certificate files must be chosen in a dialog). */
  files: FileAccess
  /** The system proxy for a URL (Electron's session.resolveProxy); absent: HTTP(S)_PROXY / NO_PROXY. */
  resolveSystemProxy?: SystemProxyResolver
  env?: Record<string, string | undefined>
}

/** A proxy URL as stored: http/https, host and optional port, no credentials, path or query. */
export function normalizeProxyUrl(raw: string): string {
  const text = raw.trim()
  if (!text) return ''
  let u: URL
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`)
  } catch {
    throw invalidInput('The proxy URL is not valid (expected http://host:port)')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw invalidInput('The proxy must be an http:// or https:// URL (SOCKS proxies are not supported)')
  if (u.username || u.password) throw invalidInput('Put the proxy username and password in their own fields, not in the URL')
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) throw invalidInput('The proxy URL must be just http://host:port')
  return `${u.protocol}//${u.host}`
}

function certSubject(cert: X509Certificate): string {
  const lines = cert.subject.split('\n')
  const pick = (k: string) => lines.find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1)
  return pick('CN') ?? pick('O') ?? (lines[0] || 'certificate')
}

export class NetworkSettingsService implements NetworkRouter {
  readonly dispatchers: NetworkDispatchers

  constructor(private readonly deps: NetworkSettingsDeps) {
    this.dispatchers = new NetworkDispatchers({ load: () => this.config(), resolveSystemProxy: deps.resolveSystemProxy, env: deps.env })
  }

  route(url: URL, opts?: { strictSSL?: boolean }): Promise<NetworkRoute> {
    return this.dispatchers.route(url, opts)
  }

  /** A dispatcher for `url` with the app settings (for fetch-style callers such as the OpenAPI URL import). */
  async dispatcherFor(url: URL): Promise<Dispatcher> {
    return (await this.route(url)).dispatcher
  }

  // ---- reading ----------------------------------------------------------------------------------------------------------

  private verifySsl(): boolean {
    return getSetting(this.deps.db, VERIFY_KEY) !== '0'
  }

  private storedProxy(): StoredProxy {
    try {
      const v = JSON.parse(getSetting(this.deps.db, PROXY_KEY) ?? 'null') as Partial<StoredProxy> | null
      if (!v || typeof v !== 'object') return { ...DEFAULT_PROXY }
      return {
        mode: v.mode === 'custom' || v.mode === 'none' ? v.mode : 'system',
        url: typeof v.url === 'string' ? v.url : '',
        username: typeof v.username === 'string' ? v.username : '',
        bypass: Array.isArray(v.bypass) ? v.bypass.filter((x): x is string => typeof x === 'string') : [],
      }
    } catch {
      return { ...DEFAULT_PROXY }
    }
  }

  private caRows(): CaRow[] {
    return this.deps.db.prepare('SELECT id, name, subject, pem, expires_at, added_at FROM network_ca_certs ORDER BY added_at, id').all() as CaRow[]
  }

  private clientRows(): ClientRow[] {
    return this.deps.db
      .prepare('SELECT id, host, port, crt_path, key_path, pfx_path, has_passphrase FROM network_client_certs ORDER BY host, port, id')
      .all() as ClientRow[]
  }

  get(): NetworkSettings {
    const proxy = this.storedProxy()
    const proxyOut: NetworkProxySettings = { ...proxy, hasPassword: !!this.readSecret(PROXY_PASSWORD_KEY) }
    return {
      verifySsl: this.verifySsl(),
      caCertificates: this.caRows().map(
        (r): NetworkCaCertificate => ({ id: r.id, name: r.name, subject: r.subject, expiresAt: r.expires_at, addedAt: r.added_at }),
      ),
      clientCertificates: this.clientRows().map(
        (r): NetworkClientCertificate => ({
          id: r.id,
          host: r.host,
          port: r.port,
          crtPath: r.crt_path,
          keyPath: r.key_path,
          pfxPath: r.pfx_path,
          hasPassphrase: r.has_passphrase === 1,
        }),
      ),
      proxy: proxyOut,
    }
  }

  /** The settings as the dispatchers need them; secrets are read from the keychain only when a dispatcher is built. */
  private config(): NetworkConfig {
    const proxy = this.storedProxy()
    return {
      verifySsl: this.verifySsl(),
      caPems: this.caRows().map((r) => r.pem),
      clientCerts: this.clientRows().map((r) => ({
        id: r.id,
        host: r.host,
        port: r.port,
        crtPath: r.crt_path,
        keyPath: r.key_path,
        pfxPath: r.pfx_path,
        passphrase: () => (r.has_passphrase ? this.readSecret(clientCertPassphraseKey(r.id)) : null),
      })),
      proxy: { ...proxy, password: () => (proxy.username ? this.readSecret(PROXY_PASSWORD_KEY) : null) },
    }
  }

  private readSecret(key: string): string | null {
    try {
      return this.deps.secrets.get(key)
    } catch (err) {
      console.warn('[slinger] could not read a network secret from the keychain:', err instanceof Error ? err.message : err)
      return null
    }
  }

  private changed(): NetworkSettings {
    this.dispatchers.invalidate()
    return this.get()
  }

  // ---- writing ----------------------------------------------------------------------------------------------------------

  update(update: NetworkSettingsUpdate): NetworkSettings {
    const { db, secrets } = this.deps
    if (update.proxy) {
      const current = this.storedProxy()
      const p = update.proxy
      const next: StoredProxy = {
        mode: p.mode ?? current.mode,
        url: p.url !== undefined ? normalizeProxyUrl(p.url) : current.url,
        username: p.username !== undefined ? p.username.trim() : current.username,
        bypass: p.bypass !== undefined ? p.bypass.map((b) => b.trim()).filter((b) => b !== '') : current.bypass,
      }
      if (next.mode === 'custom' && !next.url) throw invalidInput('Enter the proxy URL (http://host:port) to use a custom proxy')
      if (/[\r\n:]/.test(next.username)) throw invalidInput('The proxy username cannot contain a colon or line breaks')
      // The keychain first: a refused write leaves the stored settings unchanged.
      if (p.password === null || p.password === '') secrets.delete(PROXY_PASSWORD_KEY)
      else if (p.password !== undefined) secrets.set(PROXY_PASSWORD_KEY, p.password)
      setSetting(db, PROXY_KEY, JSON.stringify(next))
    }
    if (update.verifySsl !== undefined) {
      if (update.verifySsl) deleteSetting(db, VERIFY_KEY)
      else setSetting(db, VERIFY_KEY, '0')
    }
    return this.changed()
  }

  /** Adds every certificate in these files (PEM, one or more per file, or a single DER certificate). */
  async addCaCertificates(paths: string[]): Promise<NetworkSettings> {
    const parsed: Array<{ name: string; subject: string; pem: string; fingerprint: string; expiresAt: number }> = []
    for (const path of paths) {
      const real = await this.deps.files.resolve(path, 'CA certificate file')
      if ((await stat(real)).size > MAX_CERT_FILE_BYTES) throw invalidInput(`"${basename(real)}" is larger than 1 MB: not a certificate file`)
      const bytes = await readFile(real)
      const pems = bytes.toString('utf8').match(PEM_RE) ?? []
      const certs: X509Certificate[] = []
      try {
        if (pems.length) for (const pem of pems) certs.push(new X509Certificate(pem))
        else certs.push(new X509Certificate(bytes))
      } catch {
        throw invalidInput(`"${basename(real)}" is not a certificate file (expected PEM text starting with -----BEGIN CERTIFICATE-----, or a DER certificate)`)
      }
      for (const [i, cert] of certs.entries()) {
        parsed.push({
          name: certs.length > 1 ? `${basename(real)} #${i + 1}` : basename(real),
          subject: certSubject(cert),
          pem: cert.toString().trim(),
          fingerprint: cert.fingerprint256,
          expiresAt: Math.floor(new Date(cert.validTo).getTime() / 1000) || 0,
        })
      }
    }
    const { db } = this.deps
    const count = (db.prepare('SELECT COUNT(*) AS n FROM network_ca_certs').get() as { n: number }).n
    if (count + parsed.length > MAX_CA_CERTS) throw invalidInput(`At most ${MAX_CA_CERTS} CA certificates can be added`)
    const insert = db.prepare(
      'INSERT OR IGNORE INTO network_ca_certs (id, name, subject, pem, fingerprint, expires_at, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    const now = nowSeconds()
    db.transaction(() => {
      for (const c of parsed) insert.run(newId(), c.name, c.subject, c.pem, c.fingerprint, c.expiresAt, now)
    })()
    return this.changed()
  }

  removeCaCertificate(id: string): NetworkSettings {
    const res = this.deps.db.prepare('DELETE FROM network_ca_certs WHERE id = ?').run(id)
    if (res.changes === 0) throw notFound('CA certificate', { id })
    return this.changed()
  }

  async saveClientCertificate(input: NetworkClientCertificateInput): Promise<NetworkSettings> {
    const { db, secrets } = this.deps
    const existing = input.id
      ? (db.prepare('SELECT id, host, port, crt_path, key_path, pfx_path, has_passphrase FROM network_client_certs WHERE id = ?').get(input.id) as
          | ClientRow
          | undefined)
      : undefined
    if (input.id && !existing) throw notFound('client certificate', { id: input.id })
    const host = input.host.trim().toLowerCase().replace(/^\[|\]$/g, '')
    if (!host || host.length > 253 || !(HOST_RE.test(host) || (host.includes(':') && IPV6_RE.test(host)))) {
      throw invalidInput('Enter the host name the certificate is for (e.g. api.example.com or *.example.com), without https:// or a path')
    }
    const port = input.port ?? null
    // A path saved before may stay as it is; a new one must have been chosen in the file dialog (this session).
    const path = async (value: string | null | undefined, stored: string | null | undefined, label: string): Promise<string | null> => {
      if (!value) return null
      if (stored && value === stored) return stored
      return this.deps.files.resolve(value, label)
    }
    const pfxPath = await path(input.pfxPath, existing?.pfx_path, 'PFX file')
    const crtPath = pfxPath ? null : await path(input.crtPath, existing?.crt_path, 'certificate file')
    const keyPath = pfxPath ? null : await path(input.keyPath, existing?.key_path, 'key file')
    if (!pfxPath && !(crtPath && keyPath)) throw invalidInput('Choose a certificate file and its key file, or a PFX file')
    const id = existing?.id ?? newId()
    if (!existing && (db.prepare('SELECT COUNT(*) AS n FROM network_client_certs').get() as { n: number }).n >= MAX_CLIENT_CERTS) {
      throw invalidInput(`At most ${MAX_CLIENT_CERTS} client certificates can be added`)
    }
    let hasPassphrase = existing?.has_passphrase === 1
    if (input.passphrase === null || input.passphrase === '') {
      secrets.delete(clientCertPassphraseKey(id))
      hasPassphrase = false
    } else if (input.passphrase !== undefined) {
      secrets.set(clientCertPassphraseKey(id), input.passphrase)
      hasPassphrase = true
    }
    db.prepare(
      `INSERT INTO network_client_certs (id, host, port, crt_path, key_path, pfx_path, has_passphrase, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET host = excluded.host, port = excluded.port, crt_path = excluded.crt_path, key_path = excluded.key_path,
         pfx_path = excluded.pfx_path, has_passphrase = excluded.has_passphrase`,
    ).run(id, host, port, crtPath, keyPath, pfxPath, hasPassphrase ? 1 : 0, nowSeconds())
    return this.changed()
  }

  removeClientCertificate(id: string): NetworkSettings {
    const res = this.deps.db.prepare('DELETE FROM network_client_certs WHERE id = ?').run(id)
    if (res.changes === 0) throw notFound('client certificate', { id })
    try {
      this.deps.secrets.delete(clientCertPassphraseKey(id))
    } catch (err) {
      console.warn('[slinger] could not delete a client-certificate passphrase:', err instanceof Error ? err.message : err)
    }
    return this.changed()
  }
}
