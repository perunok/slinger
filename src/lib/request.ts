/**
 * Editable request model and its (de)serialisation to `ApiRequest.documentJson`.
 *
 * The document keeps the Postman v2.1 item shape (headers[], body{mode,...}, auth{type,...})
 * because that is what the Postman importer stores, so imported and hand-made requests
 * share one format. Keys we do not edit (scripts, responses, source, ...) are preserved verbatim.
 */
import type { ApiRequest } from '../../shared/types'
import { stripOAuth2TokensFromItem } from '../../shared/oauth2'
import { dataRows, ensureTrailingEmpty, newRow, type KvRow } from './kv'
import { writeDescription } from './description'
import { mergeParamsFromUrl } from './urlParams'

export type BodyKind = 'none' | 'formData' | 'urlEncoded' | 'raw' | 'binary' | 'unsupported'
export type RawLanguage = 'json' | 'xml' | 'text' | 'html' | 'javascript'
export type AuthKind = 'none' | 'basic' | 'bearer' | 'apiKey' | 'oauth2' | 'unsupported'

export interface BodyDraft {
  kind: BodyKind
  raw: string
  rawLanguage: RawLanguage
  formData: KvRow[]
  urlEncoded: KvRow[]
  binaryPath: string
  /** Original body object when kind === 'unsupported' (kept and re-saved untouched). */
  preserved?: unknown
}

/**
 * OAuth 2.0 configuration, field names after Postman's `oauth2` array keys. `grantType` keeps whatever the document
 * says (including `implicit` and unknown values, which the UI reports as unsupported). Never holds a token.
 */
export interface OAuth2Draft {
  grantType: string
  authUrl: string
  accessTokenUrl: string
  clientId: string
  clientSecret: string
  scope: string
  state: string
  redirectUri: string
  username: string
  password: string
  challengeAlgorithm: 'S256' | 'plain'
  codeVerifier: string
  clientAuthentication: 'header' | 'body'
  addTokenTo: 'header' | 'queryParams'
  headerPrefix: string
  tokenName: string
  refreshTokenUrl: string
  audience: string
  resource: string
  /** Entries Slinger does not edit (authRequestParams, useBrowser, ...), written back verbatim and in order. */
  extra: Array<Record<string, unknown>>
}

export interface AuthDraft {
  kind: AuthKind
  basic: { username: string; password: string }
  bearer: { token: string }
  apiKey: { key: string; value: string; addTo: 'header' | 'query' }
  oauth2: OAuth2Draft
  unsupportedType?: string
  preserved?: unknown
}

export interface RequestDraft {
  name: string
  method: string
  url: string
  /** Documentation text (Markdown, or plain text when the stored value is a text/plain object). */
  description: string
  /**
   * The stored Postman `description` value (string, `{content, type}` or null) this draft was loaded from.
   * Never edited by the UI; saving writes it back unchanged while `description` still matches it.
   */
  descriptionSource?: unknown
  params: KvRow[]
  headers: KvRow[]
  body: BodyDraft
  auth: AuthDraft
  timeoutMs: number | null
  /** Unedited document keys carried through save (scripts, responses, source, ...). */
  extras: Record<string, unknown>
}

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const

export const RAW_LANGUAGES: { id: RawLanguage; label: string; contentType: string }[] = [
  { id: 'json', label: 'JSON', contentType: 'application/json' },
  { id: 'xml', label: 'XML', contentType: 'application/xml' },
  { id: 'text', label: 'Text', contentType: 'text/plain' },
  { id: 'html', label: 'HTML', contentType: 'text/html' },
  { id: 'javascript', label: 'JavaScript', contentType: 'application/javascript' },
]

export function rawContentType(lang: RawLanguage): string {
  return RAW_LANGUAGES.find((l) => l.id === lang)?.contentType ?? 'text/plain'
}

export function emptyBody(): BodyDraft {
  return {
    kind: 'none',
    raw: '',
    rawLanguage: 'json',
    formData: ensureTrailingEmpty([]),
    urlEncoded: ensureTrailingEmpty([]),
    binaryPath: '',
  }
}

