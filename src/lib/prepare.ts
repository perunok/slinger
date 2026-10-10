/**
 * Turns an editable draft into the resolved `HttpRequestInput` sent over IPC (`prepareMcp`: the resolved connect and
 * call inputs of an MCP request). The single place where templates are applied, so single send, runner and
 * code snippets all behave identically.
 */
import type { HttpRequestInput, McpCallInput, McpConnectInput, OAuth2Config, ResolvedAuth, ResolvedBody } from '../../shared/types'
import { isSupportedGrant, resolveOAuth2Config, unsupportedGrantMessage } from './oauth2'
import { dataRows } from './kv'
import { mcpDisplayUrl } from './mcpRequest'
import { rawContentType, templateTexts, type AuthDraft, type RequestDraft } from './request'
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

/** The history log must never contain secret values: the same resolution as `templateResolver`, but secrets stay `{{name}}`. */
function historyResolver(ctx: Pick<PrepareContext, 'scope' | 'now'>, cache: Map<string, string>) {
  return (t: string) => {
    let cur = t
    for (let i = 0; i < 6 && cur.includes('{{'); i++) {
      const next = resolveTemplate(cur, ctx.scope, { now: ctx.now, builtinCache: cache })
      if (next === cur) break
      cur = next
    }
    return cur
  }
}

type AuthResult = { ok: true; auth: ResolvedAuth; oauth2?: OAuth2Config; warnings: string[] } | { ok: false; error: string }

/** The request's auth, resolved; shared by HTTP sends (main applies it) and MCP sends (applied as headers by `mcpAuthHeaders`). */
function resolveAuth(a: AuthDraft, workspaceId: string, r: (t: string) => string): AuthResult {
  const auth: ResolvedAuth = { kind: 'none' }
  const warnings: string[] = []
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
    if (!isSupportedGrant(a.oauth2.grantType)) return { ok: false, error: unsupportedGrantMessage(a.oauth2.grantType) }
    oauth2 = resolveOAuth2Config(a.oauth2, workspaceId, r, 'send')
    auth.kind = 'oauth2'
    auth.oauth2 = { tokenKey: '', addTo: a.oauth2.addTokenTo === 'queryParams' ? 'query' : 'header', headerPrefix: r(a.oauth2.headerPrefix).trim() }
  } else if (a.kind === 'unsupported') {
    warnings.push(`Auth type "${a.unsupportedType ?? 'custom'}" is not supported; sent without authorization.`)
  }
  return { ok: true, auth, warnings, ...(oauth2 ? { oauth2 } : {}) }
}

