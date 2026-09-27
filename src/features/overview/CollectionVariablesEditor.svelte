<script lang="ts">
  /**
   * The Variables section of a collection overview: the collection's variables (Postman collection `variable`)
   * in the shared variable table (enabled toggle, bulk edit, autosave). Never secret: they are exported and
   * versioned with the collection. Local-only (not synced).
   */
  import { onDestroy } from 'svelte'
  import { EnvModel } from '../environments/envModel.svelte'
  import { collectionBackend } from '../environments/varBackends'
  import VariablesPanel from '../environments/VariablesPanel.svelte'
  import type { RequestTab } from '../requests/tabs.svelte'

  let { tab, collectionId, collectionName }: { tab: RequestTab; collectionId: string; collectionName: string } = $props()

  const model = new EnvModel(600, collectionBackend)
  $effect(() => {
    if (model.environmentId !== collectionId) void model.select(collectionId)
  })
  onDestroy(() => model.dispose())

  // "Create variable" in this collection (popover target): add a row for the name once loaded.
  $effect(() => {
    const name = tab.pendingVariable
    if (!name || model.environmentId !== collectionId || model.loading) return
    tab.pendingVariable = null
    model.addNamed(name)
  })
</script>

<div class="min-h-0 flex-1 overflow-auto p-3" data-testid="collection-variables">
  <VariablesPanel {model} title="Collection variables" label="Collection variables" scopeName={collectionName}>
    {#snippet hint()}
      Available to every request of this collection (<code>pm.collectionVariables</code> in scripts); the active environment
      overrides them. Exported and versioned with the collection, never secret (use an environment or a global for secrets).
      Kept on this device: not synced to the cloud yet.
    {/snippet}
  </VariablesPanel>
</div>
