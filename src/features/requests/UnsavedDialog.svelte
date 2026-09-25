<script lang="ts">
  import { ui } from '../../app/ui.svelte'
  import Button from '../../components/ui/Button.svelte'
  import Dialog from '../../components/ui/Dialog.svelte'
  import { tabsStore } from './tabs.svelte'

  const ids = $derived(tabsStore.pendingClose?.ids ?? [])
  const dirty = $derived(ids.map((id) => tabsStore.find(id)).filter((t) => t?.dirty))
  let busy = $state(false)

  function cancel() {
    tabsStore.pendingClose = null
  }
  async function saveAndClose() {
    busy = true
    try {
      for (const t of dirty) {
        if (!t) continue
        if (!t.requestId && !t.overview) {
          // Needs a name/location first: hand over to Save As and stop closing.
          ui.saveAsTabId = t.id
          tabsStore.pendingClose = null
          return
        }
        const ok = await tabsStore.save(t)
        if (!ok) {
          // Conflict/error is shown by the tab itself: bring that tab forward so the user sees it.
          tabsStore.activate(t.id)
          tabsStore.pendingClose = null
          return
        }
      }
      tabsStore.closeNow(ids)
    } finally {
      busy = false
    }
  }
</script>

{#if tabsStore.pendingClose}
  <Dialog title="Unsaved changes" onclose={cancel} size="sm" {busy}>
    <p class="text-sm">
      {dirty.length === 1 ? `“${dirty[0]?.title}” has` : `${dirty.length} tabs have`} unsaved changes. Closing will discard them.
    </p>
    {#if dirty.length > 1}
      <ul class="mt-2 list-disc pl-5 text-sm text-muted">
        {#each dirty as t (t?.id)}<li>{t?.title}</li>{/each}
      </ul>
    {/if}
    {#snippet footer()}
      <Button onclick={cancel} disabled={busy}>Cancel</Button>
      <Button variant="danger" onclick={() => tabsStore.closeNow(ids)} disabled={busy}>Discard changes</Button>
      <Button variant="primary" onclick={saveAndClose} loading={busy} data-autofocus>Save</Button>
    {/snippet}
  </Dialog>
{/if}