export function prepareRequest(draft: RequestDraft, ctx: PrepareContext): PrepareResult {
  const unresolved = findUnresolved(templateTexts(draft), ctx.scope)
  if (unresolved.length > 0 && !ctx.allowUnresolved) {
    return { ok: false, unresolved, error: unresolvedMessage(unresolved, ctx.scope) }
  }
  const cache = new Map<string, string>()
  const { resolve: r, leftover } = templateResolver(ctx, cache)
  const rHistory = historyResolver(ctx, cache)
  const warnings: string[] = []

  let url = normalizeUrl(r(draft.url))
  const historyUrl = normalizeUrl(rHistory(draft.url))
  if (!url) return { ok: false, unresolved: [], error: 'Enter a URL to send the request.' }

  const headers = dataRows(draft.headers)
    .filter((h) => h.enabled && h.key.trim())
    .map((h) => ({ key: r(h.key).trim(), value: r(h.value) }))

  // Auth
  const resolvedAuth = resolveAuth(draft.auth, ctx.workspaceId, r)
  if (!resolvedAuth.ok) return { ok: false, unresolved: [], error: resolvedAuth.error }
  const { auth, oauth2 } = resolvedAuth
  warnings.push(...resolvedAuth.warnings)
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

// ---------------------------------------------------------------------------
// MCP requests
// ---------------------------------------------------------------------------

export type McpPreparedConnect = Omit<McpConnectInput, 'workspaceId' | 'origin'>
export type McpPreparedCall = Omit<McpCallInput, 'sessionId' | 'requestRunId' | 'workspaceId' | 'requestId' | 'requestName' | 'historySource'>

/**
 * The OAuth 2.0 part of an MCP request's auth: main keeps the token, so the caller looks it up with `config`
 * (refreshOAuth2Token ifExpiring), reveals it and adds it to the connect input with `withMcpOAuth2Token`.
 */
export interface McpOAuth2 {
  config: OAuth2Config
  addTo: 'header' | 'query'
  headerPrefix: string
}

/** The longest call timeout main accepts (ms). */
export const MCP_MAX_TIMEOUT_MS = 600_000

export type PrepareMcpResult =
  /**
   * `target`: what ran as shown to the user (tool or prompt name, or the resource URI with secrets left as `{{name}}`);
   * `call.historyDetail` is the operation and that target.
   */
  | { ok: true; connect: McpPreparedConnect; call: McpPreparedCall; historyUrl: string; target: string; warnings: string[]; oauth2?: McpOAuth2 }
  | { ok: false; error: string; unresolved: string[] }

const base64Utf8 = (text: string): string => {
  let bin = ''
  for (const byte of new TextEncoder().encode(text)) bin += String.fromCharCode(byte)
  return btoa(bin)
}

/** Sets a header like `Headers.set` does (replacing any of the same name, case-insensitively). */
function setHeader(headers: Array<{ key: string; value: string }>, key: string, value: string): Array<{ key: string; value: string }> {
  const lower = key.toLowerCase()
  return [...headers.filter((h) => h.key.toLowerCase() !== lower), { key, value }]
}

/**
 * Resolves `{{templates}}` in JSON text: inside string literals the value is JSON-escaped (a variable holding quotes or
 * newlines keeps the JSON valid); elsewhere it is inserted as-is, so a bare `{{n}}` becomes a number, boolean or object.
 */
export function resolveJsonTemplates(text: string, r: (t: string) => string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const quote = text.indexOf('"', i)
    if (quote < 0) {
      out += r(text.slice(i))
      break
    }
    out += r(text.slice(i, quote))
    let end = quote + 1
    while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1
    if (end >= text.length) {
      // Unterminated string: left to JSON.parse to report.
      out += r(text.slice(quote))
      break
    }
    const literal = text.slice(quote, end + 1)
    let decoded: string | null = null
    try {
      decoded = JSON.parse(literal) as string
    } catch {
      /* invalid escape: JSON.parse of the whole text reports it */
    }
    out += decoded === null ? r(literal) : decoded.includes('{{') ? JSON.stringify(r(decoded)) : literal
    i = end + 1
  }
  return out
}

/**
 * Resolves an MCP request: the transport's connect input (http/sse: URL, headers and the auth as headers exactly as main
 * applies it to HTTP sends; stdio: command, args, env, cwd) and the call input. Unresolved variables are reported like
 * `prepareRequest` reports them. `historyUrl` is the display URL (server URL or command line) with secrets left as `{{name}}`.
 */
