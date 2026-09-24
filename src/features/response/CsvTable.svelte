<script lang="ts">
  import { parseCsv } from '../../lib/response'
  let { text }: { text: string } = $props()
  const rows = $derived(parseCsv(text).slice(0, 5000))
</script>

<div class="h-full overflow-auto">
  <table class="w-full border-collapse font-mono text-xs">
    <thead class="sticky top-0 bg-raised">
      <tr>
        {#each rows[0] ?? [] as cell, i (i)}<th class="border border-border px-2 py-1 text-left font-semibold">{cell}</th>{/each}
      </tr>
    </thead>
    <tbody>
      {#each rows.slice(1) as row, r (r)}
        <tr class="odd:bg-surface even:bg-bg">
          {#each row as cell, c (c)}<td class="border border-border px-2 py-0.5">{cell}</td>{/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>
