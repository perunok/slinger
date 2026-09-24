<script lang="ts">
  import KeyValueTable from '../../components/kv/KeyValueTable.svelte'
  import { autoHeaders } from '../../lib/autoHeaders'
  import type { RequestTab } from './tabs.svelte'

  let { tab }: { tab: RequestTab } = $props()
  const auto = $derived(autoHeaders(tab.draft))
  let showAuto = $state(false)
</script>

<div class="p-3">
  <KeyValueTable
    rows={tab.draft.headers}
    onchange={(rows) => (tab.draft.headers = rows)}
    noun="Header"
    keyPlaceholder="Header"
    suggestions="headers"
    duplicates="case-insensitive"
  />
  <div class="mt-3 border-t border-border pt-2">
    <button type="button" class="text-xs text-muted hover:text-fg" aria-expanded={showAuto} onclick={() => (showAuto = !showAuto)}>
      {showAuto ? '▾' : '▸'} Auto-generated headers ({auto.length})
    </button>
    {#if showAuto}
      <table class="mt-1 w-full text-xs">
        <tbody>
          {#each auto as h (h.key + h.source)}
            <tr class="border-t border-border text-muted">
              <td class="w-1/4 py-1 pr-2 font-mono">{h.key}</td>
              <td class="py-1 pr-2 font-mono">{h.value}</td>
              <td class="w-1/5 py-1 text-faint">{h.source}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
</div>
