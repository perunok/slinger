<script lang="ts">
  /** What sits under the request editor: empty state, progress, inline error or the response viewer. */
  import { scopeStore } from '../../app/scope.svelte'
  import Button from '../../components/ui/Button.svelte'
  import Spinner from '../../components/ui/Spinner.svelte'
  import type { RequestTab } from '../requests/tabs.svelte'
  import { tabsStore } from '../requests/tabs.svelte'
  import ResponseViewer from './ResponseViewer.svelte'

  let { tab }: { tab: RequestTab } = $props()
</script>

<div class="flex h-full min-h-0 flex-col bg-surface" aria-label="Response" role="region">
  {#if tab.error}
    <div role="alert" class="m-3 rounded border border-danger bg-danger-soft p-3 text-sm" data-testid="send-error">
      <p class="font-medium text-danger">The request was not sent</p>
      <p class="mt-1">{tab.error.message}</p>
      {#if tab.error.unresolved.length}
        <ul class="mt-2 flex flex-wrap gap-2">
          {#each tab.error.unresolved as name (name)}
            <li>
              <Button size="sm" icon="plus" onclick={() => scopeStore.createVariable?.(name)}>Create <code>{name}</code></Button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
  {#if tab.sending}
    <div class="flex items-center gap-3 p-4 text-sm text-muted" role="status">
      <Spinner /> Sending request…
      <Button size="sm" variant="danger" onclick={() => tabsStore.cancel(tab)}>Cancel</Button>
    </div>
  {:else if tab.response}
    {#if tab.warnings.length}
      <ul class="border-b border-border bg-warning-soft px-3 py-1 text-xs text-warning">
        {#each tab.warnings as w (w)}<li>{w}</li>{/each}
      </ul>
    {/if}
    <div class="min-h-0 flex-1">
      <ResponseViewer data={tab.response.data} view={tab.responseView} onviewchange={(v) => (tab.responseView = v)} />
    </div>
  {:else if !tab.error}
    <div class="flex h-full flex-col items-center justify-center gap-1 text-sm text-muted">
      <p>Enter a URL and press <kbd class="rounded border border-border bg-raised px-1">Send</kbd></p>
      <p class="text-xs text-faint">Ctrl+Enter also sends the request</p>
    </div>
  {/if}
</div>
