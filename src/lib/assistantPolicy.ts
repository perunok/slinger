/**
 * What an AI assistant (Slinger's MCP server) may send with the user's credentials. The window is the trust boundary:
 * main only ever sees resolved requests, so these checks run in `executeDraft` for sends with `source: 'mcp'`.
 *
 * Policy:
 * - A send is *assistant-controlled* when the assistant wrote what goes out: an ad-hoc request, a saved request sent
 *   with overrides (url, headers, auth, body, scripts, ...), or a saved request whose stored content an assistant
 *   wrote (update_request, create_request, an import or a version restore through MCP) and the user has not saved
 *   since (`assistant_changes`, migration 0019).
 * - An assistant-controlled send never carries the user's credentials: no secret variable, no stored auth (the
 *   request's own literal auth counts only when the assistant created the request or gave it in an ad-hoc send), no
 *   OAuth 2.0 token. Its scripts cannot read secret variables either.
 * - A secret environment variable an assistant set (and the user has not changed since) holds the assistant's own value, so
 *   it does not count as the user's credential.
 * - Environment variables an assistant set (set_variable) and the user has not changed since may not decide where
 *   credentials go: a send with credentials whose URL origin depends on one is refused, and the scripts of any send
 *   in that environment cannot read secrets (a script could build a destination from such a variable).
 * - Everything returned to the assistant has the send's secret values, credentials and tokens replaced.
 */
import type { AssistantChanges } from '../../shared/types'
import type { RequestDraft } from './request'
import { templateTexts } from './request'
import { withDefaultScheme } from '../../shared/urlScheme'
import { findSecretsUsed, resolveTemplate, type TemplateScope, type VariableInfo } from './template'

/** How an MCP send came about (send_request fills it; a run of saved requests leaves it empty). */
export interface AssistantSendInfo {
  /** send_request without request_id: everything in it is the assistant's. */
  adHoc?: boolean
  /** send_request fields given for a saved request (url, headers, auth, ...). */
  overrides?: string[]
  /** The saved request's auth kind before the overrides were applied. */
  savedAuthKind?: string
}

export interface AssistantControl {
  /** Why the assistant controls this send (empty: it is the user's saved request, sent as saved). */
  reasons: string[]
  /** The request's literal auth values are the assistant's own (ad-hoc, or a request it created). */
  ownAuth: boolean
  /** Keys of the variables of the environment in use that an assistant set and the user has not changed since. */
  assistantVariables: Set<string>
}

export function assistantControl(
  info: AssistantSendInfo | undefined,
  changes: AssistantChanges,
  requestId: string | null | undefined,
  environmentId: string | null,
): AssistantControl {
  const reasons: string[] = []
  if (info?.adHoc) reasons.push('it is an ad-hoc request')
  if (info?.overrides?.length) reasons.push(`it is sent with changed ${info.overrides.join(', ')}`)
  const change = requestId ? changes.requests.find((r) => r.requestId === requestId) : undefined
  if (change) reasons.push(`an AI assistant ${change.created ? 'created' : 'changed'} it and the user has not saved it since`)
  const assistantVariables = new Set(environmentId ? changes.variables.filter((v) => v.environmentId === environmentId).map((v) => v.key) : [])
  return { reasons, ownAuth: !!info?.adHoc || (!!change?.created && !info?.overrides?.includes('auth')), assistantVariables }
}

/** The message scripts get when they read a secret in a send the assistant controls; null when they may. */
export function scriptSecretDenial(c: AssistantControl): string | null {
  if (c.reasons.length > 0) return 'not available to scripts of a request an AI assistant wrote or changed. The user can send it from the Slinger window.'
  if (c.assistantVariables.size > 0) {
    return `not available to scripts while variables an AI assistant set (${[...c.assistantVariables].join(', ')}) are unreviewed. The user can send it from the Slinger window, or review those variables there.`
  }
  return null
}

/**
 * What in the draft is the user's credential: stored auth and secret variables (by name). A secret environment variable the
 * assistant set itself (and the user has not changed since) holds the assistant's own value, not the user's.
 */
