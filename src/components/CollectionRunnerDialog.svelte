<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import type { ApiFolder, ApiRequest, Collection } from '../tauri'

  type RunResult = {
    status?: number
    duration_ms?: number
    error?: string
  }

  export let collection: Collection
  export let requests: ApiRequest[]
  export let runRequest: (request: ApiRequest) => Promise<RunResult>
  export let onClose: () => void

  const HTTP_METHOD_CLASSES: Record<string, string> = {
    GET: 'text-[#16a34a]',
    POST: 'text-[#f59e0b]',
    PUT: 'text-[#0ea5e9]',
    PATCH: 'text-[#f97316]',
    DELETE: 'text-[#ef4444]',
    HEAD: 'text-[#64748b]',
    OPTIONS: 'text-[#8b5cf6]',
  }

  let selectedIds = new Set<string>(requests.map((r) => r.id))
  let running = false
  let aborted = false
  let results = new Map<string, RunResult>()
  let activeId: string | null = null
  let completedCount = 0

  $: selectedRequests = requests.filter((r) => selectedIds.has(r.id))
  $: totalSelected = selectedRequests.length
  $: allSelected = selectedIds.size === requests.length
  $: passCount = [...results.values()].filter((r) => r.status && r.status < 400).length
  $: failCount = [...results.values()].filter((r) => !r.status || r.status >= 400).length

  function toggleAll() {
    if (allSelected) {
      selectedIds = new Set()
    } else {
      selectedIds = new Set(requests.map((r) => r.id))
    }
  }

  function toggleRequest(id: string) {
    const next = new Set(selectedIds)
    if (next.has(id)) {
      next.delete(id)
    } else {
      next.add(id)
    }
    selectedIds = next
  }

  function formatDuration(ms?: number): string {
    if (ms === undefined) return ''
    if (ms < 1000) return `${Math.round(ms)} ms`
    return `${(ms / 1000).toFixed(2)} s`
  }

  function statusClass(result?: RunResult): string {
    if (!result) return 'text-[var(--muted)]'
    if (result.error) return 'text-[#ef4444]'
    if (result.status && result.status < 400) return 'text-[#16a34a]'
    return 'text-[#ef4444]'
  }

  function statusLabel(result?: RunResult): string {
    if (!result) return '—'
    if (result.error) return 'Error'
    if (result.status) return String(result.status)
    return '—'
  }

  async function handleRun() {
    if (running || selectedRequests.length === 0) return
    running = true
    aborted = false
    results = new Map()
    completedCount = 0

    for (const request of selectedRequests) {
      if (aborted) break
      activeId = request.id
      try {
        const result = await runRequest(request)
        results = new Map(results).set(request.id, result)
      } catch (err) {
        results = new Map(results).set(request.id, { error: String(err) })
      }
      completedCount++
    }

    activeId = null
    running = false
  }

  function handleStop() {
    aborted = true
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && !running) {
      event.preventDefault()
      onClose()
    }
  }

  onMount(() => window.addEventListener('keydown', handleKeydown))
  onDestroy(() => window.removeEventListener('keydown', handleKeydown))
</script>

