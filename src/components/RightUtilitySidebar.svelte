<script lang="ts">
  import { onDestroy } from 'svelte'
  import type { ApiRequest } from '../tauri'

  type UtilityTab = 'copy-request'
  type CopyFormat = 'curl'

  export let open: boolean
  export let setOpen: (open: boolean) => void
  export let activeTab: UtilityTab
  export let setActiveTab: (tab: UtilityTab) => void
  export let selectedRequest: ApiRequest | null
  export let copyFormat: CopyFormat
  export let setCopyFormat: (format: CopyFormat) => void
  export let curlCommand: string
  export let missingVariables: string[]
  export let copyBuiltRequest: () => Promise<boolean>

  let copied = false
  let copiedTimeout: ReturnType<typeof setTimeout> | null = null

  function selectValue(event: Event): string {
    return (event.currentTarget as HTMLSelectElement).value
  }

  function setCopyFormatFromEvent(event: Event) {
    setCopyFormat(selectValue(event) as CopyFormat)
  }

  function openTab(tab: UtilityTab) {
    setActiveTab(tab)
    setOpen(true)
  }

  async function handleCopy() {
    const didCopy = await copyBuiltRequest()
    if (!didCopy) return

    copied = true

    if (copiedTimeout) clearTimeout(copiedTimeout)
    copiedTimeout = setTimeout(() => {
      copied = false
    }, 1400)
  }

  onDestroy(() => {
    if (copiedTimeout) clearTimeout(copiedTimeout)
  })
</script>

{#if open}
  <aside class="flex h-full shrink-0 border-l border-[var(--border)] bg-[var(--bg)]">
    <div class="flex w-11 flex-col items-center border-r border-[var(--border)] bg-[var(--toolbar)] py-2">
      <button
        type="button"
        class={`flex h-9 w-9 items-center justify-center rounded transition-colors ${
          activeTab === 'copy-request'
            ? 'bg-[var(--surface)] text-[var(--text)]'
            : 'text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--text)]'
        }`}
        title="Copy request"
        aria-label="Copy request"
        aria-pressed={activeTab === 'copy-request'}
        on:click={() => openTab('copy-request')}
      >
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      </button>
    </div>

    <div class="flex w-[360px] min-w-0 flex-col">
      <div class="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border)] px-3">
        <div class="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--text)]">Copy Request</div>
        <button
          type="button"
          class="flex h-8 w-8 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--text)]"
          title="Collapse"
          aria-label="Collapse right sidebar"
          on:click={() => setOpen(false)}
        >
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="m9 18 6-6-6-6" />
          </svg>
        </button>
      </div>

      <div class="flex min-h-0 flex-1 flex-col gap-3 p-3">
        <div class="flex items-center gap-2">
          <label class="shrink-0 text-xs font-semibold uppercase text-[var(--muted)]" for="copy-format">Copy As</label>
          <div class="relative min-w-0 flex-1">
            <select
              id="copy-format"
              value={copyFormat}
              class="select-field h-8 w-full rounded pl-2 pr-7 text-sm outline-none appearance-none focus:border-[#5a8fff]"
              on:change={setCopyFormatFromEvent}
            >
              <option value="curl">cURL</option>
            </select>
            <div class="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[var(--muted)]">
              <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </div>
          </div>
        </div>

        {#if missingVariables.length > 0}
          <div class="rounded border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-xs text-[var(--variable-unresolved)]">
            Unresolved: {missingVariables.map((name) => `{{${name}}}`).join(', ')}
          </div>
        {/if}

        <div class="flex min-h-0 flex-1 flex-col overflow-hidden rounded border border-[var(--border)] bg-[var(--panel)]">
          <div class="flex h-9 shrink-0 items-center justify-between border-b border-[var(--border)] px-3">
            <span class="text-xs font-semibold uppercase text-[var(--muted)]">cURL</span>
            <button
              type="button"
              class="secondary-button h-7 gap-1.5 px-2 text-xs"
              on:click={handleCopy}
              disabled={!selectedRequest || !curlCommand}
              title="Copy built request"
            >
              <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          {#if selectedRequest}
            <pre class="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5 text-[var(--text)]">{curlCommand}</pre>
          {:else}
            <div class="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm text-[var(--muted)]">
              Open a request to copy it.
            </div>
          {/if}
        </div>
      </div>
    </div>
  </aside>
{/if}