export function credentialsOf(draft: RequestDraft, scope: TemplateScope, ownAuth: boolean, savedAuthKind?: string, assistantVariables?: ReadonlySet<string>): string[] {
  const out: string[] = []
  const authKind = savedAuthKind ?? draft.auth.kind
  if (draft.auth.kind === 'oauth2' || authKind === 'oauth2') out.push('its OAuth 2.0 token')
  else if (!ownAuth && authKind !== 'none') out.push('its saved authorization')
  const isOwn = (v: VariableInfo) => !!assistantVariables?.has(v.key) && (v.source === undefined || v.source === 'environment')
  const secrets = findSecretsUsed(templateTexts(draft), scope)
    .filter((v) => !isOwn(v))
    .map((v) => `{{${v.key}}}`)
  if (secrets.length) out.push(`the secret variable${secrets.length > 1 ? 's' : ''} ${secrets.join(', ')}`)
  return out
}

const SENTINEL = 'slinger-assistant-set-value'

/**
 * Whether the origin (scheme, host, port) of the draft's URL depends on one of `keys` (environment variables), directly
 * or through other variables: the URL is resolved with those values replaced by a marker.
 */
export function originDependsOn(url: string, scope: TemplateScope, keys: ReadonlySet<string>): string[] {
  const hits: string[] = []
  for (const key of keys) {
    const v = scope.variables.get(key)
    if (!v || (v.source !== undefined && v.source !== 'environment')) continue
    const variables = new Map<string, VariableInfo>(scope.variables)
    variables.set(key, { ...v, secret: false, value: SENTINEL })
    const probe: TemplateScope = { ...scope, variables }
    let resolved = url
    for (let i = 0; i < 6 && resolved.includes('{{'); i++) {
      const next = resolveTemplate(resolved, probe)
      if (next === resolved) break
      resolved = next
    }
    if (!resolved.includes(SENTINEL)) continue
    const withScheme = withDefaultScheme(resolved.trim())
    const m = /^([^:/?#]*:)?\/\/([^/?#]*)/.exec(withScheme)
    const head = m ? `${m[1] ?? ''}//${m[2]}` : withScheme
    if (head.includes(SENTINEL) || !m) hits.push(key)
  }
  return hits
}

/**
 * Why this MCP send is refused (null: allowed). `draft` and `scope` are the ones after the pre-request scripts.
 */
export function refusal(draft: RequestDraft, scope: TemplateScope, c: AssistantControl, savedAuthKind?: string): string | null {
  if (c.reasons.length > 0) {
    const creds = credentialsOf(draft, scope, c.ownAuth, savedAuthKind, c.assistantVariables)
    if (creds.length === 0) return null
    return (
      `“${draft.name}” would carry the user's credentials (${creds.join(' and ')}), and ${c.reasons.join('; ')}. ` +
      'An AI assistant may send a request with credentials only exactly as the user saved it. Send it without overrides, ' +
      'or ask the user to review it and save or send it in Slinger (open_in_app shows it there).'
    )
  }
  if (c.assistantVariables.size > 0 && !draft.mcp) {
    const creds = credentialsOf(draft, scope, false, undefined, c.assistantVariables)
    if (creds.length === 0) return null
    const keys = originDependsOn(draft.url, scope, c.assistantVariables)
    if (keys.length === 0) return null
    return (
      `“${draft.name}” would carry the user's credentials (${creds.join(' and ')}) to a host set by the variable${keys.length > 1 ? 's' : ''} ` +
      `${keys.map((k) => `{{${k}}}`).join(', ')}, which an AI assistant set and the user has not reviewed. ` +
      'Ask the user to check the variable in the environment (editing it there confirms it) or to send the request in Slinger.'
    )
  }
  return null
}

/** Replaces every value (and its URL-encoded form) in `text` with `[hidden]`, longest first. */
export function redactValues(text: string, values: Iterable<string>): string {
  const list = [...new Set([...values].filter((v) => v.length >= 4))].sort((a, b) => b.length - a.length)
  let out = text
  for (const v of list) {
    if (out.includes(v)) out = out.split(v).join('[hidden]')
    const enc = encodeURIComponent(v)
    if (enc !== v && out.includes(enc)) out = out.split(enc).join('[hidden]')
  }
  return out
}
