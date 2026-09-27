/**
 * Turns an editable draft into the resolved `HttpRequestInput` sent over IPC.
 * The single place where templates are applied, so single send, runner and
 * code snippets all behave identically.
 */
import type { HttpRequestInput, OAuth2Config, ResolvedAuth, ResolvedBody } from '../../shared/types'
import { isSupportedGrant, resolveOAuth2Config, unsupportedGrantMessage } from './oauth2'
import { dataRows } from './kv'
import { rawContentType, templateTexts, type RequestDraft } from './request'
import { findSecretsUsed, findUnresolved, parseTokens, resolveTemplate, scopesChecked, type TemplateScope, type VariableInfo } from './template'
import { encodeQueryPart, splitUrl } from './urlParams'

export type PrepareResult =
  /**
   * `oauth2`: the request's resolved OAuth 2.0 settings. The caller looks the token up with them
   * (refreshOAuth2Token ifExpiring) and puts the returned key into `input.auth.oauth2.tokenKey`, which is '' here.
   */
  | { ok: true; input: HttpRequestInput; warnings: string[]; oauth2?: OAuth2Config }
  | { ok: false; error: string; unresolved: string[] }

export interface PrepareContext {
  workspaceId: string
  requestId?: string | null
  scope: TemplateScope
  /** Real values of secret variables, keyed by variable name. */
  secrets?: ReadonlyMap<string, string>
  /** When true, unresolved variables are left verbatim instead of failing (used for snippets). */
  allowUnresolved?: boolean
  now?: Date
}

/** Secret variables referenced by the draft (their values must be revealed before `prepareRequest`). */
export function secretsNeeded(draft: RequestDraft, scope: TemplateScope): VariableInfo[] {
  return findSecretsUsed(templateTexts(draft), scope)
}

export function unresolvedIn(draft: RequestDraft, scope: TemplateScope): string[] {
  return findUnresolved(templateTexts(draft), scope)
}

export function normalizeUrl(url: string): string {
  const t = url.trim()
  if (!t) return t
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(t) ? t : `http://${t}`
}

function appendQuery(url: string, key: string, value: string): string {
  const { base, query, hash } = splitUrl(url)
  const pair = `${encodeQueryPart(key)}=${encodeQueryPart(value)}`
  return `${base}?${query ? `${query}&` : ''}${pair}${hash !== null ? `#${hash}` : ''}`
}

/** With the scope, names the scopes that were checked (globals, collection variables, environment). */
export const unresolvedMessage = (unresolved: string[], scope?: TemplateScope): string =>
  `Unresolved variable${unresolved.length > 1 ? 's' : ''}: ${unresolved.map((n) => `{{${n}}}`).join(', ')}. ` +
  (scope ? `Not defined in ${scopesChecked(scope)}.` : `Define ${unresolved.length > 1 ? 'them' : 'it'} in the active environment.`)

export const leftoverMessage = (names: string[]): string =>
  `Could not fully resolve ${names.map((n) => `{{${n}}}`).join(', ')} (undefined, or defined in terms of itself).`

/**
 * The resolver `prepareRequest` uses, for other callers that resolve templates the same way (OAuth 2.0 settings):
 * values may reference other variables ({{a}} = "{{b}}/x"), so it resolves until stable (bounded, so circular
 * definitions terminate) and remembers in `leftover` any token that survives.
 */
export function templateResolver(ctx: Pick<PrepareContext, 'scope' | 'secrets' | 'now'>, cache = new Map<string, string>()) {
  const leftover = new Set<string>()
  const resolve = (t: string) => {
    let cur = t
    for (let i = 0; i < 6 && cur.includes('{{'); i++) {
      const next = resolveTemplate(cur, ctx.scope, { secrets: ctx.secrets, now: ctx.now, builtinCache: cache })
      if (next === cur) break
      cur = next
    }
    for (const tok of parseTokens(cur)) leftover.add(tok.name)
    return cur
  }
  return { resolve, leftover }
}

