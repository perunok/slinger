<script lang="ts">
  import { untrack } from 'svelte'
  import Dialog from '../../components/ui/Dialog.svelte'
  import Button from '../../components/ui/Button.svelte'
  import InlineError from '../../components/ui/InlineError.svelte'
  import { ui } from '../../app/ui.svelte'
  import { cloud } from './cloudStore.svelte'
  import DeviceSignIn from './DeviceSignIn.svelte'
  import WorkspaceLinkPanel from './WorkspaceLinkPanel.svelte'

  // Restore the session from the keychain each time the dialog opens.
  $effect(() => {
    if (ui.cloudOpen) untrack(() => void cloud.init())
  })
</script>

{#if ui.cloudOpen}
  <Dialog title="Cloud" size="md" busy={cloud.busy} onclose={() => (ui.cloudOpen = false)}>
    <div class="space-y-4">
      <section class="space-y-2">
        <label class="block text-xs text-muted" for="cloud-url">API base URL</label>
        <input id="cloud-url" type="text" class="field" spellcheck="false" bind:value={cloud.config.apiBaseUrl} disabled={cloud.status === 'signedIn'} />
        <label class="block text-xs text-muted" for="cloud-device">Device name</label>
        <input id="cloud-device" type="text" class="field" bind:value={cloud.config.deviceName} disabled={cloud.status === 'signedIn'} />
      </section>

      {#if cloud.status === 'unknown'}
        <p class="text-sm text-muted" role="status">Checking session…</p>
      {:else if cloud.status === 'signedOut'}
        <DeviceSignIn />
      {:else}
        <div class="flex items-center justify-between gap-2 rounded border border-border bg-raised px-3 py-2">
          <p class="min-w-0 truncate text-sm">Signed in as <span class="font-medium">{cloud.user?.display_name || cloud.user?.email}</span>
            {#if cloud.user?.display_name}<span class="text-xs text-muted">({cloud.user.email})</span>{/if}</p>
          <Button size="sm" loading={cloud.busy} onclick={() => cloud.signOut()}>Sign out</Button>
        </div>
        <WorkspaceLinkPanel />
      {/if}
      <InlineError message={cloud.error} />
    </div>
  </Dialog>
{/if}
