<script lang="ts">
  /**
   * A variable table with its toolbar (Bulk edit, autosave status), duplicate banner and bulk editor. Used for
   * globals (Environments dialog) and collection variables (collection overview); the environment editor dialog
   * lays out the same parts itself.
   */
  import type { Snippet } from 'svelte'
  import Button from '../../components/ui/Button.svelte'
  import InlineError from '../../components/ui/InlineError.svelte'
  import Spinner from '../../components/ui/Spinner.svelte'
  import ReadOnlyNote from '../sync/ReadOnlyNote.svelte'
  import { sync } from '../sync/syncStore.svelte'
  import EnvironmentBulk from './EnvironmentBulk.svelte'
  import EnvironmentTable from './EnvironmentTable.svelte'
  import type { EnvModel } from './envModel.svelte'
  import SaveStatus from './SaveStatus.svelte'

  interface Props {
    model: EnvModel
    title: string
    /** Accessible name of the section and table, e.g. "Globals", "Collection variables". */
    label: string
    /** Name used for `{{}}` inside values (the scope of this table). */
    scopeName: string
    /** Explanation under the toolbar. */
    hint?: Snippet
    class?: string
  }
  let { model, title, label, scopeName, hint, class: cls = '' }: Props = $props()
</script>

<section class="flex min-w-0 flex-1 flex-col gap-2 {cls}" aria-label={label} data-testid="variables-panel">
  <div class="flex items-center justify-between gap-2">
    <h3 class="truncate text-sm font-semibold">{title}</h3>
    <div class="flex items-center gap-2">
      <Button size="sm" disabled={model.loading || sync.blocked} onclick={() => (model.bulkMode ? model.applyBulk() && model.exitBulk() : model.enterBulk())}>
        {model.bulkMode ? 'Table edit' : 'Bulk edit'}
      </Button>
      <SaveStatus kind={model.status.kind} label={model.status.label} onretry={() => model.flush()} />
    </div>
  </div>
  {#if hint}<div class="text-xs text-muted">{@render hint()}</div>{/if}
  <ReadOnlyNote />
  {#if model.duplicateNames.length > 0}
    <p role="status" data-testid="duplicate-banner" class="rounded border border-warning bg-warning-soft px-2 py-1.5 text-xs text-warning">
      Duplicate variable names: {model.duplicateNames.join(', ')}. Rows with duplicate names are not saved until every name is unique.
    </p>
  {/if}
  {#if model.loading}
    <div class="flex justify-center py-10"><Spinner /></div>
  {:else if model.loadError}
    <InlineError message={model.loadError} />
  {:else if model.bulkMode}
    <EnvironmentBulk {model} />
  {:else}
    <EnvironmentTable {model} environmentName={scopeName} {label} />
  {/if}
</section>
