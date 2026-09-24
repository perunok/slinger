<script lang="ts">
  import Button from '../../components/ui/Button.svelte'
  import type { EnvModel } from './envModel.svelte'

  let { model }: { model: EnvModel } = $props()
  const errors = $derived(model.bulkParse.errors)
</script>

<div class="flex flex-col gap-2">
  <p class="text-xs text-muted">
    One <code>key=value</code> per line. Lines starting with <code>#</code> are ignored (and not kept). Keys missing from the text are deleted.
  </p>
  {#if model.secretCount > 0}
    <p class="rounded border border-border bg-raised px-2 py-1 text-xs text-muted" data-testid="bulk-secret-note">
      {model.secretCount} secret variable{model.secretCount === 1 ? '' : 's'} {model.secretCount === 1 ? 'is' : 'are'} edited in the table.
    </p>
  {/if}
  {#if model.bulkExcluded - model.secretCount > 0}
    <p class="text-xs text-faint">{model.bulkExcluded - model.secretCount} variable(s) with multi-line or padded values are only editable in the table.</p>
  {/if}
  <textarea
    aria-label="Bulk edit variables"
    rows="12"
    spellcheck="false"
    bind:value={model.bulkText}
    class="w-full resize-y rounded border border-border bg-surface p-2 font-mono text-xs text-fg outline-none focus:border-accent"
  ></textarea>
  {#if errors.length > 0}
    <ul role="alert" class="rounded border border-danger bg-danger-soft px-2 py-1 text-xs text-danger">
      {#each errors as err}<li>Line {err.line}: {err.message}</li>{/each}
    </ul>
  {/if}
  <div class="flex gap-2">
    <Button variant="primary" size="sm" disabled={errors.length > 0 || !model.bulkDirty} onclick={() => model.applyBulk()}>Apply</Button>
    <Button size="sm" disabled={errors.length > 0} onclick={() => (model.applyBulk(), model.exitBulk())}>Back to table</Button>
  </div>
</div>
