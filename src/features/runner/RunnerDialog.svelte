<script lang="ts">
  import { ui } from '../../app/ui.svelte'
  import RunnerSession from './RunnerSession.svelte'
</script>

{#if ui.runner}
  {#key ui.runner}
    <RunnerSession collectionId={ui.runner.collectionId} folderId={ui.runner.folderId} onclose={() => (ui.runner = null)} />
  {/key}
{/if}
