/**
 * Turns an editable draft into the resolved `HttpRequestInput` sent over IPC.
 * The single place where templates are applied, so single send, runner and
 * code snippets all behave identically.
 */
import type { HttpRequestInput, ResolvedAuth, ResolvedBody } from '../../shared/types'
import { dataRows } from './kv'
import { rawContentType, templateTexts, type RequestDraft } from './request'
import { findSecretsUsed, findUnresolved, resolveTemplate, type TemplateScope, type VariableInfo } from './template'
import { encodeQueryPart, splitUrl } from './urlParams'

export type PrepareResult =
  | { ok: true; input: HttpRequestInput; warnings: string[] }
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

export function prepareRequest(draft: RequestDraft, ctx: PrepareContext): PrepareResult {
  const unresolved = findUnresolved(templateTexts(draft), ctx.scope)
  if (unresolved.length > 0 && !ctx.allowUnresolved) {
    return {
      ok: false,
      unresolved,
      error: `Unresolved variable${unresolved.length > 1 ? 's' : ''}: ${unresolved.map((n) => `{{${n}}}`).join(', ')}. Define ${unresolved.length > 1 ? 'them' : 'it'} in the active environment.`,
    }
  }
  const cache = new Map<string, string>()
  const r = (t: string) => resolveTemplate(t, ctx.scope, { secrets: ctx.secrets, now: ctx.now, builtinCache: cache })
  const warnings: string[] = []

  let url = normalizeUrl(r(draft.url))
  if (!url) return { ok: false, unresolved: [], error: 'Enter a URL to send the request.' }

  const headers = dataRows(draft.headers)
    .filter((h) => h.enabled && h.key.trim())
    .map((h) => ({ key: r(h.key).trim(), value: r(h.value) }))

  // Auth
  const a = draft.auth
  const auth: ResolvedAuth = { kind: 'none' }
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

  return {
    ok: true,
    warnings,
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
    },
  }
}