export function emptyOAuth2(): OAuth2Draft {
  return {
    grantType: 'authorization_code_with_pkce',
    authUrl: '',
    accessTokenUrl: '',
    clientId: '',
    clientSecret: '',
    scope: '',
    state: '',
    redirectUri: '',
    username: '',
    password: '',
    challengeAlgorithm: 'S256',
    codeVerifier: '',
    clientAuthentication: 'header',
    addTokenTo: 'header',
    headerPrefix: 'Bearer',
    tokenName: '',
    refreshTokenUrl: '',
    audience: '',
    resource: '',
    extra: [],
  }
}

export function emptyAuth(): AuthDraft {
  return {
    kind: 'none',
    basic: { username: '', password: '' },
    bearer: { token: '' },
    apiKey: { key: '', value: '', addTo: 'header' },
    oauth2: emptyOAuth2(),
  }
}

export function newDraft(partial: Partial<RequestDraft> = {}): RequestDraft {
  return {
    name: 'New Request',
    method: 'GET',
    url: '',
    description: '',
    params: ensureTrailingEmpty([]),
    headers: ensureTrailingEmpty([]),
    body: emptyBody(),
    auth: emptyAuth(),
    timeoutMs: null,
    extras: {},
    ...partial,
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))

function descriptionText(v: unknown): string {
  if (typeof v === 'string') return v
  if (isObj(v) && typeof v.content === 'string') return v.content
  return ''
}

function rowsFromList(list: unknown): KvRow[] {
  if (!Array.isArray(list)) return []
  const rows: KvRow[] = []
  for (const item of list) {
    if (typeof item === 'string') {
      const i = item.indexOf(':')
      rows.push(newRow({ key: (i >= 0 ? item.slice(0, i) : item).trim(), value: i >= 0 ? item.slice(i + 1).trim() : '' }))
      continue
    }
    if (!isObj(item)) continue
    const type = item.type === 'file' ? 'file' : 'text'
    const src = Array.isArray(item.src) ? str(item.src[0]) : str(item.src)
    rows.push(
      newRow({
        key: str(item.key),
        value: str(item.value),
        enabled: !item.disabled,
        description: descriptionText(item.description),
        kind: type,
        filePath: type === 'file' ? src : '',
      }),
    )
  }
  return rows
}

function guessRawLanguage(raw: string, declared?: string): RawLanguage {
  const d = declared?.toLowerCase()
  if (d === 'json' || d === 'xml' || d === 'html' || d === 'javascript' || d === 'text') return d
  const t = raw.trim()
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      JSON.parse(t)
      return 'json'
    } catch {
      /* not JSON */
    }
  }
  return 'text'
}

export function parseBody(body: unknown): BodyDraft {
  const out = emptyBody()
  if (body == null) return out
  if (!isObj(body)) return { ...out, kind: 'unsupported', preserved: body }
  switch (body.mode) {
    case undefined:
    case 'none':
      return out
    case 'raw': {
      const raw = str(body.raw)
      const opts = isObj(body.options) && isObj(body.options.raw) ? str(body.options.raw.language) : undefined
      return { ...out, kind: 'raw', raw, rawLanguage: guessRawLanguage(raw, opts) }
    }
    case 'formdata':
      return { ...out, kind: 'formData', formData: ensureTrailingEmpty(rowsFromList(body.formdata)) }
    case 'urlencoded':
      return { ...out, kind: 'urlEncoded', urlEncoded: ensureTrailingEmpty(rowsFromList(body.urlencoded)) }
    case 'file': {
      const f = isObj(body.file) ? str(body.file.src) : ''
      return { ...out, kind: 'binary', binaryPath: f }
    }
    default:
      return { ...out, kind: 'unsupported', preserved: body }
  }
}

function attr(list: unknown, key: string): string {
  if (!Array.isArray(list)) return ''
  const found = list.find((a) => isObj(a) && a.key === key)
  return isObj(found) ? str(found.value) : ''
}

