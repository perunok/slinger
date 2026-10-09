<script lang="ts">
  /** Full-width strip under the top bar when someone added you to a cloud workspace that is not on this device yet. */
  import { ui } from '../../app/ui.svelte'
  import Button from '../../components/ui/Button.svelte'
  import Icon from '../../components/ui/Icon.svelte'
  import { shareNoticeText } from './sharedWorkspaces'
  import { sync } from './syncStore.svelte'

  const shares = $derived(sync.shares)
  const single = $derived(shares.length === 1 ? shares[0]! : null)
</script>

{#if shares.length > 0}
  <div role="status" data-testid="shared-banner" class="flex flex-wrap items-center gap-2 border-b border-accent bg-accent-soft px-3 py-1.5 text-xs">
    <span class="text-accent-text"><Icon name="cloud" size={14} /></span>
    <span class="min-w-0 flex-1">{shareNoticeText(shares)}</span>
    {#if single}
      <Button
        size="sm"
        variant="primary"
        icon="download"
        loading={sync.openingShare === single.id}
        title="Download it into a new workspace on this device and keep it in sync"
        onclick={() => void sync.openShare(single.id)}>Open</Button
      >
    {:else}
      <!-- Several at once: the Cloud dialog lists them, each with its own Link… -->
      <Button size="sm" variant="primary" onclick={() => (ui.cloudOpen = true)}>Show</Button>
    {/if}
    <Button size="sm" variant="ghost" disabled={sync.openingShare !== null} title="You can still open it later from Cloud" onclick={() => sync.dismissShares(shares.map((s) => s.id))}
      >Not now</Button
    >
  </div>
{/if}
