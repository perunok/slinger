<script lang="ts">
  /** Right panel > Code: the snippet generator of the request's Code section, for the active tab. */
  import CodePanel from '../../requests/CodePanel.svelte'
  import type { RequestTab } from '../../requests/tabs.svelte'
  import PanelEmpty from './PanelEmpty.svelte'

  let { tab }: { tab: RequestTab | null } = $props()
</script>

<div class="h-full min-h-0" data-testid="panel-code">
  {#if tab}
    {#key tab.id}<CodePanel {tab} idPrefix="rp-snippet" />{/key}
  {:else}
    <PanelEmpty><p>Open a request to generate a code snippet for it.</p></PanelEmpty>
  {/if}
</div>
