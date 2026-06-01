<script lang="ts">
  export type TableRow = {
    key: string
    value: string
    source?: string
  }

  export let rows: TableRow[]
</script>

{#if rows.length === 0}
  <div class="px-4 py-4 text-sm text-[var(--muted)]">None</div>
{:else}
  <div class="grid grid-cols-[180px_1fr_120px] border-t border-[var(--border)] text-sm">
    {#each rows as row, index (`${row.key}-${index}`)}
      <div class="contents">
        <div class="border-b border-[var(--border)] px-4 py-2 font-mono text-[var(--text)]">{row.key}</div>
        <div class="border-b border-[var(--border)] px-4 py-2 font-mono text-[var(--muted)]">{row.value}</div>
        <div class="border-b border-[var(--border)] px-4 py-2 text-[var(--muted)]">{row.source ?? ''}</div>
      </div>
    {/each}
  </div>
{/if}
