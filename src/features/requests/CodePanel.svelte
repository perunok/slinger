<script lang="ts">
  import { app } from '../../app/state.svelte'
  import { scopeStore } from '../../app/scope.svelte'
  import { settings } from '../../app/settings.svelte'
  import { toast } from '../../app/toast.svelte'
  import CodeEditor from '../../components/editor/CodeEditor.svelte'
  import Button from '../../components/ui/Button.svelte'
  import { prepareRequest } from '../../lib/prepare'
  import { generateSnippet, SNIPPET_LANGS, type SnippetLang } from '../../lib/snippets'
  import type { RequestTab } from './tabs.svelte'

  let { tab }: { tab: RequestTab } = $props()
  let lang = $state<SnippetLang>('curl')

  // Regenerated on every draft/environment change; built-ins get a fresh sample value each time.
  const prepared = $derived(
    prepareRequest(tab.draft, { workspaceId: app.workspaceId ?? '', requestId: tab.requestId, scope: scopeStore.scope, allowUnresolved: true }),
  )
  const snippet = $derived(prepared.ok ? generateSnippet(lang, prepared.input) : '')
  const info = $derived(SNIPPET_LANGS.find((l) => l.id === lang))

  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet)
      toast.success('Snippet copied')
    } catch {
      toast.error('Could not copy', 'Clipboard access was denied.')
    }
  }
</script>

<div class="flex h-full min-h-0 flex-col p-3">
  <div class="mb-2 flex items-center gap-2">
    <label for="snippet-lang" class="text-xs text-muted">Language</label>
    <select id="snippet-lang" bind:value={lang} class="w-44">
      {#each SNIPPET_LANGS as l (l.id)}<option value={l.id}>{l.label}</option>{/each}
    </select>
    <Button size="sm" icon="copy" onclick={copy} disabled={!prepared.ok} class="ml-auto">Copy</Button>
  </div>
  {#if prepared.ok}
    <div class="min-h-32 flex-1 overflow-hidden rounded border border-border">
      <CodeEditor value={snippet} readOnly language={info?.editorLanguage ?? 'text'} wrap={settings.editorWrap} label="Code snippet" />
    </div>
    <p class="mt-1 text-xs text-faint">Uses the active environment. Secret variables and undefined variables stay as <code>{'{{name}}'}</code>; dynamic values are samples.</p>
  {:else}
    <p class="rounded border border-border bg-raised px-3 py-2 text-sm text-muted">{prepared.error}</p>
  {/if}
</div>
