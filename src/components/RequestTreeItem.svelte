<script lang="ts">
  import { methodClass } from '../lib/collectionTree'
  import { parseDocument, requestResponses, type ResponseExample } from '../lib/requestDocument'
  import type { ApiRequest } from '../tauri'

  export let request: ApiRequest
  export let depth = 0
  export let selectedRequestId: string | null
  export let selectedResponseRequestId: string | null
  export let selectedResponseIndex: number
  export let setSelectedRequestId: (id: string | null) => void
  export let selectResponseExample: (requestId: string, responseIndex: number) => void
  export let handleRenameRequest: (request: ApiRequest) => Promise<void>
  export let handleDeleteRequest: (request: ApiRequest) => Promise<void>

  let examplesOpen = false

  $: responseExamples = requestResponses(parseDocument(request))
  $: requestIsSelected = request.id === selectedRequestId && selectedResponseRequestId !== request.id
  $: hasResponseExamples = responseExamples.length > 0

  function responseName(response: ResponseExample, index: number): string {
    return response.name?.trim() || `Example ${index + 1}`
  }

  function responseMeta(response: ResponseExample): string {
    if (response.code) return String(response.code)
    if (response.status?.trim()) return response.status.trim()
    return 'EX'
  }
</script>

<div>
  <div
    class={`request-row flex h-7 w-full items-center gap-2 rounded px-2 text-left text-xs ${
      requestIsSelected
        ? 'bg-[var(--surface)] text-[var(--text)]'
        : 'text-[var(--muted)] hover:bg-[var(--panel)]'
    }`}
    style={`padding-left: ${8 + depth * 14}px`}
  >
    {#if hasResponseExamples}
      <button
        type="button"
        class="w-3 shrink-0 text-[var(--muted)] hover:text-[var(--text)]"
        aria-label={`${examplesOpen ? 'Hide' : 'Show'} response examples`}
        aria-expanded={examplesOpen}
        on:click|stopPropagation={() => (examplesOpen = !examplesOpen)}
      >
        {examplesOpen ? 'v' : '>'}
      </button>
    {:else}
      <span class="w-3 shrink-0" />
    {/if}
    <button
      type="button"
      class="flex min-w-0 flex-1 items-center gap-2 text-left"
      on:click={() => setSelectedRequestId(request.id)}
    >
      <span class={`w-12 shrink-0 font-semibold ${methodClass(request.method)}`}>
        {request.method}
      </span>
      <span class="min-w-0 flex-1 truncate">{request.name}</span>
    </button>
    <div class="request-actions">
      <button
        type="button"
        class="request-actions-trigger"
        title="Request actions"
        aria-label="Request actions"
      >
        ...
      </button>
      <div class="request-actions-menu">
        <button
          type="button"
          title="Rename request"
          on:click|stopPropagation={() => handleRenameRequest(request)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m4 20 4.5-1 10-10-3.5-3.5-10 10L4 20Z" />
            <path d="m13.5 7.5 3.5 3.5" />
          </svg>
          <span>Rename</span>
        </button>
        <button
          type="button"
          title="Delete request"
          class="danger"
          on:click|stopPropagation={() => handleDeleteRequest(request)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 7h14" />
            <path d="M9 7V5h6v2" />
            <path d="m8 7 .8 14h6.4L16 7" />
            <path d="M10.5 11v5" />
            <path d="M13.5 11v5" />
          </svg>
          <span>Delete</span>
        </button>
      </div>
    </div>
  </div>

  {#if hasResponseExamples && examplesOpen}
    <div class="space-y-1">
      {#each responseExamples as response, index (`${request.id}-${response.name ?? 'example'}-${index}`)}
        {@const responseIsSelected = selectedResponseRequestId === request.id && selectedResponseIndex === index}
        <button
          type="button"
          on:click={() => selectResponseExample(request.id, index)}
          class={`flex h-6 w-full items-center gap-2 rounded px-2 text-left text-[11px] ${
            responseIsSelected
              ? 'bg-[var(--surface)] text-[var(--text)]'
              : 'text-[var(--muted)] hover:bg-[var(--panel)]'
          }`}
          style={`padding-left: ${28 + depth * 14}px`}
        >
          <span class="w-12 shrink-0 truncate font-semibold text-[var(--muted)]">{responseMeta(response)}</span>
          <span class="min-w-0 flex-1 truncate">{responseName(response, index)}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .request-row {
    position: relative;
  }

  .request-actions {
    position: relative;
    flex: 0 0 auto;
  }

  .request-actions-trigger {
    display: inline-flex;
    width: 1.35rem;
    height: 1.35rem;
    align-items: center;
    justify-content: center;
    border-radius: 0.25rem;
    color: var(--muted);
    font-size: 0.8125rem;
    line-height: 1;
    opacity: 0;
  }

  .request-row:hover .request-actions-trigger,
  .request-actions:focus-within .request-actions-trigger {
    opacity: 1;
  }

  .request-actions-trigger:hover,
  .request-actions-trigger:focus-visible {
    background: var(--panel);
    color: var(--text);
    outline: none;
  }

  .request-actions-menu {
    position: absolute;
    top: 100%;
    right: 0;
    z-index: 50;
    display: none;
    min-width: 8.5rem;
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    background: var(--bg-alt);
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.32);
    padding: 0.25rem;
  }

  .request-actions:hover .request-actions-menu,
  .request-actions:focus-within .request-actions-menu {
    display: grid;
  }

  .request-actions-menu button {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 0.5rem;
    border-radius: 0.25rem;
    color: var(--muted);
    padding: 0.45rem 0.55rem;
    font-size: 0.8125rem;
    text-align: left;
  }

  .request-actions-menu button:hover,
  .request-actions-menu button:focus-visible {
    background: var(--surface);
    color: var(--text);
    outline: none;
  }

  .request-actions-menu button.danger:hover,
  .request-actions-menu button.danger:focus-visible {
    color: #f87171;
  }

  .request-actions-menu svg {
    width: 0.875rem;
    height: 0.875rem;
    flex: 0 0 0.875rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.9;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
</style>
