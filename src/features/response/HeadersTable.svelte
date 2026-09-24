<script lang="ts">
  import type { RequestHeader } from '../../../shared/types'
  let { headers }: { headers: RequestHeader[] } = $props()
</script>

{#if headers.length === 0}
  <p class="p-4 text-sm text-muted">No response headers.</p>
{:else}
  <div class="h-full overflow-auto p-2">
    <table class="w-full border-collapse text-sm" aria-label="Response headers">
      <thead class="text-left text-xs text-faint">
        <tr><th class="w-1/3 px-2 py-1 font-normal">Name</th><th class="px-2 py-1 font-normal">Value</th></tr>
      </thead>
      <tbody>
        {#each headers as h, i (i)}
          <tr class="border-t border-border align-top">
            <td class="px-2 py-1 font-mono text-xs font-semibold">{h.key}</td>
            <td class="break-all px-2 py-1 font-mono text-xs">{h.value}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
