/**
 * Resolving a request's OAuth 2.0 settings for the Authorization tab (status, Get New Access Token, Refresh), the same
 * way a send does: environment > collection variables > globals of this session, secrets revealed just in time and
 * only those the purpose needs. Pre-request scripts do not run for these actions.
 */
import type { OAuth2Config } from '../../../shared/types'
import { scopeStore } from '../../app/scope.svelte'
import { api, errorInfo } from '../../lib/ipc'
import { isSupportedGrant, oauth2TextsFor, resolveOAuth2Config, unsupportedGrantMessage, type OAuth2Purpose } from '../../lib/oauth2'
import { leftoverMessage, templateResolver, unresolvedMessage } from '../../lib/prepare'
import type { OAuth2Draft } from '../../lib/request'
import { scopeWithScriptVariables } from '../../lib/scripts'
import { findSecretsUsed, findUnresolved } from '../../lib/template'
import { sessionVars } from '../scripts/sessionVars'

export type ResolvedOAuth2 = { ok: true; config: OAuth2Config } | { ok: false; error: string }

export async function resolveOAuth2(o: OAuth2Draft, ctx: { workspaceId: string; collectionId: string | null }, purpose: OAuth2Purpose): Promise<ResolvedOAuth2> {
  if (!isSupportedGrant(o.grantType)) return { ok: false, error: unsupportedGrantMessage(o.grantType) }
  const scope = scopeWithScriptVariables(scopeStore.scope, {
    globals: sessionVars.globals(ctx.workspaceId),
    collection: sessionVars.collection(ctx.collectionId),
    local: {},
  })
  const texts = oauth2TextsFor(o, purpose)
  const unresolved = findUnresolved(texts, scope)
  if (unresolved.length > 0) return { ok: false, error: unresolvedMessage(unresolved) }
  const secrets = new Map<string, string>()
  try {
    for (const v of findSecretsUsed(texts, scope)) if (v.id) secrets.set(v.key, await api().revealEnvironmentVariable(v.id))
  } catch (e) {
    return { ok: false, error: `Could not read a secret variable: ${errorInfo(e).message}` }
  }
  const { resolve, leftover } = templateResolver({ scope, secrets })
  const config = resolveOAuth2Config(o, ctx.workspaceId, resolve, purpose)
  if (leftover.size > 0) return { ok: false, error: leftoverMessage([...leftover]) }
  return { ok: true, config }
}