/** Postman `oauth2` key -> OAuth2Draft field, for the plain string fields. */
const OAUTH2_STRING_FIELDS = {
  grant_type: 'grantType',
  authUrl: 'authUrl',
  accessTokenUrl: 'accessTokenUrl',
  clientId: 'clientId',
  clientSecret: 'clientSecret',
  scope: 'scope',
  state: 'state',
  redirect_uri: 'redirectUri',
  username: 'username',
  password: 'password',
  code_verifier: 'codeVerifier',
  headerPrefix: 'headerPrefix',
  tokenName: 'tokenName',
  refreshTokenUrl: 'refreshTokenUrl',
  audience: 'audience',
  resource: 'resource',
} as const satisfies Record<string, keyof OAuth2Draft>
const OAUTH2_ENUM_KEYS = new Set(['challengeAlgorithm', 'client_authentication', 'addTokenTo'])

/** Postman's `oauth2` parameters (v2.1 array or v2.0 object), without tokens (see shared/oauth2.ts). */
export function parseOAuth2(params: unknown): OAuth2Draft {
  const out = { ...emptyOAuth2(), grantType: '' }
  const stripped = stripOAuth2TokensFromItem({ auth: { type: 'oauth2', oauth2: params } }).auth.oauth2
  const entries: Array<Record<string, unknown>> = Array.isArray(stripped)
    ? stripped.filter(isObj)
    : isObj(stripped)
      ? Object.entries(stripped).map(([key, value]) => ({ key, value }))
      : []
  let prefixSeen = false
  for (const e of entries) {
    const key = str(e.key)
    if (Object.hasOwn(OAUTH2_STRING_FIELDS, key)) {
      const field = OAUTH2_STRING_FIELDS[key as keyof typeof OAUTH2_STRING_FIELDS]
      out[field] = str(e.value)
      if (key === 'headerPrefix') prefixSeen = true
    } else if (key === 'challengeAlgorithm') out.challengeAlgorithm = str(e.value) === 'plain' ? 'plain' : 'S256'
    else if (key === 'client_authentication') out.clientAuthentication = str(e.value) === 'body' ? 'body' : 'header'
    else if (key === 'addTokenTo') out.addTokenTo = str(e.value) === 'queryParams' ? 'queryParams' : 'header'
    else out.extra.push(e)
  }
  // Postman omits headerPrefix when it is the default.
  if (!prefixSeen) out.headerPrefix = 'Bearer'
  if (!out.grantType) out.grantType = 'authorization_code'
  return out
}

export function parseAuth(auth: unknown): AuthDraft {
  const out = emptyAuth()
  if (!isObj(auth)) return out
  switch (auth.type) {
    case undefined:
    case 'noauth':
    case 'none':
      return out
    case 'basic':
      out.kind = 'basic'
      out.basic = { username: attr(auth.basic, 'username'), password: attr(auth.basic, 'password') }
      return out
    case 'bearer':
      out.kind = 'bearer'
      out.bearer = { token: attr(auth.bearer, 'token') }
      return out
    case 'apikey':
      out.kind = 'apiKey'
      out.apiKey = {
        key: attr(auth.apikey, 'key'),
        value: attr(auth.apikey, 'value'),
        addTo: attr(auth.apikey, 'in') === 'query' ? 'query' : 'header',
      }
      return out
    case 'oauth2':
      out.kind = 'oauth2'
      out.oauth2 = parseOAuth2(auth.oauth2)
      return out
    default:
      out.kind = 'unsupported'
      out.unsupportedType = str(auth.type)
      out.preserved = auth
      return out
  }
}

const OWN_KEYS = new Set(['name', 'method', 'url', 'description', 'headers', 'body', 'auth', 'params'])

function seedParams(doc: Json, url: string): KvRow[] {
  let prev: KvRow[] = rowsFromList(doc.params)
  // Only imports (no `params` key at all) fall back to Postman's query entries; once we
  // have saved our own list — even an empty one — it is authoritative.
  if (Array.isArray(doc.params)) return mergeParamsFromUrl(url, prev)
  // Postman imports keep disabled query params (and every param's description) only inside source.request.url.query.
  const source = isObj(doc.source) && isObj(doc.source.request) && isObj(doc.source.request.url) ? doc.source.request.url : null
  const q = source && Array.isArray(source.query) ? source.query.filter(isObj) : []
  prev = rowsFromList(q.filter((p) => p.disabled))
  const rows = mergeParamsFromUrl(url, prev)
  // Enabled params come from the URL; give each the description of the first same-named Postman entry.
  const descriptions = new Map<string, string>()
  for (const p of q) {
    const text = p.disabled ? '' : descriptionText(p.description)
    if (text && !descriptions.has(str(p.key))) descriptions.set(str(p.key), text)
  }
  return rows.map((r) => (r.enabled && !r.description && descriptions.has(r.key) ? { ...r, description: descriptions.get(r.key)! } : r))
}

