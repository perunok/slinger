<script lang="ts">
  import { onDestroy } from 'svelte'
  import { SNIPPET_LANGUAGES, generateSnippet, type SnippetLanguage, type SnippetRequest } from '../lib/codeSnippets'

  export let builtRequest: SnippetRequest | null

  let language: SnippetLanguage = 'curl'
  let copied = false
  let copiedTimeout: ReturnType<typeof setTimeout> | null = null

  $: snippet = builtRequest ? generateSnippet(language, builtRequest) : ''
  $: missingVars = builtRequest?.missingVariables ?? []

  async function handleCopy() {
    if (!snippet) return
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(snippet)
      } else {
        const el = document.createElement('textarea')
        el.value = snippet
        el.style.cssText = 'position:fixed;left:-9999px;top:0'
        document.body.appendChild(el)
        el.focus()
        el.select()
        document.execCommand('copy')
        document.body.removeChild(el)
      }
      copied = true
      if (copiedTimeout) clearTimeout(copiedTimeout)
      copiedTimeout = setTimeout(() => (copied = false), 1400)
    } catch {
      // ignore
    }
  }

  onDestroy(() => {
    if (copiedTimeout) clearTimeout(copiedTimeout)
  })
</script>

<div class="flex h-full min-h-0 flex-col bg-[var(--bg)]">
  <div class="flex h-10 shrink-0 items-center gap-3 border-b border-[var(--border)] px-4">
    <label class="shrink-0 text-xs font-semibold uppercase text-[var(--muted)]" for="snippet-lang">
      Language
    </label>
    <div class="relative min-w-0">
      <select
        id="snippet-lang"
        bind:value={language}
        class="select-field h-7 rounded pl-2 pr-7 text-xs outline-none appearance-none focus:border-[#5a8fff]"
      >
        {#each SNIPPET_LANGUAGES as opt (opt.value)}
          <option value={opt.value}>{opt.label}</option>
        {/each}
      </select>
      <div class="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-[var(--muted)]">
        <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
          <path d="m6 9 6 6 6-6"/>
        </svg>
      </div>
    </div>

    <div class="ml-auto flex items-center gap-2">
      {#if missingVars.length > 0}
        <span class="text-xs text-[var(--variable-unresolved)]">
          Unresolved: {missingVars.map((v) => `{{${v}}}`).join(', ')}
        </span>
      {/if}
      <button
        type="button"
        class="secondary-button h-7 gap-1.5 px-2 text-xs"
        on:click={handleCopy}
        disabled={!builtRequest || !snippet}
        title="Copy snippet"
      >
        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
        {copied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  </div>

  <div class="min-h-0 flex-1 overflow-auto">
    {#if builtRequest}
      <pre class="p-4 font-mono text-xs leading-6 text-[#cbd5e1] whitespace-pre-wrap break-words">{snippet}</pre>
    {:else}
      <div class="flex h-full items-center justify-center px-4 text-center text-sm text-[var(--muted)]">
        Open a request to generate a code snippet.
      </div>
    {/if}
  </div>
</div>
