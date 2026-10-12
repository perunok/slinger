<script lang="ts">
  /**
   * Mounted once in the app shell: subscribes the mock-server store to main's events, pushes edited examples to running
   * servers (debounced), and shows the dialog while `ui.mockServerFor` is set.
   */
  import { onMount } from 'svelte'
  import { app } from '../../app/state.svelte'
  import { ui } from '../../app/ui.svelte'
  import { openExample } from '../examples/actions'
  import MockServerDialog from './MockServerDialog.svelte'
  import { mockServers } from './mockServers.svelte'

  onMount(() => mockServers.init())

  // Live reload: any change to the loaded tree re-checks the running servers of this workspace (unchanged collections
  // are skipped by their source key, so this is cheap).
  let timer: ReturnType<typeof setTimeout> | null = null
  $effect(() => {
    void app.requests
    void app.folders
    void app.collections
    if (mockServers.list.length === 0) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void mockServers.refreshExamples()
    }, 300)
    return () => {
      if (timer) clearTimeout(timer)
    }
  })
</script>

{#if ui.mockServerFor}
  {#key ui.mockServerFor}
    <MockServerDialog
      collectionId={ui.mockServerFor}
      onclose={() => (ui.mockServerFor = null)}
      onopenexample={(requestId, index) => {
        ui.mockServerFor = null
        openExample(requestId, index)
      }}
    />
  {/key}
{/if}