export function parseDocument(request: Pick<ApiRequest, 'name' | 'method' | 'url' | 'documentJson'>): RequestDraft {
  let doc: Json = {}
  try {
    const parsed = JSON.parse(request.documentJson || '{}')
    if (isObj(parsed)) doc = parsed
  } catch {
    /* corrupt document: fall back to the columns */
  }
  const url = typeof doc.url === 'string' ? doc.url : request.url
  const extras: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(doc)) if (!OWN_KEYS.has(k)) extras[k] = v
  // The raw Postman item kept by the importer must not carry an OAuth 2.0 token either (older imports did).
  if (isObj(extras.source)) extras.source = stripOAuth2TokensFromItem(extras.source)
  const settings = isObj(doc.settings) ? doc.settings : {}
  return {
    name: request.name,
    method: (str(doc.method) || request.method || 'GET').toUpperCase(),
    url,
    description: descriptionText(doc.description),
    descriptionSource: doc.description,
    params: seedParams(doc, url),
    headers: ensureTrailingEmpty(rowsFromList(doc.headers)),
    body: parseBody(doc.body),
    auth: parseAuth(doc.auth),
    timeoutMs: typeof settings.timeoutMs === 'number' ? settings.timeoutMs : null,
    extras,
  }
}

// ---------------------------------------------------------------------------
// Serialising
// ---------------------------------------------------------------------------

function rowsToList(rows: KvRow[], withFiles = false): Json[] {
  return dataRows(rows).map((r) => {
    const o: Json = { key: r.key, value: r.value }
    if (withFiles) {
      o.type = r.kind
      if (r.kind === 'file') {
        o.src = r.filePath
        o.value = ''
      }
    } else {
      o.type = 'text'
    }
    if (!r.enabled) o.disabled = true
    if (r.description) o.description = r.description
    return o
  })
}

export function serializeBody(b: BodyDraft): unknown {
  switch (b.kind) {
    case 'none':
      return null
    case 'raw':
      return { mode: 'raw', raw: b.raw, options: { raw: { language: b.rawLanguage } } }
    case 'formData':
      return { mode: 'formdata', formdata: rowsToList(b.formData, true) }
    case 'urlEncoded':
      return { mode: 'urlencoded', urlencoded: rowsToList(b.urlEncoded) }
    case 'binary':
      return { mode: 'file', file: { src: b.binaryPath } }
    case 'unsupported':
      return b.preserved ?? null
  }
}

const attrList = (pairs: [string, string][]) => pairs.map(([key, value]) => ({ key, value, type: 'string' }))

/** Postman's `oauth2` array: the settings Slinger edits (empty optional ones left out), then the preserved entries. No tokens. */
export function serializeOAuth2(o: OAuth2Draft): Array<Record<string, unknown>> {
  const pairs: [string, string][] = [
    ['grant_type', o.grantType],
    ['authUrl', o.authUrl],
    ['accessTokenUrl', o.accessTokenUrl],
    ['clientId', o.clientId],
    ['clientSecret', o.clientSecret],
    ['scope', o.scope],
    ['state', o.state],
    ['redirect_uri', o.redirectUri],
    ['username', o.username],
    ['password', o.password],
    ['challengeAlgorithm', o.challengeAlgorithm],
    ['code_verifier', o.codeVerifier],
    ['client_authentication', o.clientAuthentication],
    ['addTokenTo', o.addTokenTo],
    ['headerPrefix', o.headerPrefix],
    ['tokenName', o.tokenName],
    ['refreshTokenUrl', o.refreshTokenUrl],
    ['audience', o.audience],
    ['resource', o.resource],
  ]
  const kept = pairs.filter(([key, value]) => value !== '' || key === 'headerPrefix' || OAUTH2_ENUM_KEYS.has(key))
  const own = new Set(kept.map(([k]) => k))
  return [...attrList(kept), ...o.extra.filter((e) => !own.has(str(e.key)))]
}

