<script lang="ts">
  import { ui } from '../../app/ui.svelte'
  import ScriptsDialog from './ScriptsDialog.svelte'
</script>

{#if ui.scriptsFor}
  {#key ui.scriptsFor}
    <ScriptsDialog target={ui.scriptsFor} onclose={() => (ui.scriptsFor = null)} />
  {/key}
{/if}
