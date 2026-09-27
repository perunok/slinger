/**
 * Browser-mock OAuth 2.0: tokens are simulated (no provider is contacted) and kept in `MockState.oauth2Tokens`,
 * the stand-in for the OS keychain. Same contract as electron/services/oauth2.ts: the renderer gets status only.
 */
import type { SlingerIpcApi } from '../../../shared/ipc-contract'
import { DEFAULT_OAUTH2_REDIRECT_URI } from '../../../shared/oauth2'
import type { OAuth2Config, OAuth2TokenStatus } from '../../../shared/types'
import type { MockOAuth2Token, MockState } from './store'
import { fail, nowSec, sleep, uuid } from './util'

type OAuth2Api = Pick<
  SlingerIpcApi,
  'getOAuth2Token' | 'cancelOAuth2Flow' | 'refreshOAuth2Token' | 'getOAuth2TokenStatus' | 'deleteOAuth2Token' | 'revealOAuth2Token'
>

/** Deterministic 64-hex key (not cryptographic; the real one is SHA-256 in main). */
export function mockTokenKey(c: OAuth2Config): string {
  const authCode = c.grantType === 'authorization_code' || c.grantType === 'authorization_code_with_pkce'
  const text = JSON.stringify([c.workspaceId, c.grantType, c.accessTokenUrl.trim(), authCode ? c.authUrl.trim() : '', c.clientId, c.scope.trim(), c.audience, c.resource,
    c.grantType === 'password_credentials' ? c.username : ''])
  let out = ''
  for (let seed = 0; seed < 8; seed++) {
    let h = (0x811c9dc5 ^ seed) >>> 0
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0
    out += h.toString(16).padStart(8, '0')
  }
  return out
}

const mask = (t: string) => (t.length >= 16 ? `${t.slice(0, 4)}…${t.slice(-4)}` : '••••••••')

function statusOf(key: string, t: MockOAuth2Token | undefined): OAuth2TokenStatus {
  return {
    tokenKey: key,
    hasToken: !!t,
    tokenType: t?.tokenType ?? null,
    scope: t?.scope ?? null,
    expiresAt: t?.expiresAt ?? null,
    obtainedAt: t?.obtainedAt ?? null,
    expired: !!t && t.expiresAt !== null && t.expiresAt <= nowSec(),
    hasRefreshToken: !!t?.refreshToken,
    maskedToken: t ? mask(t.accessToken) : null,
  }
}

function httpUrl(value: string, label: string): void {
  try {
    const u = new URL(value.trim())
    if (u.protocol === 'http:' || u.protocol === 'https:') return
  } catch {
    /* below */
  }
  fail('invalid_input', value.trim() ? `${label} must be an http or https URL` : `${label} is required`)
}

/** The access token for executeHttpRequest, or the same errors as main. */
export function mockAccessToken(s: MockState, tokenKey: string): string {
  const t = s.oauth2Tokens[tokenKey]
  if (!t) fail('invalid_input', 'No access token yet: click Get New Access Token in the Authorization tab', { reason: 'oauth2_no_token' })
  if (t.expiresAt !== null && t.expiresAt <= nowSec()) {
    fail('invalid_input', 'The access token has expired: click Get New Access Token in the Authorization tab', { reason: 'oauth2_expired' })
  }
  return t.accessToken
}

export function createOAuth2Api(s: MockState, latency: () => number): OAuth2Api {
  const flows = new Map<string, () => void>()
  const issue = (c: OAuth2Config): MockOAuth2Token => ({
    accessToken: `mock-${c.grantType}-${uuid().replace(/-/g, '')}`,
    tokenType: 'Bearer',
    expiresAt: nowSec() + 3600,
    refreshToken: `mock-refresh-${uuid()}`,
    scope: c.scope.trim() || null,
    obtainedAt: nowSec(),
  })
  return {
    async getOAuth2Token(c, options) {
      httpUrl(c.accessTokenUrl, 'Access Token URL')
      if (!c.clientId && c.grantType !== 'password_credentials') fail('invalid_input', 'Client ID is required')
      if (c.clientSecret === 'wrong') fail('invalid_input', 'The token endpoint answered HTTP 401: invalid_client', { status: 401, oauthError: 'invalid_client' })
      if (c.grantType === 'authorization_code' || c.grantType === 'authorization_code_with_pkce') {
        httpUrl(c.authUrl, 'Auth URL')
        const redirect = new URL(c.redirectUri.trim() || DEFAULT_OAUTH2_REDIRECT_URI)
        if (redirect.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(redirect.hostname)) {
          fail('invalid_input', 'Slinger cannot receive the redirect there: register a loopback redirect URI such as http://127.0.0.1:47125/oauth2/callback', {
            reason: 'redirect_not_loopback',
          })
        }
        // "The browser": the user approves after a moment, unless the flow is cancelled.
        const flowId = options?.flowId
        let cancelled = false
        if (flowId) flows.set(flowId, () => (cancelled = true))
        const wait = latency() > 0 ? 1500 : 0
        for (let t = 0; t <= wait && !cancelled; t += 50) await sleep(Math.min(50, wait))
        if (flowId) flows.delete(flowId)
        if (cancelled) fail('network_error', 'Authorization cancelled', { cancelled: true })
      }
      const key = mockTokenKey(c)
      s.oauth2Tokens[key] = issue(c)
      return statusOf(key, s.oauth2Tokens[key])
    },
    async cancelOAuth2Flow(flowId) {
      flows.get(flowId)?.()
    },
    async refreshOAuth2Token(c, options) {
      const key = mockTokenKey(c)
      const t = s.oauth2Tokens[key]
      const expiring = !!t && t.expiresAt !== null && t.expiresAt - nowSec() <= 30
      if (options?.ifExpiring && (!t || !expiring || !t.refreshToken)) return statusOf(key, t)
      if (!t) fail('invalid_input', 'No access token yet: click Get New Access Token')
      if (!t.refreshToken) fail('invalid_input', 'This token has no refresh token: click Get New Access Token', { reason: 'no_refresh_token' })
      s.oauth2Tokens[key] = { ...issue(c), refreshToken: t.refreshToken }
      return statusOf(key, s.oauth2Tokens[key])
    },
    async getOAuth2TokenStatus(c) {
      const key = mockTokenKey(c)
      return statusOf(key, s.oauth2Tokens[key])
    },
    async deleteOAuth2Token(tokenKey) {
      delete s.oauth2Tokens[tokenKey]
    },
    async revealOAuth2Token(tokenKey) {
      const t = s.oauth2Tokens[tokenKey]
      if (!t) fail('invalid_input', 'No access token is stored for this configuration')
      return t.accessToken
    },
  }
}
