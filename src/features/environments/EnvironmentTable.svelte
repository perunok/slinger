<script lang="ts">
  import { makeScope } from '../../lib/template'
  import EnvironmentRow from './EnvironmentRow.svelte'
  import type { EnvModel } from './envModel.svelte'
  import { gridClass } from './varGrid'

  interface Props {
    model: EnvModel
    /** Environment name, or "Globals" / the collection name for the other variable tables. */
    environmentName: string
    /** Accessible name of the table. */
    label?: string
  }
  let { model, environmentName, label = 'Environment variables' }: Props = $props()
  const grid = $derived(gridClass(model.backend))

  // Values may reference other variables of *this* environment, regardless of which one is active.
  const scope = $derived(
    makeScope(
      environmentName,
      model.rows.filter((r) => r.key && !r.deleted).map((r) => ({ key: r.key, value: r.isSecret ? null : r.value, secret: r.isSecret, id: r.id })),
    ),
  )
</script>

<div role="table" aria-label={label} class="rounded border border-border">
  <div role="row" class="grid {grid} gap-2 border-b border-border bg-raised px-2 py-1 text-xs font-medium text-muted">
    {#if model.backend.enabledColumn}<span role="columnheader" class="text-center" title="Enabled">On</span>{/if}
    <span role="columnheader">Name</span>
    <span role="columnheader">Value</span>
    {#if model.backend.secrets}<span role="columnheader" class="text-center">Secret</span>{/if}
    <span role="columnheader" class="sr-only">Actions</span>
  </div>
  {#each model.rows as row (row.rid)}
    <EnvironmentRow {row} {model} {scope} />
  {/each}
</div>
