<script lang="ts">
  /**
   * Right panel > Variables: the `{{variables}}` the active request uses (value, where it comes from; secrets masked,
   * undefined ones flagged with a Create button) and everything else in its scope.
   */
  import { scopeStore } from '../../../app/scope.svelte'
  import Button from '../../../components/ui/Button.svelte'
  import { usedVariables, variablesInScope } from '../../../lib/requestVariables'
  import type { RequestTab } from '../../requests/tabs.svelte'
  import PanelEmpty from './PanelEmpty.svelte'

  let { tab }: { tab: RequestTab | null } = $props()
  const scope = $derived(tab ? scopeStore.scopeFor(tab.collectionId) : scopeStore.scope)
  const used = $derived(tab ? usedVariables(tab.draft, scope) : [])
  const all = $derived(variablesInScope(scope))
  const unresolved = $derived(used.filter((v) => v.status === 'unresolved').length)
</script>

<div class="space-y-4 p-3 text-sm" data-testid="panel-variables">
  <p class="text-xs text-muted">
    Scope: {scope.environmentName ? `environment “${scope.environmentName}”` : 'no environment'}{scope.collectionName ? `, collection “${scope.collectionName}”` : ''}, globals.
  </p>

  <section aria-labelledby="rp-vars-used">
    <h3 id="rp-vars-used" class="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
      Used by this request
      {#if unresolved > 0}<span class="ml-1 normal-case text-danger">({unresolved} undefined)</span>{/if}
    </h3>
    {#if !tab}
      <PanelEmpty><p>Open a request to see the variables it uses.</p></PanelEmpty>
    {:else if used.length === 0}
      <p class="text-xs text-faint">This request uses no <code>{'{{variables}}'}</code>.</p>
    {:else}
      <ul class="space-y-1" aria-label="Variables used by this request">
        {#each used as v (v.name)}
          <li class="rounded border border-border px-2 py-1.5" data-testid="used-var" data-status={v.status}>
            <div class="flex items-center gap-2">
              <span class="var-chip min-w-0 truncate text-xs" data-status={v.status}>{v.name}</span>
              <span class="ml-auto shrink-0 text-[11px] {v.status === 'unresolved' ? 'text-danger' : 'text-faint'}">{v.source ?? 'Not defined'}</span>
            </div>
            {#if v.status === 'unresolved'}
              <div class="mt-1 flex items-center gap-2">
                <span class="text-xs text-muted">Not defined in this scope.</span>
                {#if scopeStore.createVariable}
                  <Button size="sm" icon="plus" class="ml-auto" onclick={() => scopeStore.createVariable?.(v.name)}>Create</Button>
                {/if}
              </div>
            {:else}
              <div class="mt-0.5 break-all font-mono text-xs {v.status === 'secret' ? 'text-muted' : 'text-fg'}" title={v.status === 'secret' ? 'Secret: the value is not shown' : undefined}>
                {v.value === '' ? '(empty)' : v.value}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section aria-labelledby="rp-vars-all">
    <h3 id="rp-vars-all" class="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">All variables in scope ({all.length})</h3>
    {#if all.length === 0}
      <p class="text-xs text-faint">No variables defined. Add some to an environment, the collection or the globals.</p>
    {:else}
      <table class="w-full table-fixed text-xs" aria-label="All variables in scope">
        <thead class="sr-only"><tr><th>Name</th><th>Value</th><th>Scope</th></tr></thead>
        <tbody>
          {#each all as v (v.key)}
            <tr class="border-b border-border last:border-0 align-top">
              <td class="w-1/3 truncate py-1 pr-2 font-mono" title={v.key}>{v.key}</td>
              <td class="truncate py-1 pr-2 font-mono {v.secret ? 'text-muted' : ''}" title={v.secret ? 'Secret' : v.shown}>{v.shown === '' ? '(empty)' : v.shown}</td>
              <td class="w-1/4 truncate py-1 text-faint" title={v.label}>{v.label.replace(/^(Environment|Collection): .*/, '$1')}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </section>
</div>
