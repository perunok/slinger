/**
 * OAuth 2.0 tokens for the user's requests (not the cloud account; that is electron/cloud/).
 *
 * The renderer resolves the request's `{{variables}}` and sends a resolved `OAuth2Config`; everything else happens
 * here: the grant (browser + loopback redirect for the authorization code, direct POST for client credentials and
 * password), token response parsing, storage in the OS keychain under `slinger:oauth2:<tokenKey>`, refresh, and
 * handing the token to the HTTP executor by key. The renderer only ever gets `OAuth2TokenStatus` (no token), except
 * through the explicit `reveal`.
 *
 * Token requests use the same HTTP engine as a normal send (`executeHttp`) but never write history.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { HttpResponseData, OAuth2Config, OAuth2TokenStatus, RequestHeader } from '../../shared/types'
import { DEFAULT_OAUTH2_REDIRECT_URI } from '../../shared/oauth2'
import { invalidInput, IpcError, ioError, networkError } from '../lib/errors'
import { executeHttp, OAUTH2_TOKEN_KEY_RE } from './httpExecutor'
import { parseLoopbackRedirect, startAuthorizationCallback } from './oauth2Callback'
import { OAUTH2_TOKEN_PREFIX, type SecretStore } from './secrets'

/** What the keychain entry holds (JSON). */
export interface StoredOAuth2Token {
  access_token: string
  token_type: string
  /** Unix seconds, or null when the server gave no `expires_in`. */
  expires_at: number | null
  refresh_token: string | null
  scope: string | null
  obtained_at: number
  /** Workspace the token belongs to (for the per-workspace index; not secret). */
  workspace_id?: string
}

/** Keychain entry listing a workspace's token keys, so deleting the workspace deletes its tokens. */
const indexKey = (workspaceId: string) => `${OAUTH2_TOKEN_PREFIX}index:${workspaceId.toLowerCase()}`

export const DEFAULT_FLOW_TIMEOUT_MS = 5 * 60_000
export const MAX_FLOW_TIMEOUT_MS = 10 * 60_000
/** A token that expires within this window is refreshed before a send. */
export const REFRESH_WINDOW_S = 30
const TOKEN_REQUEST_TIMEOUT_MS = 30_000
const MAX_TOKEN_RESPONSE_BYTES = 1024 * 1024
const MAX_TOKEN_LENGTH = 64 * 1024
const FLOW_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/
const PKCE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/

const base64url = (bytes: Buffer): string => bytes.toString('base64url')
export const randomToken = (bytes: number): string => base64url(randomBytes(bytes))
export const pkceChallenge = (verifier: string, method: 'S256' | 'plain'): string =>
  method === 'plain' ? verifier : base64url(createHash('sha256').update(verifier, 'ascii').digest())

const isAuthCode = (c: OAuth2Config) => c.grantType === 'authorization_code' || c.grantType === 'authorization_code_with_pkce'

/**
 * Stable id of the token for a workspace + configuration: requests that share a configuration (common after import
 * flattened a collection-level auth into every request) share one token. Secrets and redirect details are not part
 * of it, so changing a client secret keeps the token.
 */
