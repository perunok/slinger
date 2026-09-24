<script lang="ts">
  import type { FieldChange, SnapshotDiff } from '../../lib/versionDiff'
  import { methodColor } from './helpers'

  interface Props {
    diff: SnapshotDiff
    /** e.g. "v1.0.0" and "current collection" */
    fromLabel: string
    toLabel: string
  }
  let { diff, fromLabel, toLabel }: Props = $props()

  const chips = $derived([
    { label: 'Added', n: diff.summary.added, cls: 'bg-success-soft text-success' },
    { label: 'Removed', n: diff.summary.removed, cls: 'bg-danger-soft text-danger' },
    { label: 'Changed', n: diff.summary.changed, cls: 'bg-warning-soft text-warning' },
    { label: 'Unchanged', n: diff.summary.unchanged, cls: 'bg-raised text-muted' },
  ])
  const groups = $derived(
    (['added', 'removed', 'changed'] as const)
      .map((s) => ({ status: s, items: diff.requests.filter((r) => r.status === s) }))
      .filter((g) => g.items.length > 0),
  )
  const groupTitle = { added: 'Added requests', removed: 'Removed requests', changed: 'Changed requests' }

  function method(r: SnapshotDiff['requests'][number]): string {
    return (r.after ?? r.before)?.method ?? ''
  }
  const fieldLabel = (c: FieldChange) => c.field
</script>

<div class="flex flex-col gap-3 text-sm">
  <p class="text-xs text-muted">Changes from <strong class="text-fg">{fromLabel}</strong> &rarr; <strong class="text-fg">{toLabel}</strong></p>
  <ul class="flex flex-wrap gap-1.5" aria-label="Summary">
    {#each chips as c (c.label)}
      <li class="rounded-full px-2 py-0.5 text-xs {c.cls}">{c.n} {c.label.toLowerCase()}</li>
    {/each}
  </ul>

  {#if diff.identical}
    <p class="rounded border border-border bg-raised p-3 text-muted">The two snapshots are identical: no requests or folders differ.</p>
  {/if}

  {#if diff.foldersAdded.length || diff.foldersRemoved.length || diff.foldersRenamed.length}
    <section aria-label="Folder changes">
      <h3 class="mb-1 text-xs font-semibold uppercase text-muted">Folders</h3>
      <ul class="flex flex-col gap-0.5 font-mono text-xs">
        {#each diff.foldersAdded as f (f)}<li class="rounded bg-success-soft px-1.5 py-0.5 text-success">+ {f}</li>{/each}
        {#each diff.foldersRemoved as f (f)}<li class="rounded bg-danger-soft px-1.5 py-0.5 text-danger">- {f}</li>{/each}
        {#each diff.foldersRenamed as f (f.before)}<li class="rounded bg-warning-soft px-1.5 py-0.5 text-warning">{f.before} &rarr; {f.after} (renamed)</li>{/each}
      </ul>
    </section>
  {/if}

  {#each groups as g (g.status)}
    <section aria-label={groupTitle[g.status]}>
      <h3 class="mb-1 text-xs font-semibold uppercase text-muted">{groupTitle[g.status]} ({g.items.length})</h3>
      <ul class="flex flex-col gap-1.5">
        {#each g.items as r (r.key)}
          <li class="rounded border border-border">
            <div class="flex items-center gap-2 px-2 py-1">
              <span class="w-12 shrink-0 font-mono text-[11px] font-semibold" style="color: {methodColor(method(r))}">{method(r)}</span>
              <span class="truncate font-mono text-xs">{r.path}</span>
            </div>
            {#each r.changes as c (c.field)}
              <div class="border-t border-border px-2 py-1">
                <div class="mb-0.5 text-[11px] uppercase text-muted">{fieldLabel(c)}</div>
                <pre class="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-danger-soft px-1.5 py-0.5 font-mono text-xs text-danger" aria-label="Before">{c.before === '' ? '(empty)' : c.before}</pre>
                <pre class="mt-0.5 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-success-soft px-1.5 py-0.5 font-mono text-xs text-success" aria-label="After">{c.after === '' ? '(empty)' : c.after}</pre>
              </div>
            {/each}
          </li>
        {/each}
      </ul>
    </section>
  {/each}
</div>
