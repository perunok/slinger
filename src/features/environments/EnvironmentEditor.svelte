<script lang="ts">
  /** Mount once in the app shell: `<EnvironmentEditor />`. Opens when `ui.envEditor.open`. */
  import { ui } from '../../app/ui.svelte'
  import EnvironmentEditorDialog from './EnvironmentEditorDialog.svelte'
</script>

{#if ui.envEditor.open}
  <EnvironmentEditorDialog />
{/if}
