/**
 * OAuth 2.0 request authorization: constants and token scrubbing shared by the main process and the renderer.
 *
 * The configuration lives in the request document in Postman v2.1 shape
 * (`auth: { type: 'oauth2', oauth2: [{ key, value, type }, ...] }`). Tokens never do: Postman embeds the current
 * `accessToken` (and friends) in that array, so every path that reads or writes documents (import, parse, export,
 * version snapshots) removes those entries with `stripOAuth2Tokens`. Tokens live in the OS keychain only
 * (main process, `slinger:oauth2:<tokenKey>`).
 */

/** Grant types Slinger can run. `implicit` is parsed and preserved but not supported (deprecated by OAuth 2.1). */
export const OAUTH2_GRANT_TYPES = ['authorization_code', 'authorization_code_with_pkce', 'client_credentials', 'password_credentials'] as const
export type OAuth2GrantType = (typeof OAUTH2_GRANT_TYPES)[number]

/** Used when the request's redirect URI is empty. Register exactly this URI with the provider. */
export const DEFAULT_OAUTH2_REDIRECT_URI = 'http://127.0.0.1:47125/oauth2/callback'

/** Keys of the Postman `oauth2` array (or v2.0 object) that hold a token or token metadata; never stored. */
export const OAUTH2_TOKEN_KEYS: ReadonlySet<string> = new Set([
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'idToken',
  'id_token',
  'tokenType',
  'token_type',
  'expires_in',
  'expiresIn',
  'expires_at',
])

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * The auth object without embedded OAuth 2.0 tokens. Returns the SAME reference when there is nothing to remove
 * (non-oauth2 auth, no token entries), so callers can cheaply tell whether anything changed.
 */
export function stripOAuth2Tokens<T>(auth: T): T {
  if (!isObj(auth) || auth.type !== 'oauth2') return auth
  const params = auth.oauth2
  if (Array.isArray(params)) {
    const kept = params.filter((p) => !(isObj(p) && typeof p.key === 'string' && OAUTH2_TOKEN_KEYS.has(p.key)))
    return kept.length === params.length ? auth : ({ ...auth, oauth2: kept } as T)
  }
  if (isObj(params)) {
    // Postman v2.0 stored the parameters as an object.
    const keys = Object.keys(params).filter((k) => OAUTH2_TOKEN_KEYS.has(k))
    if (keys.length === 0) return auth
    const copy: Json = { ...params }
    for (const k of keys) delete copy[k]
    return { ...auth, oauth2: copy } as T
  }
  return auth
}

/** A Postman item (or any object with `request.auth` / `auth`) without embedded OAuth 2.0 tokens; same reference when unchanged. */
export function stripOAuth2TokensFromItem<T>(item: T): T {
  if (!isObj(item)) return item
  let out: Json = item
  if ('auth' in item) {
    const auth = stripOAuth2Tokens(item.auth)
    if (auth !== item.auth) out = { ...out, auth }
  }
  if (isObj(item.request) && 'auth' in item.request) {
    const auth = stripOAuth2Tokens(item.request.auth)
    if (auth !== item.request.auth) out = { ...out, request: { ...item.request, auth } }
  }
  return out as T
}

/**
 * A stored request document (`documentJson` object) without OAuth 2.0 tokens in `auth` or the raw Postman `source`
 * item; same reference when unchanged.
 */
export function stripOAuth2TokensFromDocument<T>(doc: T): T {
  if (!isObj(doc)) return doc
  let out: Json = stripOAuth2TokensFromItem(doc)
  if (isObj(out.source)) {
    const source = stripOAuth2TokensFromItem(out.source)
    if (source !== out.source) out = { ...out, source }
  }
  return out as T
}

/** `documentJson` text without OAuth 2.0 tokens; the same string when nothing had to be removed (or it is not JSON). */
export function stripOAuth2TokensFromDocumentJson(documentJson: string): string {
  if (!documentJson.includes('oauth2')) return documentJson
  try {
    const parsed: unknown = JSON.parse(documentJson)
    const stripped = stripOAuth2TokensFromDocument(parsed)
    return stripped === parsed ? documentJson : JSON.stringify(stripped)
  } catch {
    return documentJson
  }
}

/** A collection snapshot (`CollectionSnapshot`-shaped) whose request documents carry no OAuth 2.0 tokens; same reference when unchanged. */
export function stripOAuth2TokensFromSnapshot<T extends { requests: Array<{ documentJson: string }> }>(snapshot: T): T {
  let changed = false
  const requests = snapshot.requests.map((r) => {
    const documentJson = stripOAuth2TokensFromDocumentJson(r.documentJson)
    if (documentJson === r.documentJson) return r
    changed = true
    return { ...r, documentJson }
  })
  return changed ? { ...snapshot, requests } : snapshot
}
