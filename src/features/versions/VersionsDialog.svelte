<script lang="ts">
  /** Mount once in the app shell; open with `ui.versionsFor = collectionId`. */
  import { ui } from '../../app/ui.svelte'
  import VersionsPanel from './VersionsPanel.svelte'
</script>

{#if ui.versionsFor}
  {#key ui.versionsFor}
    <VersionsPanel collectionId={ui.versionsFor} onclose={() => (ui.versionsFor = null)} />
  {/key}
{/if}
