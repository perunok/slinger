<script lang="ts">
  import { untrack } from 'svelte'
  import Dialog from '../../components/ui/Dialog.svelte'
  import { ui } from '../../app/ui.svelte'
  import RemoteList from '../sync/RemoteList.svelte'
  import SyncPanel from '../sync/SyncPanel.svelte'
  import { sync } from '../sync/syncStore.svelte'
  import AccountPanel from './AccountPanel.svelte'

  // Refresh the account and the remote list each time the dialog opens (and after signing in).
  $effect(() => {
    if (!ui.cloudOpen) return
    const signedIn = sync.signedIn
    untrack(() => {
      void sync.refreshSession()
      if (signedIn) void sync.loadRemotes()
    })
  })
</script>

{#if ui.cloudOpen}
  <Dialog title="Cloud" size="md" onclose={() => (ui.cloudOpen = false)}>
    <div class="space-y-5">
      <AccountPanel />
      <SyncPanel />
      {#if sync.signedIn}<RemoteList />{/if}
    </div>
  </Dialog>
{/if}
