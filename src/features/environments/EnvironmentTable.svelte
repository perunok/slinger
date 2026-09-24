<script lang="ts">
  import { makeScope } from '../../lib/template'
  import EnvironmentRow from './EnvironmentRow.svelte'
  import type { EnvModel } from './envModel.svelte'

  interface Props {
    model: EnvModel
    environmentName: string
  }
  let { model, environmentName }: Props = $props()

  // Values may reference other variables of *this* environment, regardless of which one is active.
  const scope = $derived(
    makeScope(
      environmentName,
      model.rows.filter((r) => r.key && !r.deleted).map((r) => ({ key: r.key, value: r.isSecret ? null : r.value, secret: r.isSecret, id: r.id })),
    ),
  )
</script>

<div role="table" aria-label="Environment variables" class="rounded border border-border">
  <div role="row" class="grid grid-cols-[minmax(7rem,1fr)_minmax(9rem,2fr)_4rem_5.5rem] gap-2 border-b border-border bg-raised px-2 py-1 text-xs font-medium text-muted">
    <span role="columnheader">Name</span>
    <span role="columnheader">Value</span>
    <span role="columnheader" class="text-center">Secret</span>
    <span role="columnheader" class="sr-only">Actions</span>
  </div>
  {#each model.rows as row (row.rid)}
    <EnvironmentRow {row} {model} {scope} />
  {/each}
</div>
