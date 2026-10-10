<script lang="ts">
  import { app } from '../../app/state.svelte'
  import { scopeStore } from '../../app/scope.svelte'
  import { settings } from '../../app/settings.svelte'
  import { toast } from '../../app/toast.svelte'
  import CodeEditor from '../../components/editor/CodeEditor.svelte'
  import Button from '../../components/ui/Button.svelte'
  import { saveExport } from '../../lib/exportFile'
  import { errorInfo } from '../../lib/ipc'
  import { prepareRequest } from '../../lib/prepare'
  import { generateSnippet, MCP_SNIPPET_LANG, mcpInspectorSnippet, prepareMcpSnippet, SNIPPET_LANGS, type SnippetLang } from '../../lib/snippets'
  import { sanitizeFileStem } from '../importexport/fileName'
  import type { RequestTab } from './tabs.svelte'

  /** `idPrefix` keeps element ids unique when the right panel's Code view shows next to the Code section. */
  let { tab, idPrefix = 'snippet' }: { tab: RequestTab; idPrefix?: string } = $props()
  let lang = $state<SnippetLang>('curl')

  // MCP requests have one snippet, an MCP Inspector CLI command line; the HTTP languages do not apply to them.
  const isMcp = $derived(tab.draft.mcp !== undefined)
  // Regenerated on every draft/environment change; built-ins get a fresh sample value each time.
  const prepared = $derived.by((): { ok: true; snippet: string } | { ok: false; error: string } => {
    const ctx = { workspaceId: app.workspaceId ?? '', requestId: tab.requestId, scope: scopeStore.scopeFor(tab.collectionId) }
    if (isMcp) {
      const mcp = prepareMcpSnippet(tab.draft, ctx)
      return mcp.ok ? { ok: true, snippet: mcpInspectorSnippet(mcp.input) } : mcp
    }
    const http = prepareRequest(tab.draft, { ...ctx, allowUnresolved: true })
    return http.ok ? { ok: true, snippet: generateSnippet(lang, http.input) } : http
  })
  const snippet = $derived(prepared.ok ? prepared.snippet : '')
  const info = $derived(isMcp ? MCP_SNIPPET_LANG : SNIPPET_LANGS.find((l) => l.id === lang))
  const fileExtension = $derived(info && 'fileExtension' in info ? info.fileExtension : undefined)

  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet)
      toast.success('Snippet copied')
    } catch {
      toast.error('Could not copy', 'Clipboard access was denied.')
    }
  }

  /** Languages with a file type (.http) can be saved as a file named after the request, into the export folder. */
  async function save() {
    if (!fileExtension) return
    try {
      const path = await saveExport(`${sanitizeFileStem(tab.draft.name, 'request')}${fileExtension}`, snippet)
      toast.success('Snippet saved', path)
    } catch (e) {
      toast.error('Could not save the snippet', errorInfo(e).message)
    }
  }
</script>

<div class="flex h-full min-h-0 flex-col p-3">
  <div class="mb-2 flex items-center gap-2">
    {#if isMcp}
      <span class="text-xs text-muted" data-testid="{idPrefix}-mcp-lang">{MCP_SNIPPET_LANG.label}</span>
    {:else}
      <label for="{idPrefix}-lang" class="text-xs text-muted">Language</label>
      <select id="{idPrefix}-lang" bind:value={lang} class="min-w-0 max-w-44 flex-1">
        {#each SNIPPET_LANGS as l (l.id)}<option value={l.id}>{l.label}</option>{/each}
      </select>
    {/if}
    {#if fileExtension}
      <Button size="sm" icon="download" onclick={save} disabled={!prepared.ok} class="ml-auto" title="Save as a {fileExtension} file">Save</Button>
    {/if}
    <Button size="sm" icon="copy" onclick={copy} disabled={!prepared.ok} class={fileExtension ? '' : 'ml-auto'}>Copy</Button>
  </div>
  {#if prepared.ok}
    <div class="min-h-32 flex-1 overflow-hidden rounded border border-border">
      <CodeEditor value={snippet} readOnly language={info?.editorLanguage ?? 'text'} wrap={settings.editorWrap} label="Code snippet" />
    </div>
    <p class="mt-1 text-xs text-faint">
      Uses the active environment. Secret variables and undefined variables stay as <code>{'{{name}}'}</code>; dynamic values are samples.{#if isMcp}
        Runs the request's operation with the MCP Inspector CLI (needs Node.js).{/if}
    </p>
  {:else}
    <p class="rounded border border-border bg-raised px-3 py-2 text-sm text-muted">{prepared.error}</p>
  {/if}
</div>
