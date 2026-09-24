<script lang="ts">
  /** Non-destructive banner shown above a request editor whose request changed/was deleted in the cloud. */
  import Button from '../../components/ui/Button.svelte'
  import Icon from '../../components/ui/Icon.svelte'
  import type { RequestTab } from '../requests/tabs.svelte'
  import { sync } from './syncStore.svelte'
  import { closeTab, keepMine, reloadFromCloud, saveAsNew } from './tabActions'

  let { tab }: { tab: RequestTab } = $props()
  const notice = $derived(tab.remoteNotice)
</script>

{#if notice && (notice.kind === 'deleted' || tab.dirty)}
  <div role="status" data-testid="tab-notice" class="flex flex-wrap items-center gap-2 border-b border-warning bg-warning-soft px-3 py-1.5 text-xs text-fg">
    <span class="text-warning"><Icon name="alert" size={14} /></span>
    {#if notice.kind === 'changed'}
      <span class="min-w-0 flex-1">This request was changed in the cloud while you have unsaved edits. Your edits are untouched.</span>
      <Button size="sm" onclick={() => reloadFromCloud(tab)}>Reload from cloud</Button>
      <Button size="sm" onclick={() => keepMine(tab)} title="Keep editing; the next Save overwrites the cloud version">Keep my edits</Button>
    {:else}
      <span class="min-w-0 flex-1">This request was deleted in the cloud. Your unsaved edits are kept in this tab.</span>
      {#if !sync.blocked}<Button size="sm" onclick={() => saveAsNew(tab)}>Save as new request…</Button>{/if}
      <Button size="sm" onclick={() => closeTab(tab)}>Close tab</Button>
    {/if}
  </div>
{/if}
