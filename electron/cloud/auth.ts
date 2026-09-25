/**
 * Cloud account in the main process: config, device-flow sign-in, token storage (OS keychain only),
 * single-flight refresh. Tokens never leave this module toward the renderer (docs/SYNC_DESIGN.md 7.6).
 */
import type { CloudConfig, CloudSession, CloudSignInStart, CloudUser, SyncEvent } from '../../shared/types'
import type { Db } from '../db/database'
import type { Clock, Timers } from '../lib/clock'
import { CLOUD_TOKEN_PREFIX, type SecretStore } from '../services/secrets'
import { deleteSetting, getSetting, setSetting } from '../sync/store'
import { CloudApiError } from './errors'
import { assertBaseUrl, normalizeBaseUrl, type CloudHttp } from './http'

export const DEFAULT_API_BASE_URL = 'https://api.slinger.app'
const CONFIG_KEY = 'cloud.config'
const userKey = (base: string) => `cloud.user:${base}`
export const tokenKey = (base: string) => `${CLOUD_TOKEN_PREFIX}${normalizeBaseUrl(base)}`

interface Tokens {
  accessToken: string
  refreshToken: string
}
interface TokenPairWire {
  access_token: string
  refresh_token: string
}
interface DevicePollWire {
  status: 'pending' | 'expired' | 'denied' | 'approved'
  access_token?: string
  refresh_token?: string
  user?: { id: string; email: string; display_name?: string }
}
interface DeviceStartWire {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in: number
  interval: number
}

export interface CloudAuthDeps {
  db: Db
  secrets: SecretStore
  http: CloudHttp
  clock: Clock
  timers: Timers
  emit: (event: SyncEvent) => void
  defaultDeviceName?: string
}