export function prepareMcp(draft: RequestDraft, ctx: Omit<PrepareContext, 'allowUnresolved'>): PrepareMcpResult {
  const m = draft.mcp
  if (!m) return { ok: false, unresolved: [], error: 'This is not an MCP request.' }
  const unresolved = findUnresolved(templateTexts(draft), ctx.scope)
  if (unresolved.length > 0) return { ok: false, unresolved, error: unresolvedMessage(unresolved, ctx.scope) }
  const cache = new Map<string, string>()
  const { resolve: r, leftover } = templateResolver(ctx, cache)
  const rHistory = historyResolver(ctx, cache)
  const warnings: string[] = []
  const invalid = (error: string): PrepareMcpResult => ({ ok: false, unresolved: [], error })

  let connect: McpPreparedConnect
  let historyUrl: string
  let oauth2: McpOAuth2 | undefined
  if (m.transport === 'stdio') {
    const command = r(m.command).trim()
    if (!command) return invalid('Enter the command that starts the MCP server.')
    connect = {
      transport: 'stdio',
      command,
      args: m.args.map((a) => r(a)),
      env: dataRows(m.env)
        .filter((e) => e.enabled && e.key.trim())
        .map((e) => ({ key: e.key.trim(), value: r(e.value) })),
      cwd: r(m.cwd).trim(),
    }
    historyUrl = rHistory(mcpDisplayUrl({ ...draft, mcp: { ...m, command: m.command.trim() } }))
  } else {
    let url = normalizeUrl(r(draft.url))
    if (!url) return invalid('Enter the URL of the MCP server.')
    historyUrl = normalizeUrl(rHistory(draft.url))
    let headers = dataRows(draft.headers)
      .filter((h) => h.enabled && h.key.trim())
      .map((h) => ({ key: r(h.key).trim(), value: r(h.value) }))
    const resolvedAuth = resolveAuth(draft.auth, ctx.workspaceId, r)
    if (!resolvedAuth.ok) return invalid(resolvedAuth.error)
    warnings.push(...resolvedAuth.warnings)
    const { auth } = resolvedAuth
    if (auth.kind === 'basic' && auth.basic) {
      headers = setHeader(headers, 'Authorization', `Basic ${base64Utf8(`${auth.basic.username}:${auth.basic.password}`)}`)
    } else if (auth.kind === 'bearer' && auth.bearer?.token) {
      headers = setHeader(headers, 'Authorization', `Bearer ${auth.bearer.token}`)
    } else if (auth.kind === 'apiKey' && auth.apiKey) {
      if (auth.apiKey.addTo === 'query') url = appendQuery(url, auth.apiKey.key, auth.apiKey.value)
      else headers = setHeader(headers, auth.apiKey.key, auth.apiKey.value)
    } else if (auth.kind === 'oauth2' && auth.oauth2 && resolvedAuth.oauth2) {
      oauth2 = { config: resolvedAuth.oauth2, addTo: auth.oauth2.addTo, headerPrefix: auth.oauth2.headerPrefix }
    }
    connect = { transport: m.transport, url, headers }
  }

  const call: McpPreparedCall = { operation: m.operation, historyUrl }
  // A stored timeout above main's limit (older or hand-edited requests) runs with the limit instead of failing.
  if (m.timeoutMs !== null) call.timeoutMs = Math.min(m.timeoutMs, MCP_MAX_TIMEOUT_MS)
  let target: string
  if (m.operation === 'tools/call') {
    const name = m.tool.trim()
    if (!name) return invalid('Choose a tool to call.')
    const text = resolveJsonTemplates(m.arguments, r).trim()
    let args: unknown = {}
    if (text) {
      try {
        args = JSON.parse(text)
      } catch (e) {
        return invalid(`The tool arguments are not valid JSON: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return invalid('The tool arguments must be a JSON object.')
    call.name = name
    call.arguments = args as Record<string, unknown>
    target = name
  } else if (m.operation === 'resources/read') {
    const uri = r(m.uri).trim()
    if (!uri) return invalid('Enter the URI of the resource to read.')
    call.uri = uri
    target = rHistory(m.uri).trim()
  } else {
    const name = m.prompt.trim()
    if (!name) return invalid('Choose a prompt to get.')
    const args: Record<string, string> = {}
    for (const row of dataRows(m.promptArguments)) if (row.enabled && row.key.trim()) args[row.key.trim()] = r(row.value)
    call.name = name
    call.arguments = args
    target = name
  }
  call.historyDetail = `${m.operation} ${target}`

  if (leftover.size > 0) {
    const names = [...leftover]
    return { ok: false, unresolved: names, error: leftoverMessage(names) }
  }
  return { ok: true, connect, call, historyUrl, target, warnings, ...(oauth2 ? { oauth2 } : {}) }
}

/** Adds a revealed OAuth 2.0 access token to an MCP connect input, as main does for HTTP sends. */
export function withMcpOAuth2Token(connect: McpPreparedConnect, oauth2: McpOAuth2, token: string): McpPreparedConnect {
  if (oauth2.addTo === 'query') return { ...connect, url: appendQuery(connect.url ?? '', 'access_token', token) }
  const value = oauth2.headerPrefix ? `${oauth2.headerPrefix} ${token}` : token
  return { ...connect, headers: setHeader(connect.headers ?? [], 'Authorization', value) }
}
