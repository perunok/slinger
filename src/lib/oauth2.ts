/**
 * OAuth 2.0 helpers for the renderer (pure). The request keeps the settings (`OAuth2Draft`, Postman shape); main runs
 * the grants and keeps the tokens (see shared/oauth2.ts, electron/services/oauth2.ts).
 */
import { OAUTH2_GRANT_TYPES, type OAuth2GrantType } from '../../shared/oauth2'
import type { OAuth2Config, OAuth2TokenStatus } from '../../shared/types'
import { oauth2TemplateTexts, type OAuth2Draft } from './request'

export const GRANT_LABELS: Record<OAuth2GrantType | 'implicit', string> = {
  authorization_code_with_pkce: 'Authorization Code (With PKCE)',
  authorization_code: 'Authorization Code',
  client_credentials: 'Client Credentials',
  password_credentials: 'Password Credentials',
  implicit: 'Implicit (not supported)',
}

export const isSupportedGrant = (grant: string): grant is OAuth2GrantType => (OAUTH2_GRANT_TYPES as readonly string[]).includes(grant)
export const isAuthCodeGrant = (grant: string): boolean => grant === 'authorization_code' || grant === 'authorization_code_with_pkce'

export function unsupportedGrantMessage(grant: string): string {
  return grant === 'implicit'
    ? 'The OAuth 2.0 implicit grant is not supported (it is deprecated): use Authorization Code (With PKCE).'
    : `The OAuth 2.0 grant type "${grant}" is not supported.`
}

/** Every setting "Get New Access Token" uses for this grant (all must resolve; secrets are revealed for it). */
export function oauth2TokenRequestTexts(o: OAuth2Draft): string[] {
  const out = [o.accessTokenUrl, o.clientId, o.clientSecret, o.scope, o.audience, o.resource, o.refreshTokenUrl]
  if (isAuthCodeGrant(o.grantType)) out.push(o.authUrl, o.state, o.redirectUri)
  if (o.grantType === 'authorization_code_with_pkce') out.push(o.codeVerifier)
  if (o.grantType === 'password_credentials') out.push(o.username, o.password)
  return out
}

/**
 * The resolved settings main needs; `resolve` applies templates (prepare.ts `templateResolver`). Only for a supported
 * grant. `purpose: 'send'` resolves just what a send needs (the token's identity and the refresh credentials, see
 * request.ts `oauth2TemplateTexts`) and leaves the rest empty, so an unused `{{variable}}` cannot block a send.
 */
export function resolveOAuth2Config(o: OAuth2Draft, workspaceId: string, resolve: (text: string) => string, purpose: 'send' | 'token' = 'token'): OAuth2Config {
  const needed = new Set(purpose === 'send' ? oauth2TemplateTexts(o) : oauth2TokenRequestTexts(o))
  const raw = (t: string) => (needed.has(t) ? resolve(t) : '')
  const r = (t: string) => raw(t).trim()
  return {
    workspaceId,
    grantType: o.grantType as OAuth2GrantType,
    authUrl: r(o.authUrl),
    accessTokenUrl: r(o.accessTokenUrl),
    clientId: r(o.clientId),
    clientSecret: raw(o.clientSecret),
    scope: r(o.scope),
    state: r(o.state),
    redirectUri: r(o.redirectUri),
    username: r(o.username),
    password: raw(o.password),
    challengeAlgorithm: o.challengeAlgorithm,
    codeVerifier: r(o.codeVerifier),
    clientAuthentication: o.clientAuthentication,
    refreshTokenUrl: r(o.refreshTokenUrl),
    audience: r(o.audience),
    resource: r(o.resource),
  }
}

/** One status line: "Valid until 14:05 · scope read" / "Expired at ..." / "No token yet". */
export function describeTokenStatus(s: OAuth2TokenStatus | null, now = Date.now()): { text: string; tone: 'ok' | 'warn' | 'none' } {
  if (!s || !s.hasToken) return { text: 'No access token yet.', tone: 'none' }
  const scope = s.scope ? ` · scope ${s.scope}` : ''
  if (s.expiresAt === null) return { text: `${s.tokenType ?? 'Token'} without an expiry time${scope}`, tone: 'ok' }
  const at = new Date(s.expiresAt * 1000)
  const sameDay = at.toDateString() === new Date(now).toDateString()
  const when = sameDay ? at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : at.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
  if (s.expiresAt * 1000 <= now) {
    return { text: `Expired at ${when}${s.hasRefreshToken ? ' (refreshed automatically on the next send)' : ''}${scope}`, tone: 'warn' }
  }
  return { text: `Valid until ${when}${s.hasRefreshToken ? ', refreshable' : ''}${scope}`, tone: 'ok' }
}