<div class="runner-backdrop">
  <div class="runner-dialog">
    <div class="runner-header">
      <div>
        <h2 class="text-base font-semibold text-[var(--text)]">Run Collection</h2>
        <p class="mt-0.5 text-sm text-[var(--muted)]">{collection.name}</p>
      </div>
      <button
        type="button"
        class="ml-auto flex h-7 w-7 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--text)]"
        on:click={onClose}
        disabled={running}
        title="Close"
      >
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 6 6 18M6 6l12 12"/>
        </svg>
      </button>
    </div>

    {#if running}
      <div class="px-4 pt-3">
        <div class="flex items-center gap-2 text-xs text-[var(--muted)]">
          <div class="glow-strip flex-1 rounded-full">
            <div class="glow-slide" />
          </div>
          <span class="shrink-0">{completedCount} / {totalSelected}</span>
        </div>
      </div>
    {/if}

    {#if results.size > 0}
      <div class="flex items-center gap-4 border-b border-[var(--border)] px-4 py-2 text-xs text-[var(--muted)]">
        <span class="text-[#16a34a] font-semibold">{passCount} passed</span>
        <span class="text-[#ef4444] font-semibold">{failCount} failed</span>
        <span>{completedCount} of {totalSelected} ran</span>
      </div>
    {/if}

    <div class="runner-requests">
      <div class="flex items-center gap-3 border-b border-[var(--border)] px-4 py-2">
        <input
          type="checkbox"
          class="h-3.5 w-3.5 accent-[#5a8fff]"
          checked={allSelected}
          indeterminate={selectedIds.size > 0 && !allSelected}
          on:change={toggleAll}
          disabled={running}
        />
        <span class="text-xs font-semibold uppercase text-[var(--muted)]">
          {totalSelected} request{totalSelected === 1 ? '' : 's'} selected
        </span>
      </div>

      {#each requests as request (request.id)}
        {@const result = results.get(request.id)}
        {@const isActive = activeId === request.id}
        <div
          class={`flex items-center gap-3 border-b border-[var(--border)] px-4 py-2.5 text-sm ${
            isActive ? 'bg-[var(--panel)]' : ''
          }`}
        >
          <input
            type="checkbox"
            class="h-3.5 w-3.5 shrink-0 accent-[#5a8fff]"
            checked={selectedIds.has(request.id)}
            on:change={() => toggleRequest(request.id)}
            disabled={running}
          />
          <span class={`w-12 shrink-0 text-xs font-bold ${HTTP_METHOD_CLASSES[request.method] ?? 'text-[var(--muted)]'}`}>
            {request.method}
          </span>
          <span class="min-w-0 flex-1 truncate text-[var(--text)]">{request.name}</span>
          {#if isActive}
            <span class="shrink-0 text-xs text-[var(--muted)] animate-pulse">Running…</span>
          {:else if result}
            <span class={`shrink-0 text-xs font-semibold ${statusClass(result)}`}>
              {statusLabel(result)}
            </span>
            {#if result.duration_ms !== undefined}
              <span class="shrink-0 text-xs text-[var(--muted)]">{formatDuration(result.duration_ms)}</span>
            {/if}
            {#if result.error}
              <span class="shrink-0 text-xs text-[#ef4444]" title={result.error}>Error</span>
            {/if}
          {/if}
        </div>
      {/each}

      {#if requests.length === 0}
        <div class="flex flex-col items-center justify-center gap-2 py-12 text-sm text-[var(--muted)]">
          <p>No requests in this collection.</p>
        </div>
      {/if}
    </div>

    <div class="flex items-center justify-end gap-2 border-t border-[var(--border)] px-4 py-3">
      <button
        type="button"
        class="secondary-button h-8"
        on:click={onClose}
        disabled={running}
      >
        Close
      </button>
      {#if running}
        <button
          type="button"
          class="secondary-button h-8 text-[#ef4444]"
          on:click={handleStop}
        >
          Stop
        </button>
      {:else}
        <button
          type="button"
          class="primary-button h-8"
          on:click={handleRun}
          disabled={totalSelected === 0}
        >
          Run {totalSelected > 0 ? `(${totalSelected})` : ''}
        </button>
      {/if}
    </div>
  </div>
</div>

<style>
  .runner-backdrop {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    background: rgba(0, 0, 0, 0.46);
    padding: 3rem 1rem 1rem;
  }

  .runner-dialog {
    display: flex;
    flex-direction: column;
    width: min(100%, 42rem);
    max-height: calc(100vh - 4rem);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--bg-alt);
    color: var(--text);
    box-shadow: 0 24px 90px rgba(0, 0, 0, 0.36);
    overflow: hidden;
  }

  .runner-header {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 1rem 1rem 0.75rem;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .runner-requests {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
</style>
