<script lang="ts">
  /** One compared field, mine vs cloud, with line highlighting for multi-line values. */
  import type { DiffLine, DiffRow } from './conflictDiff'
  import { displayValue } from './conflictDiff'

  let { row, deletedLocal = '(deleted here)', deletedRemote = '(deleted in the cloud)' }: { row: DiffRow; deletedLocal?: string; deletedRemote?: string } = $props()

  const cls = (op: DiffLine['op'], side: 'local' | 'remote') =>
    op === 'same' ? '' : side === 'local' ? 'bg-danger-soft text-danger' : 'bg-success-soft text-success'
</script>

{#snippet side(value: string | null, lines: DiffLine[] | null, which: 'local' | 'remote', deleted: string)}
  <div class="min-w-0">
    <div class="mb-0.5 text-[11px] font-medium uppercase tracking-wide text-muted">{which === 'local' ? 'Mine (this device)' : 'Cloud'}</div>
    <pre
      class="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded border border-border px-1.5 py-1 font-mono text-xs {row.changed && !lines ? (which === 'local' ? 'bg-danger-soft' : 'bg-success-soft') : 'bg-raised'} {value === null ? 'italic text-faint' : ''}"
      data-side={which}>{#if lines}{#each lines as l, i (i)}<span class="block {cls(l.op, which)}">{l.text === '' ? ' ' : l.text}</span>{/each}{:else}{displayValue(value, deleted)}{/if}</pre>
  </div>
{/snippet}

<div class="rounded border border-border p-2" data-testid="diff-row" data-changed={row.changed || undefined}>
  <div class="mb-1 flex items-center gap-2 text-xs font-medium">
    <span>{row.label}</span>
    {#if row.changed}<span class="rounded bg-warning-soft px-1.5 text-[10px] text-warning">differs</span>{:else}<span class="text-[10px] text-faint">same</span>{/if}
  </div>
  <div class="grid grid-cols-1 gap-2 md:grid-cols-2">
    {@render side(row.local, row.localLines, 'local', deletedLocal)}
    {@render side(row.remote, row.remoteLines, 'remote', deletedRemote)}
  </div>
</div>