export function oauth2TokenKey(c: OAuth2Config): string {
  const identity = [
    'slinger-oauth2-v1',
    c.workspaceId,
    c.grantType,
    c.accessTokenUrl.trim(),
    isAuthCode(c) ? c.authUrl.trim() : '',
    c.clientId,
    c.scope.trim(),
    c.audience,
    c.resource,
    c.grantType === 'password_credentials' ? c.username : '',
  ]
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

export function maskToken(token: string): string {
  return token.length >= 16 ? `${token.slice(0, 4)}…${token.slice(-4)}` : '••••••••'
}

function httpUrl(value: string, label: string): URL {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw invalidInput(value.trim() ? `${label} "${value.trim()}" is not a valid URL` : `${label} is required`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalidInput(`${label} must be an http or https URL`)
  return url
}

/** Form encoding of RFC 6749 section 2.3.1 for the Basic client credentials. */
const formEncode = (s: string) => new URLSearchParams([['', s]]).toString().slice(1)

/** Parses a token endpoint answer: JSON (the standard) or form-encoded (e.g. GitHub without Accept). */
export function parseTokenResponse(res: HttpResponseData): Record<string, unknown> {
  const text = (res.bodyText ?? '').trim()
  if (text.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      /* fall through */
    }
  }
  const type = res.headers.find((h) => h.key.toLowerCase() === 'content-type')?.value ?? ''
  if (/x-www-form-urlencoded|text\/plain/i.test(type) || /^[\w.~%-]+=[^\s<]*(&[\w.~%-]+=[^\s<]*)*$/.test(text)) {
    return Object.fromEntries(new URLSearchParams(text))
  }
  return {}
}

const short = (v: unknown) => (typeof v === 'string' ? v.slice(0, 300) : '')

export interface OAuth2ServiceOptions {
  now?: () => number
}

export class OAuth2Service {
  private readonly flows = new Map<string, AbortController>()
  private readonly now: () => number

  constructor(
    private readonly secrets: SecretStore,
    options: OAuth2ServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now
  }

  private nowS(): number {
    return Math.floor(this.now() / 1000)
  }

  // ---- keychain -----------------------------------------------------------

  private read(tokenKey: string): StoredOAuth2Token | null {
    let raw: string | null
    try {
      raw = this.secrets.get(OAUTH2_TOKEN_PREFIX + tokenKey)
    } catch (err) {
      throw keychainError('read', err)
    }
    if (!raw) return null
    try {
      const t = JSON.parse(raw) as StoredOAuth2Token
      return typeof t.access_token === 'string' && t.access_token ? t : null
    } catch {
      return null
    }
  }

  private write(tokenKey: string, token: StoredOAuth2Token): void {
    try {
      this.secrets.set(OAUTH2_TOKEN_PREFIX + tokenKey, JSON.stringify(token))
      if (token.workspace_id) {
        const keys = this.readIndex(token.workspace_id)
        if (!keys.includes(tokenKey)) this.secrets.set(indexKey(token.workspace_id), JSON.stringify([...keys, tokenKey]))
      }
    } catch (err) {
      throw keychainError('store', err)
    }
  }

  private readIndex(workspaceId: string): string[] {
    try {
      const parsed: unknown = JSON.parse(this.secrets.get(indexKey(workspaceId)) ?? '[]')
      return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string' && OAUTH2_TOKEN_KEY_RE.test(k)) : []
    } catch {
      return []
    }
  }

  /** Deletes every token of a deleted workspace (best effort: a keychain failure is logged, not thrown). */
  deleteWorkspaceTokens(workspaceId: string): void {
    try {
      for (const key of this.readIndex(workspaceId)) this.secrets.delete(OAUTH2_TOKEN_PREFIX + key)
      this.secrets.delete(indexKey(workspaceId))
    } catch (err) {
      console.warn('[slinger] could not delete OAuth 2.0 tokens of a deleted workspace:', err instanceof Error ? err.message : err)
    }
  }

  private statusOf(tokenKey: string, t: StoredOAuth2Token | null): OAuth2TokenStatus {
    return {
      tokenKey,
      hasToken: !!t,
      tokenType: t?.token_type ?? null,
      scope: t?.scope ?? null,
      expiresAt: t?.expires_at ?? null,
      obtainedAt: t?.obtained_at ?? null,
      expired: !!t && t.expires_at !== null && t.expires_at <= this.nowS(),
      hasRefreshToken: !!t?.refresh_token,
      maskedToken: t ? maskToken(t.access_token) : null,
    }
  }

  // ---- IPC operations -----------------------------------------------------

  status(config: OAuth2Config): OAuth2TokenStatus {
    const key = oauth2TokenKey(config)
    return this.statusOf(key, this.read(key))
  }

  /** Runs the configured grant and stores the token. `openBrowser` is only used by the authorization code grant. */
  async getToken(
    config: OAuth2Config,
    options: { flowId?: string; timeoutMs?: number },
    openBrowser: (url: string) => Promise<void>,
  ): Promise<OAuth2TokenStatus> {
    const tokenUrl = httpUrl(config.accessTokenUrl, 'Access Token URL')
    if (!config.clientId && config.grantType !== 'password_credentials') throw invalidInput('Client ID is required')
    const flowId = options.flowId ?? null
    if (flowId !== null) {
      if (!FLOW_ID_RE.test(flowId)) throw invalidInput('flowId must be 1-128 characters of [A-Za-z0-9._:-]')
      if (this.flows.has(flowId)) throw invalidInput('an OAuth 2.0 flow with this id is already running')
    }
    const controller = new AbortController()
    if (flowId !== null) this.flows.set(flowId, controller)
    const timeoutMs = Math.min(Math.max(options.timeoutMs ?? DEFAULT_FLOW_TIMEOUT_MS, 1), MAX_FLOW_TIMEOUT_MS)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const aborted = () =>
      timedOut
        ? networkError(`Timed out after ${Math.round(timeoutMs / 1000)} s waiting for the authorization`, { timedOut: true })
        : networkError('Authorization cancelled', { cancelled: true })
    try {
      let params: Array<[string, string]>
      switch (config.grantType) {
        case 'client_credentials':
          params = [['grant_type', 'client_credentials']]
          break
        case 'password_credentials':
          if (!config.username) throw invalidInput('Username is required for the password grant')
          params = [['grant_type', 'password'], ['username', config.username], ['password', config.password]]
          break
        case 'authorization_code':
        case 'authorization_code_with_pkce': {
          const code = await this.authorize(config, controller.signal, openBrowser, aborted)
          params = [['grant_type', 'authorization_code'], ['code', code.code], ['redirect_uri', code.redirectUri]]
          if (code.verifier) params.push(['code_verifier', code.verifier])
          break
        }
        default:
          throw invalidInput(`Grant type "${String(config.grantType)}" is not supported`)
      }
      if (!isAuthCode(config) && config.scope.trim()) params.push(['scope', config.scope.trim()])
      if (config.audience) params.push(['audience', config.audience])
      if (config.resource) params.push(['resource', config.resource])
      const token = await this.tokenRequest(config, tokenUrl, params, controller.signal, aborted)
      if (!token.scope && config.scope.trim()) token.scope = config.scope.trim()
      token.workspace_id = config.workspaceId
      const key = oauth2TokenKey(config)
      this.write(key, token)
      return this.statusOf(key, token)
    } finally {
      clearTimeout(timer)
      if (flowId !== null) this.flows.delete(flowId)
    }
  }

  /** Cancelling an unknown or finished flow is a no-op. */
  cancel(flowId: string): void {
    this.flows.get(flowId)?.abort()
  }

  cancelAll(): void {
    for (const c of this.flows.values()) c.abort()
  }

  /**
   * Uses the stored refresh token. With `ifExpiring` (before every send) it only acts when the token expires within
   * REFRESH_WINDOW_S and has a refresh token, and otherwise just reports the status.
   */
  async refresh(config: OAuth2Config, options: { ifExpiring?: boolean } = {}): Promise<OAuth2TokenStatus> {
    const key = oauth2TokenKey(config)
    const stored = this.read(key)
    const expiring = !!stored && stored.expires_at !== null && stored.expires_at - this.nowS() <= REFRESH_WINDOW_S
    if (options.ifExpiring && (!stored || !expiring || !stored.refresh_token)) return this.statusOf(key, stored)
    if (!stored) throw invalidInput('No access token yet: click Get New Access Token')
    if (!stored.refresh_token) throw invalidInput('This token has no refresh token: click Get New Access Token', { reason: 'no_refresh_token' })
    const url = httpUrl(config.refreshTokenUrl || config.accessTokenUrl, config.refreshTokenUrl ? 'Refresh Token URL' : 'Access Token URL')
    const controller = new AbortController()
    let fresh: StoredOAuth2Token
    try {
      fresh = await this.tokenRequest(config, url, [['grant_type', 'refresh_token'], ['refresh_token', stored.refresh_token]], controller.signal, () =>
        networkError('Token refresh cancelled', { cancelled: true }),
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw invalidInput(
        options.ifExpiring
          ? `The access token expired and could not be refreshed (${message}). Get a new access token.`
          : `Could not refresh the access token: ${message}`,
        { reason: 'refresh_failed' },
      )
    }
    // Servers may omit an unchanged refresh token and scope.
    fresh.refresh_token ??= stored.refresh_token
    fresh.scope ??= stored.scope
    fresh.workspace_id = config.workspaceId
    this.write(key, fresh)
    return this.statusOf(key, fresh)
  }

  delete(tokenKey: string): void {
    const stored = this.read(assertTokenKey(tokenKey))
    try {
      this.secrets.delete(OAUTH2_TOKEN_PREFIX + tokenKey)
      if (stored?.workspace_id) {
        const keys = this.readIndex(stored.workspace_id).filter((k) => k !== tokenKey)
        if (keys.length > 0) this.secrets.set(indexKey(stored.workspace_id), JSON.stringify(keys))
        else this.secrets.delete(indexKey(stored.workspace_id))
      }
    } catch (err) {
      throw keychainError('delete', err)
    }
  }

  /** The access token itself: only for an explicit user action (Reveal). */
  reveal(tokenKey: string): string {
    const t = this.read(assertTokenKey(tokenKey))
    if (!t) throw invalidInput('No access token is stored for this configuration')
    return t.access_token
  }

  /** For the HTTP executor: the token to send, or a user-facing error. */
  accessTokenFor(tokenKey: string): string {
    const t = this.read(assertTokenKey(tokenKey))
    if (!t) throw invalidInput('No access token yet: click Get New Access Token in the Authorization tab', { reason: 'oauth2_no_token' })
    if (t.expires_at !== null && t.expires_at <= this.nowS()) {
      throw invalidInput('The access token has expired: click Get New Access Token in the Authorization tab', { reason: 'oauth2_expired' })
    }
    return t.access_token
  }

  // ---- grant internals ----------------------------------------------------

  private async authorize(
    config: OAuth2Config,
    signal: AbortSignal,
    openBrowser: (url: string) => Promise<void>,
    aborted: () => IpcError,
  ): Promise<{ code: string; redirectUri: string; verifier: string | null }> {
    const authUrl = httpUrl(config.authUrl, 'Auth URL')
    const redirect = parseLoopbackRedirect(config.redirectUri.trim() || DEFAULT_OAUTH2_REDIRECT_URI)
    const state = config.state || randomToken(16)
    let verifier: string | null = null
    if (config.grantType === 'authorization_code_with_pkce') {
      verifier = config.codeVerifier || randomToken(32)
      if (!PKCE_VERIFIER_RE.test(verifier)) {
        throw invalidInput('Code verifier must be 43-128 characters of letters, digits, "-", ".", "_" and "~" (leave it empty to generate one)')
      }
      authUrl.searchParams.set('code_challenge', pkceChallenge(verifier, config.challengeAlgorithm))
      authUrl.searchParams.set('code_challenge_method', config.challengeAlgorithm)
    }
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('client_id', config.clientId)
    authUrl.searchParams.set('redirect_uri', redirect.uri)
    if (config.scope.trim()) authUrl.searchParams.set('scope', config.scope.trim())
    authUrl.searchParams.set('state', state)
    if (config.audience) authUrl.searchParams.set('audience', config.audience)
    if (config.resource) authUrl.searchParams.set('resource', config.resource)

    if (signal.aborted) throw aborted()
    const callback = await startAuthorizationCallback(redirect, state)
    const onAbort = () => callback.close()
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      await openBrowser(authUrl.toString())
      const code = await Promise.race([
        callback.code,
        new Promise<never>((_, reject) => {
          if (signal.aborted) reject(aborted())
          signal.addEventListener('abort', () => reject(aborted()), { once: true })
        }),
      ])
      return { code, redirectUri: redirect.uri, verifier }
    } finally {
      signal.removeEventListener('abort', onAbort)
      callback.close()
    }
  }

  private async tokenRequest(
    config: OAuth2Config,
    url: URL,
    params: Array<[string, string]>,
    signal: AbortSignal,
    aborted: () => IpcError,
  ): Promise<StoredOAuth2Token> {
    const headers: RequestHeader[] = [{ key: 'Accept', value: 'application/json' }]
    const fields = [...params]
    if (config.clientAuthentication === 'header' && config.clientSecret) {
      const basic = Buffer.from(`${formEncode(config.clientId)}:${formEncode(config.clientSecret)}`, 'utf8').toString('base64')
      headers.push({ key: 'Authorization', value: `Basic ${basic}` })
    } else {
      // Public clients (no secret) always identify themselves in the body.
      if (config.clientId) fields.push(['client_id', config.clientId])
      if (config.clientSecret) fields.push(['client_secret', config.clientSecret])
    }
    let res: HttpResponseData
    try {
      res = await executeHttp(
        {
          method: 'POST',
          url: url.toString(),
          headers,
          auth: { kind: 'none' },
          body: { mode: 'urlEncoded', urlEncoded: fields.map(([key, value]) => ({ key, value, enabled: true })) },
          timeoutMs: TOKEN_REQUEST_TIMEOUT_MS,
          workspaceId: '',
        },
        { signal, maxResponseBytes: MAX_TOKEN_RESPONSE_BYTES },
      )
    } catch (err) {
      if (signal.aborted) throw aborted()
      if (err instanceof IpcError) throw new IpcError({ code: err.code, message: `Token request failed: ${err.message}`, details: err.details })
      throw err
    }
    const data = parseTokenResponse(res)
    if (res.status >= 400 || typeof data.error === 'string') {
      const error = short(data.error)
      const description = short(data.error_description)
      throw invalidInput(
        `The token endpoint answered HTTP ${res.status}${error ? `: ${error}` : ''}${description ? ` (${description})` : ''}`,
        { status: res.status, ...(error ? { oauthError: error } : {}) },
      )
    }
    const accessToken = data.access_token
    if (typeof accessToken !== 'string' || !accessToken || accessToken.length > MAX_TOKEN_LENGTH) {
      throw invalidInput(`The token endpoint answered HTTP ${res.status} without an access_token (check the Access Token URL)`, { status: res.status })
    }
    const expiresIn = Number(data.expires_in)
    const now = this.nowS()
    const refresh = typeof data.refresh_token === 'string' && data.refresh_token && data.refresh_token.length <= MAX_TOKEN_LENGTH ? data.refresh_token : null
    return {
      access_token: accessToken,
      token_type: short(data.token_type) || 'Bearer',
      expires_at: data.expires_in !== undefined && data.expires_in !== '' && Number.isFinite(expiresIn) && expiresIn >= 0 ? now + Math.floor(expiresIn) : null,
      refresh_token: refresh,
      scope: short(data.scope) || null,
      obtained_at: now,
    }
  }
}

function assertTokenKey(tokenKey: string): string {
  if (typeof tokenKey !== 'string' || !OAUTH2_TOKEN_KEY_RE.test(tokenKey)) throw invalidInput('OAuth 2.0 token key is invalid')
  return tokenKey
}

function keychainError(action: 'read' | 'store' | 'delete', err: unknown): IpcError {
  const message = err instanceof Error ? err.message : String(err)
  return ioError(`Could not ${action} the OAuth 2.0 token in the OS keychain (${message}). The rest of the app keeps working; OAuth 2.0 needs the keychain.`)
}