export function serializeAuth(a: AuthDraft): unknown {
  switch (a.kind) {
    case 'none':
      return null
    case 'basic':
      return { type: 'basic', basic: attrList([['username', a.basic.username], ['password', a.basic.password]]) }
    case 'bearer':
      return { type: 'bearer', bearer: attrList([['token', a.bearer.token]]) }
    case 'apiKey':
      return {
        type: 'apikey',
        apikey: attrList([['key', a.apiKey.key], ['value', a.apiKey.value], ['in', a.apiKey.addTo]]),
      }
    case 'oauth2':
      return { type: 'oauth2', oauth2: serializeOAuth2(a.oauth2) }
    case 'unsupported':
      return a.preserved ?? null
  }
}

export interface SerializedRequest {
  name: string
  method: string
  url: string
  documentJson: string
}

export function serializeDraft(d: RequestDraft): SerializedRequest {
  const name = d.name.trim() || 'Untitled Request'
  const doc: Json = { ...d.extras }
  doc.name = name
  doc.method = d.method
  doc.url = d.url
  doc.description = writeDescription(d.descriptionSource, d.description)
  doc.headers = rowsToList(d.headers)
  doc.body = serializeBody(d.body)
  doc.auth = serializeAuth(d.auth)
  doc.params = rowsToList(dataRows(d.params))
  // Keep any other Postman request settings (followRedirects...) and only own `timeoutMs`.
  const settings: Json = isObj(d.extras.settings) ? { ...d.extras.settings } : {}
  if (d.timeoutMs != null) settings.timeoutMs = d.timeoutMs
  else delete settings.timeoutMs
  if (Object.keys(settings).length > 0) doc.settings = settings
  else delete doc.settings
  return { name, method: d.method, url: d.url, documentJson: JSON.stringify(doc) }
}

/** Canonical string used for dirty checks. */
export function draftFingerprint(d: RequestDraft): string {
  const s = serializeDraft(d)
  return `${s.name}\u0000${s.method}\u0000${s.url}\u0000${s.documentJson}`
}

/** Every string that may contain `{{templates}}`, for unresolved-variable checks. */
export function templateTexts(d: RequestDraft): string[] {
  const out: string[] = [d.url]
  for (const h of dataRows(d.headers)) if (h.enabled) out.push(h.key, h.value)
  const b = d.body
  if (b.kind === 'raw') out.push(b.raw)
  if (b.kind === 'urlEncoded') for (const r of dataRows(b.urlEncoded)) if (r.enabled) out.push(r.key, r.value)
  if (b.kind === 'formData') for (const r of dataRows(b.formData)) if (r.enabled) out.push(r.key, r.kind === 'file' ? '' : r.value)
  const a = d.auth
  if (a.kind === 'basic') out.push(a.basic.username, a.basic.password)
  if (a.kind === 'bearer') out.push(a.bearer.token)
  if (a.kind === 'apiKey') out.push(a.apiKey.key, a.apiKey.value)
  if (a.kind === 'oauth2') out.push(...oauth2TemplateTexts(a.oauth2))
  return out
}

/**
 * The OAuth 2.0 settings that must resolve before a send: the ones that identify the stored token (its key is a hash
 * of them), the credentials an automatic refresh needs, and the header prefix. Grant-specific fields only count for
 * their grant, so an unused `{{variable}}` never blocks a send.
 */
export function oauth2TemplateTexts(o: OAuth2Draft): string[] {
  return [...oauth2IdentityTexts(o), o.clientSecret, o.refreshTokenUrl, o.headerPrefix]
}

/** The settings the stored token's key is derived from (main: `oauth2TokenKey`). */
export function oauth2IdentityTexts(o: OAuth2Draft): string[] {
  const out = [o.accessTokenUrl, o.clientId, o.scope, o.audience, o.resource]
  if (o.grantType === 'authorization_code' || o.grantType === 'authorization_code_with_pkce') out.push(o.authUrl)
  if (o.grantType === 'password_credentials') out.push(o.username)
  return out
}
