<script lang="ts">
  /** Mounted once by App: starts the sync store, loads the status of the open workspace, hosts the flow dialogs. */
  import { onDestroy, onMount } from 'svelte'
  import { app } from '../../app/state.svelte'
  import { ui } from '../../app/ui.svelte'
  import ConflictsDialog from './ConflictsDialog.svelte'
  import LinkDialog from './LinkDialog.svelte'
  import PublishDialog from './PublishDialog.svelte'
  import { sync } from './syncStore.svelte'

  onMount(() => void sync.init())
  onDestroy(() => sync.dispose())

  $effect(() => {
    const id = app.workspaceId
    if (id) void sync.ensureStatus(id)
  })
</script>

{#if ui.conflictsOpen}<ConflictsDialog />{/if}
{#if ui.publishOpen}<PublishDialog />{/if}
{#if ui.linkOpen}<LinkDialog />{/if}