function jwtExpiryMs(token: string): number | null {
  try {
    const part = token.split('.')[1]
    if (!part) return null
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { exp?: unknown }
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

export class CloudAuth {
  private status: CloudSession['status'] = 'signedOut'
  private user: CloudUser | null = null
  private offline = false
  private loadedFor: string | null = null
  private refreshing: Promise<Tokens> | null = null
  private flow: { deviceCode: string; expiresAt: number; intervalMs: number; timer: unknown; run: number } | null = null
  private runCounter = 0

  constructor(private readonly deps: CloudAuthDeps) {}

  // ---- config ------------------------------------------------------------------------------------------------------

  getConfig(): CloudConfig {
    let stored: Partial<CloudConfig> = {}
    try {
      const raw = getSetting(this.deps.db, CONFIG_KEY)
      if (raw) stored = JSON.parse(raw) as Partial<CloudConfig>
    } catch {
      /* fall back to defaults */
    }
    return {
      apiBaseUrl: normalizeBaseUrl(stored.apiBaseUrl || DEFAULT_API_BASE_URL),
      deviceName: stored.deviceName?.trim() || this.deps.defaultDeviceName || 'Slinger Desktop',
    }
  }

  setConfig(config: CloudConfig): CloudConfig {
    const apiBaseUrl = assertBaseUrl(config.apiBaseUrl)
    const deviceName = config.deviceName.trim()
    if (!deviceName || deviceName.length > 200) throw new Error('The device name must be 1-200 characters')
    const before = this.getConfig()
    setSetting(this.deps.db, CONFIG_KEY, JSON.stringify({ apiBaseUrl, deviceName }))
    if (before.apiBaseUrl !== apiBaseUrl) {
      this.cancelSignIn(false)
      this.loadedFor = null
      this.emitAuth()
    }
    return { apiBaseUrl, deviceName }
  }

  baseUrl(): string {
    return this.getConfig().apiBaseUrl
  }

  // ---- session -----------------------------------------------------------------------------------------------------

  private loadTokens(base: string): Tokens | null {
    let raw: string | null = null
    try {
      raw = this.deps.secrets.get(tokenKey(base))
    } catch {
      return null
    }
    if (!raw) return null
    try {
      const t = JSON.parse(raw) as Partial<Tokens>
      return t.accessToken && t.refreshToken ? { accessToken: t.accessToken, refreshToken: t.refreshToken } : null
    } catch {
      return null
    }
  }

  private saveTokens(base: string, t: Tokens): void {
    this.deps.secrets.set(tokenKey(base), JSON.stringify(t))
  }

  private ensureLoaded(): void {
    const base = this.baseUrl()
    if (this.loadedFor === base) return
    this.loadedFor = base
    if (this.flow) {
      this.status = 'signingIn'
      return
    }
    const tokens = this.loadTokens(base)
    this.status = tokens ? 'signedIn' : 'signedOut'
    this.user = null
    if (tokens) {
      try {
        const cached = getSetting(this.deps.db, userKey(base))
        if (cached) this.user = JSON.parse(cached) as CloudUser
      } catch {
        this.user = null
      }
    }
  }

  snapshot(): CloudSession {
    this.ensureLoaded()
    return { apiBaseUrl: this.baseUrl(), status: this.status, user: this.user, offline: this.offline }
  }

  /** Session including the user; fetches /v1/me once when signed in without a cached user. */
  async getSession(): Promise<CloudSession> {
    this.ensureLoaded()
    if (this.status === 'signedIn' && !this.user) {
      try {
        const me = await this.withToken((token) =>
          this.deps.http.request<{ user: { id: string; email: string; display_name?: string } }>('GET', this.baseUrl(), '/v1/me', { token }),
        )
        this.setUser({ id: me.user.id, email: me.user.email, displayName: me.user.display_name ?? me.user.email })
        this.setOffline(false)
      } catch {
        /* offline or signed out meanwhile: the snapshot below tells */
      }
    }
    return this.snapshot()
  }

  private setUser(user: CloudUser | null): void {
    this.user = user
    const base = this.baseUrl()
    if (user) setSetting(this.deps.db, userKey(base), JSON.stringify(user))
    else deleteSetting(this.deps.db, userKey(base))
  }

  isSignedIn(): boolean {
    return this.snapshot().status === 'signedIn'
  }

  currentUserId(): string | null {
    return this.user?.id ?? null
  }

  setOffline(offline: boolean): void {
    if (this.offline === offline) return
    this.offline = offline
    this.emitAuth()
  }

  private emitAuth(): void {
    this.deps.emit({ type: 'auth', session: this.snapshot() })
  }

  // ---- token use ---------------------------------------------------------------------------------------------------

  /**
   * Runs `fn` with a valid access token: refreshes proactively when the JWT expires within 60 s and once
   * reactively on a 401 (retrying `fn`). A definitive refresh failure signs the session out.
   */
  async withToken<T>(fn: (accessToken: string) => Promise<T>): Promise<T> {
    this.ensureLoaded()
    const base = this.baseUrl()
    let tokens = this.loadTokens(base)
    if (!tokens) throw this.unauthenticated()
    const exp = jwtExpiryMs(tokens.accessToken)
    if (exp !== null && exp - this.deps.clock.now() < 60_000) tokens = await this.refresh(tokens)
    try {
      return await fn(tokens.accessToken)
    } catch (err) {
      if (!(err instanceof CloudApiError) || err.status !== 401) throw err
      const fresh = await this.refresh(tokens)
      return await fn(fresh.accessToken)
    }
  }

  private unauthenticated(): CloudApiError {
    return new CloudApiError({ kind: 'http', status: 401, code: 'unauthenticated', message: 'You are not signed in to the cloud' })
  }

  /** Single-flight rotation. The new pair is persisted BEFORE it is used (a crash must not lose the rotated token). */
  private refresh(stale: Tokens): Promise<Tokens> {
    this.refreshing ??= this.doRefresh(stale).finally(() => (this.refreshing = null))
    return this.refreshing
  }

  private async doRefresh(stale: Tokens): Promise<Tokens> {
    const base = this.baseUrl()
    // Another window/process (or an earlier crashed attempt) may already have rotated: prefer what the keychain holds now.
    const current = this.loadTokens(base)
    if (!current) throw this.unauthenticated()
    if (current.refreshToken !== stale.refreshToken) return current
    try {
      const t = await this.deps.http.request<TokenPairWire>('POST', base, '/v1/auth/refresh', { body: { refresh_token: current.refreshToken } })
      const next = { accessToken: t.access_token, refreshToken: t.refresh_token || current.refreshToken }
      this.saveTokens(base, next)
      this.setOffline(false)
      return next
    } catch (err) {
      if (err instanceof CloudApiError && !err.isTransient) {
        // Definitive: the refresh token is invalid, revoked or reused. Links and pending changes stay.
        this.clearSession()
        throw this.unauthenticated()
      }
      if (err instanceof CloudApiError && err.isNetwork) this.setOffline(true)
      throw err
    }
  }

  private clearSession(): void {
    const base = this.baseUrl()
    try {
      this.deps.secrets.delete(tokenKey(base))
    } catch {
      /* keychain unavailable: memory state below still signs out */
    }
    this.status = 'signedOut'
    this.setUser(null)
    this.emitAuth()
  }

  // ---- device sign-in ----------------------------------------------------------------------------------------------

  async startSignIn(): Promise<CloudSignInStart> {
    this.cancelSignIn(false)
    const cfg = this.getConfig()
    const start = await this.deps.http.request<DeviceStartWire>('POST', cfg.apiBaseUrl, '/v1/auth/device/start', {
      body: { client_name: 'slinger-desktop', device_name: cfg.deviceName },
    })
    const run = ++this.runCounter
    const intervalMs = Math.max(1, start.interval || 5) * 1000
    this.flow = { deviceCode: start.device_code, expiresAt: this.deps.clock.now() + start.expires_in * 1000, intervalMs, timer: null, run }
    this.status = 'signingIn'
    this.emitAuth()
    this.scheduleTick(run)
    return {
      userCode: start.user_code,
      verificationUri: start.verification_uri,
      verificationUriComplete: start.verification_uri_complete ?? null,
      expiresInSec: start.expires_in,
      intervalSec: Math.max(1, start.interval || 5),
    }
  }

  private scheduleTick(run: number): void {
    const flow = this.flow
    if (!flow || flow.run !== run) return
    flow.timer = this.deps.timers.setTimeout(() => void this.tick(run), flow.intervalMs)
  }

  private async tick(run: number): Promise<void> {
    const flow = this.flow
    if (!flow || flow.run !== run) return
    if (this.deps.clock.now() >= flow.expiresAt) return this.finishSignIn(run, 'expired', null)
    try {
      const res = await this.deps.http.request<DevicePollWire>('POST', this.baseUrl(), '/v1/auth/device/poll', { body: { device_code: flow.deviceCode } })
      if (this.flow?.run !== run) return
      if (res.status === 'approved' && res.access_token && res.refresh_token) {
        try {
          this.saveTokens(this.baseUrl(), { accessToken: res.access_token, refreshToken: res.refresh_token })
        } catch (err) {
          return this.finishSignIn(run, 'error', `Could not store the session in the OS keychain: ${err instanceof Error ? err.message : String(err)}`)
        }
        this.setUser(res.user ? { id: res.user.id, email: res.user.email, displayName: res.user.display_name ?? res.user.email } : null)
        this.flow = null
        this.status = 'signedIn'
        this.loadedFor = this.baseUrl()
        this.setOffline(false)
        this.emitAuth()
        this.deps.emit({ type: 'signInResult', result: 'approved', message: null })
        return
      }
      if (res.status === 'expired' || res.status === 'denied') return this.finishSignIn(run, res.status, null)
    } catch (err) {
      if (this.flow?.run !== run) return
      // Transient problems keep polling until the code expires; anything else ends the attempt.
      if (!(err instanceof CloudApiError && err.isTransient)) {
        return this.finishSignIn(run, 'error', err instanceof Error ? err.message : String(err))
      }
    }
    this.scheduleTick(run)
  }

  private finishSignIn(run: number, result: 'expired' | 'denied' | 'cancelled' | 'error', message: string | null): void {
    if (this.flow?.run !== run) return
    this.deps.timers.clearTimeout(this.flow.timer)
    this.flow = null
    this.loadedFor = null
    this.ensureLoaded()
    this.emitAuth()
    this.deps.emit({ type: 'signInResult', result, message })
  }

  cancelSignIn(announce = true): void {
    const flow = this.flow
    if (!flow) return
    if (announce) this.finishSignIn(flow.run, 'cancelled', null)
    else {
      this.deps.timers.clearTimeout(flow.timer)
      this.flow = null
      this.loadedFor = null
    }
  }

  async signOut(): Promise<void> {
    this.cancelSignIn(false)
    const base = this.baseUrl()
    const tokens = this.loadTokens(base)
    if (tokens) {
      try {
        await this.deps.http.request('POST', base, '/v1/auth/logout', { body: { refresh_token: tokens.refreshToken }, timeoutMs: 5_000 })
      } catch {
        /* best effort: the local session is removed either way */
      }
    }
    this.loadedFor = base
    this.clearSession()
  }
}
