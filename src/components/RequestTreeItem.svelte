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
    class={`flex h-7 w-full items-center gap-2 rounded px-2 text-left text-xs ${
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
