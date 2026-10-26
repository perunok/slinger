import type { RequestDraft } from '../../lib/request'
import { app } from '../../app/state.svelte'
import { scopeStore } from '../../app/scope.svelte'
import { prepareRequest } from '../../lib/prepare'
import { generateSnippet, mcpInspectorSnippet, prepareMcpSnippet, type SnippetLang } from '../../lib/snippets'
import { copyText } from '../../app/clipboard'
import { withEffectiveAuth } from '../../lib/authInheritance'
import { authChainFor } from './execute'
import { toast } from '../../app/toast.svelte'

/** Where the request lives (its collection and folder give an inherited auth). */
export type SnippetWhere = { collectionId: string | null; folderId?: string | null; requestId: string | null }

export type SnippetResult = { ok: true; snippet: string } | { ok: false; error: string }

/**
 * The code snippet of a request draft, with the active environment (secrets and undefined variables stay as
 * `{{name}}`). MCP requests have one snippet, an MCP Inspector command line; `lang` applies to HTTP requests.
 * Used by the Code panel and the "Copy as cURL" menu entries. An inherited auth is shown as the folder's / collection's,
 * exactly as a send resolves it (`where.folderId`: the request's folder).
 */
export function snippetFor(input: RequestDraft, where: SnippetWhere, lang: SnippetLang): SnippetResult {
  const draft = withEffectiveAuth(input, authChainFor(where.collectionId, where.folderId ?? null))
  const ctx = { workspaceId: app.workspaceId ?? '', requestId: where.requestId, scope: scopeStore.scopeFor(where.collectionId) }
  if (draft.mcp !== undefined) {
    const mcp = prepareMcpSnippet(draft, ctx)
    return mcp.ok ? { ok: true, snippet: mcpInspectorSnippet(mcp.input) } : mcp
  }
  const http = prepareRequest(draft, { ...ctx, allowUnresolved: true })
  return http.ok ? { ok: true, snippet: generateSnippet(lang, http.input) } : http
}

/** "Copy as cURL" of a right-click menu: the same command the Code panel shows for cURL. */
export async function copyAsCurl(draft: RequestDraft, where: SnippetWhere): Promise<void> {
  const r = snippetFor(draft, where, 'curl')
  if (r.ok) await copyText(r.snippet, 'cURL command copied')
  else toast.error('Could not build the cURL command', r.error)
}