export function prepareRequest(draft: RequestDraft, ctx: PrepareContext): PrepareResult {
  const unresolved = findUnresolved(templateTexts(draft), ctx.scope)
  if (unresolved.length > 0 && !ctx.allowUnresolved) {
    return { ok: false, unresolved, error: unresolvedMessage(unresolved, ctx.scope) }
  }
  const cache = new Map<string, string>()
  const { resolve: r, leftover } = templateResolver(ctx, cache)
  // The history log must never contain secret values: same resolution, but secrets stay `{{name}}`.
  const rHistory = (t: string) => {
    let cur = t
    for (let i = 0; i < 6 && cur.includes('{{'); i++) {
      const next = resolveTemplate(cur, ctx.scope, { now: ctx.now, builtinCache: cache })
      if (next === cur) break
      cur = next
    }
    return cur
  }
  const warnings: string[] = []

  let url = normalizeUrl(r(draft.url))
  const historyUrl = normalizeUrl(rHistory(draft.url))
  if (!url) return { ok: false, unresolved: [], error: 'Enter a URL to send the request.' }

  const headers = dataRows(draft.headers)
    .filter((h) => h.enabled && h.key.trim())
    .map((h) => ({ key: r(h.key).trim(), value: r(h.value) }))

  // Auth
  const a = draft.auth
  const auth: ResolvedAuth = { kind: 'none' }
  let oauth2: OAuth2Config | undefined
  if (a.kind === 'basic') {
    auth.kind = 'basic'
    auth.basic = { username: r(a.basic.username), password: r(a.basic.password) }
  } else if (a.kind === 'bearer') {
    auth.kind = 'bearer'
    auth.bearer = { token: r(a.bearer.token).trim() }
  } else if (a.kind === 'apiKey') {
    const key = r(a.apiKey.key).trim()
    if (key) {
      auth.kind = 'apiKey'
      auth.apiKey = { key, value: r(a.apiKey.value), addTo: a.apiKey.addTo }
    }
  } else if (a.kind === 'oauth2') {
    if (!isSupportedGrant(a.oauth2.grantType)) return { ok: false, unresolved: [], error: unsupportedGrantMessage(a.oauth2.grantType) }
    oauth2 = resolveOAuth2Config(a.oauth2, ctx.workspaceId, r, 'send')
    auth.kind = 'oauth2'
    auth.oauth2 = { tokenKey: '', addTo: a.oauth2.addTokenTo === 'queryParams' ? 'query' : 'header', headerPrefix: r(a.oauth2.headerPrefix).trim() }
  } else if (a.kind === 'unsupported') {
    warnings.push(`Auth type "${a.unsupportedType ?? 'custom'}" is not supported; sent without authorization.`)
  }
  if (auth.kind === 'apiKey' && auth.apiKey?.addTo === 'query') {
    // Keep the contract honest: query placement is applied here so main only needs to handle headers.
    url = appendQuery(url, auth.apiKey.key, auth.apiKey.value)
    auth.kind = 'none'
    delete auth.apiKey
  }

  // Body
  const b = draft.body
  const body: ResolvedBody = { mode: 'none' }
  if (b.kind === 'raw') {
    body.mode = 'raw'
    body.raw = { content: r(b.raw), contentType: rawContentType(b.rawLanguage) }
  } else if (b.kind === 'urlEncoded') {
    body.mode = 'urlEncoded'
    body.urlEncoded = dataRows(b.urlEncoded)
      .filter((f) => f.enabled && f.key.trim())
      .map((f) => ({ key: r(f.key), value: r(f.value), enabled: true }))
  } else if (b.kind === 'formData') {
    body.mode = 'formData'
    const fields = []
    for (const f of dataRows(b.formData)) {
      if (!f.enabled || !f.key.trim()) continue
      if (f.kind === 'file') {
        if (!f.filePath) return { ok: false, unresolved: [], error: `Form field "${f.key}" is a file field but no file was chosen.` }
        fields.push({ key: r(f.key), value: '', type: 'file' as const, filePath: f.filePath, enabled: true })
      } else {
        fields.push({ key: r(f.key), value: r(f.value), type: 'text' as const, enabled: true })
      }
    }
    body.formData = fields
  } else if (b.kind === 'binary') {
    if (!b.binaryPath) return { ok: false, unresolved: [], error: 'Choose a file for the binary body.' }
    body.mode = 'binary'
    body.binaryFilePath = b.binaryPath
  } else if (b.kind === 'unsupported') {
    warnings.push('This request has a body type Slinger cannot edit; it is sent without a body.')
  }

  if (leftover.size > 0 && !ctx.allowUnresolved) {
    const names = [...leftover]
    return { ok: false, unresolved: names, error: leftoverMessage(names) }
  }

  return {
    ok: true,
    warnings,
    ...(oauth2 ? { oauth2 } : {}),
    input: {
      method: draft.method.toUpperCase(),
      url,
      headers,
      auth,
      body,
      timeoutMs: draft.timeoutMs ?? undefined,
      requestId: ctx.requestId ?? null,
      requestName: draft.name,
      workspaceId: ctx.workspaceId,
      historyUrl,
    },
  }
}
