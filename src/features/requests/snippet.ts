import type { RequestDraft } from '../../lib/request'
import { app } from '../../app/state.svelte'
import { scopeStore } from '../../app/scope.svelte'
import { prepareRequest } from '../../lib/prepare'
import { generateSnippet, mcpInspectorSnippet, prepareMcpSnippet, type SnippetLang } from '../../lib/snippets'
import { copyText } from '../../app/clipboard'
import { toast } from '../../app/toast.svelte'

export type SnippetResult = { ok: true; snippet: string } | { ok: false; error: string }

/**
 * The code snippet of a request draft, with the active environment (secrets and undefined variables stay as
 * `{{name}}`). MCP requests have one snippet, an MCP Inspector command line; `lang` applies to HTTP requests.
 * Used by the Code panel and the "Copy as cURL" menu entries.
 */
export function snippetFor(draft: RequestDraft, where: { collectionId: string | null; requestId: string | null }, lang: SnippetLang): SnippetResult {
  const ctx = { workspaceId: app.workspaceId ?? '', requestId: where.requestId, scope: scopeStore.scopeFor(where.collectionId) }
  if (draft.mcp !== undefined) {
    const mcp = prepareMcpSnippet(draft, ctx)
    return mcp.ok ? { ok: true, snippet: mcpInspectorSnippet(mcp.input) } : mcp
  }
  const http = prepareRequest(draft, { ...ctx, allowUnresolved: true })
  return http.ok ? { ok: true, snippet: generateSnippet(lang, http.input) } : http
}

/** "Copy as cURL" of a right-click menu: the same command the Code panel shows for cURL. */
export async function copyAsCurl(draft: RequestDraft, where: { collectionId: string | null; requestId: string | null }): Promise<void> {
  const r = snippetFor(draft, where, 'curl')
  if (r.ok) await copyText(r.snippet, 'cURL command copied')
  else toast.error('Could not build the cURL command', r.error)
}
