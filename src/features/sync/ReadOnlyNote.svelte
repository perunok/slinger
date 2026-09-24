<script lang="ts">
  /** Inline explanation shown in place of disabled edit controls. */
  import Icon from '../../components/ui/Icon.svelte'
  import { sync } from './syncStore.svelte'

  let { class: cls = '' }: { class?: string } = $props()
</script>

{#if sync.blocked}
  <p role="note" data-testid="readonly-note" class="flex items-center gap-1.5 rounded border border-warning bg-warning-soft px-2 py-1 text-xs {cls}">
    <span class="text-warning"><Icon name="lock" size={12} /></span>
    {sync.blockedMessage} Editing is disabled.
  </p>
{/if}
